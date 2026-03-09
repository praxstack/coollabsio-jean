import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import { useSessions, useCreateSession } from '@/services/chat'
import {
  useWorktree,
  useProjects,
  useArchiveWorktree,
  useDeleteWorktree,
  useCloseBaseSessionClean,
  useCloseBaseSessionArchive,
} from '@/services/projects'
import {
  useGitStatus,
  gitPush,
  fetchWorktreesStatus,
  triggerImmediateGitPoll,
  performGitPull,
} from '@/services/git-status'
import { useRemotePicker } from '@/hooks/useRemotePicker'
import { isBaseSession } from '@/types/projects'
import { GitStatusBadges } from '@/components/ui/git-status-badges'
const GitDiffModal = lazy(() =>
  import('./GitDiffModal').then(mod => ({ default: mod.GitDiffModal }))
)
import type { DiffRequest } from '@/types/git-diff'
import { toast } from 'sonner'
import { Kbd } from '@/components/ui/kbd'
import {
  computeSessionCardData,
  groupCardsByStatus,
  flattenGroups,
} from './session-card-utils'
import { useCanvasStoreState } from './hooks/useCanvasStoreState'
import { usePlanApproval } from './hooks/usePlanApproval'
import { useClearContextApproval } from './hooks/useClearContextApproval'
import { useWorktreeApproval } from './hooks/useWorktreeApproval'
import { useSessionArchive } from './hooks/useSessionArchive'
import { CanvasGrid } from './CanvasGrid'
import { CloseWorktreeDialog } from './CloseWorktreeDialog'
import { CanvasList } from './CanvasList'
import { usePreferences, usePatchPreferences } from '@/services/preferences'
import {
  Search,
  Loader2,
  MoreHorizontal,
  Settings,
  Plus,
  LayoutGrid,
  List,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useProjectsStore } from '@/store/projects-store'
import { OpenInButton } from '@/components/open-in/OpenInButton'
import { NewIssuesBadge } from '@/components/shared/NewIssuesBadge'
import { OpenPRsBadge } from '@/components/shared/OpenPRsBadge'
import { SecurityAlertsBadge } from '@/components/shared/SecurityAlertsBadge'
import { FailedRunsBadge } from '@/components/shared/FailedRunsBadge'

interface WorktreeCanvasViewProps {
  worktreeId: string
  worktreePath: string
}

export function WorktreeCanvasView({
  worktreeId,
  worktreePath,
}: WorktreeCanvasViewProps) {
  const { data: sessionsData } = useSessions(worktreeId, worktreePath)

  // Project and worktree info for title display
  const { data: worktree } = useWorktree(worktreeId)
  const { data: projects } = useProjects()
  const project = worktree
    ? projects?.find(p => p.id === worktree.project_id)
    : null
  const isBase = worktree ? isBaseSession(worktree) : false

  // Running terminal indicator
  // Git status for header badges
  const { data: gitStatus } = useGitStatus(worktreeId)
  const behindCount =
    gitStatus?.behind_count ?? worktree?.cached_behind_count ?? 0
  const unpushedCount =
    gitStatus?.unpushed_count ?? worktree?.cached_unpushed_count ?? 0
  const uncommittedAdded =
    gitStatus?.uncommitted_added ?? worktree?.cached_uncommitted_added ?? 0
  const uncommittedRemoved =
    gitStatus?.uncommitted_removed ?? worktree?.cached_uncommitted_removed ?? 0
  const branchDiffAdded =
    gitStatus?.branch_diff_added ?? worktree?.cached_branch_diff_added ?? 0
  const branchDiffRemoved =
    gitStatus?.branch_diff_removed ?? worktree?.cached_branch_diff_removed ?? 0
  const diffAdded = isBase ? uncommittedAdded : branchDiffAdded
  const diffRemoved = isBase ? uncommittedRemoved : branchDiffRemoved

  // Git badge interaction state
  const [diffRequest, setDiffRequest] = useState<DiffRequest | null>(null)

  // Sync git diff modal open state to UI store (blocks execute_run keybinding)
  useEffect(() => {
    useUIStore.getState().setGitDiffModalOpen(!!diffRequest)
    return () => useUIStore.getState().setGitDiffModalOpen(false)
  }, [diffRequest])

  const defaultBranch = project?.default_branch ?? 'main'
  const pickRemoteOrRun = useRemotePicker(worktreePath)

  const handlePull = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      await performGitPull({
        worktreeId,
        worktreePath,
        baseBranch: defaultBranch,
        projectId: project?.id,
      })
    },
    [worktreeId, worktreePath, defaultBranch, project?.id]
  )

  const handlePush = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      pickRemoteOrRun(async remote => {
        const toastId = toast.loading('Pushing changes...')
        try {
          const result = await gitPush(worktreePath, worktree?.pr_number, remote)
          triggerImmediateGitPoll()
          if (project) fetchWorktreesStatus(project.id)
          if (result.fellBack) {
            toast.warning('Could not push to PR branch, pushed to new branch instead', { id: toastId })
          } else {
            toast.success('Changes pushed', { id: toastId })
          }
        } catch (error) {
          toast.error(`Push failed: ${error}`, { id: toastId })
        }
      })
    },
    [worktreePath, worktree?.pr_number, project, pickRemoteOrRun]
  )

  const handleDiffClick = useCallback(() => {
    setDiffRequest({
      type: isBase ? 'uncommitted' : 'branch',
      worktreePath,
      baseBranch: defaultBranch,
    })
  }, [isBase, worktreePath, defaultBranch])

  // Selection state (declared early — used by git diff effect below)
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  )

  // CMD+G: Open git diff from canvas (skip when session modal is open — ChatWindow handles it)
  useEffect(() => {
    if (selectedSessionId) return

    const handler = () => {
      setDiffRequest(prev => {
        if (prev) {
          return {
            ...prev,
            type: prev.type === 'uncommitted' ? 'branch' : 'uncommitted',
          }
        }
        return {
          type: isBase ? 'uncommitted' : 'branch',
          worktreePath,
          baseBranch: defaultBranch,
        }
      })
    }
    window.addEventListener('open-git-diff', handler)
    return () => window.removeEventListener('open-git-diff', handler)
  }, [isBase, worktreePath, defaultBranch, selectedSessionId])

  // Preferences for canvas layout
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()
  const canvasLayout = preferences?.canvas_layout ?? 'list'

  // Search state
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  // Track highlighted session to survive card reordering
  const highlightedSessionIdRef = useRef<string | null>(null)

  // Use shared hooks
  const storeState = useCanvasStoreState()
  const { handlePlanApproval, handlePlanApprovalYolo } = usePlanApproval({
    worktreeId,
    worktreePath,
  })
  const { handleClearContextApproval, handleClearContextApprovalBuild } = useClearContextApproval({
    worktreeId,
    worktreePath,
  })
  const { handleWorktreeApproval, handleWorktreeApprovalYolo } = useWorktreeApproval({
    worktreeId,
    worktreePath,
    projectId: project?.id ?? null,
  })
  // Worktree close (CMD+W on canvas)
  const [closeWorktreeDialogOpen, setCloseWorktreeDialogOpen] = useState(false)
  const archiveWorktree = useArchiveWorktree()
  const deleteWorktree = useDeleteWorktree()
  const closeBaseSessionClean = useCloseBaseSessionClean()
  const closeBaseSessionArchive = useCloseBaseSessionArchive()

  const handleCloseWorktree = useCallback(() => {
    if (!worktree || !project) return
    console.log('[CLOSE_WT] handleCloseWorktree called', {
      isBase,
      worktreeId,
      removalBehavior: preferences?.removal_behavior,
    })
    if (isBase) {
      if (preferences?.removal_behavior === 'delete') {
        console.log('[CLOSE_WT] -> closeBaseSessionClean')
        closeBaseSessionClean.mutate({ worktreeId, projectId: project.id })
      } else {
        console.log('[CLOSE_WT] -> closeBaseSessionArchive')
        closeBaseSessionArchive.mutate({ worktreeId, projectId: project.id })
      }
    } else if (preferences?.removal_behavior === 'delete') {
      console.log('[CLOSE_WT] -> deleteWorktree')
      deleteWorktree.mutate({ worktreeId, projectId: project.id })
    } else {
      console.log('[CLOSE_WT] -> archiveWorktree')
      archiveWorktree.mutate({ worktreeId, projectId: project.id })
    }
    setCloseWorktreeDialogOpen(false)
  }, [
    worktree,
    project,
    isBase,
    worktreeId,
    preferences?.removal_behavior,
    archiveWorktree,
    deleteWorktree,
    closeBaseSessionClean,
    closeBaseSessionArchive,
  ])

  const handleCloseWorktreeOrConfirm = useCallback(() => {
    if (preferences?.confirm_session_close === false) {
      handleCloseWorktree()
    } else {
      setCloseWorktreeDialogOpen(true)
    }
  }, [preferences?.confirm_session_close, handleCloseWorktree])

  // Session archive/delete — closing the last session closes the worktree
  const { handleArchiveSession, handleDeleteSession } = useSessionArchive({
    worktreeId,
    worktreePath,
    sessions: sessionsData?.sessions,
    removalBehavior: preferences?.removal_behavior,
    onLastSessionDeleted: handleCloseWorktree,
  })

  // Session creation
  const createSession = useCreateSession()

  // Listen for open-session-modal event (used when creating new session in canvas-only mode)
  useEffect(() => {
    const handleOpenSessionModal = (e: CustomEvent<{ sessionId: string }>) => {
      setSelectedSessionId(e.detail.sessionId)
    }

    window.addEventListener(
      'open-session-modal',
      handleOpenSessionModal as EventListener
    )
    return () =>
      window.removeEventListener(
        'open-session-modal',
        handleOpenSessionModal as EventListener
      )
  }, [])

  // Close modal when this worktree is deleted/archived (e.g. PR merged)
  useEffect(() => {
    const handleCloseModal = (e: CustomEvent<{ worktreeId: string }>) => {
      if (e.detail.worktreeId === worktreeId) {
        setSelectedSessionId(null)
      }
    }
    window.addEventListener('close-worktree-modal', handleCloseModal as EventListener)
    return () =>
      window.removeEventListener('close-worktree-modal', handleCloseModal as EventListener)
  }, [worktreeId])

  // When sessions load for a newly created worktree, auto-open the first session modal
  useEffect(() => {
    if (!sessionsData?.sessions?.length) return

    const autoOpen = useUIStore.getState().consumeAutoOpenSession(worktreeId)
    if (!autoOpen.shouldOpen) return

    const targetSession = autoOpen.sessionId
      ? sessionsData.sessions.find(s => s.id === autoOpen.sessionId)
      : sessionsData.sessions[0]

    // If the requested session isn't in cache yet, re-queue and wait for next refresh.
    if (autoOpen.sessionId && !targetSession) {
      useUIStore
        .getState()
        .markWorktreeForAutoOpenSession(worktreeId, autoOpen.sessionId)
      return
    }

    if (targetSession) {
      setSelectedSessionId(targetSession.id)
    }
  }, [worktreeId, sessionsData?.sessions])

  // Listen for create-new-session event to handle Cmd+T
  useEffect(() => {
    const handleCreateNewSession = () => {
      // Don't create if modal is already open
      if (selectedSessionId) return

      createSession.mutate(
        { worktreeId, worktreePath },
        {
          onSuccess: session => {
            // Update highlighted ref so canvas stays on new session after modal close
            highlightedSessionIdRef.current = session.id
            setSelectedSessionId(session.id)
          },
        }
      )
    }

    window.addEventListener('create-new-session', handleCreateNewSession)
    return () =>
      window.removeEventListener('create-new-session', handleCreateNewSession)
  }, [worktreeId, worktreePath, selectedSessionId, createSession])

  // Compute session card data (must be before effects that depend on it)
  const sessionCards = useMemo(() => {
    const sessions = sessionsData?.sessions ?? []
    const cards = sessions.map(session =>
      computeSessionCardData(session, storeState)
    )

    // Filter by search query
    const filtered = searchQuery.trim()
      ? cards.filter(card =>
          card.session.name?.toLowerCase().includes(searchQuery.toLowerCase())
        )
      : cards

    // Sort: labeled first, grouped by label name, then unlabeled
    const sorted = [...filtered].sort((a, b) => {
      if (a.label && !b.label) return -1
      if (!a.label && b.label) return 1
      if (a.label && b.label) return a.label.name.localeCompare(b.label.name)
      return 0
    })

    // Re-order by status group so flat array matches visual group order
    return flattenGroups(groupCardsByStatus(sorted))
  }, [sessionsData?.sessions, storeState, searchQuery])

  // Track highlighted session when selectedIndex changes (for surviving reorders)
  const handleSelectedIndexChange = useCallback(
    (index: number | null) => {
      setSelectedIndex(index)
      if (index !== null && sessionCards[index]) {
        highlightedSessionIdRef.current = sessionCards[index].session.id
      }
    },
    [sessionCards]
  )

  // Re-sync selectedIndex when sessionCards reorders (status changes, etc.)
  useEffect(() => {
    const highlightedId = selectedSessionId ?? highlightedSessionIdRef.current
    if (!highlightedId) return
    const cardIndex = sessionCards.findIndex(
      card => card.session.id === highlightedId
    )
    if (cardIndex !== -1 && cardIndex !== selectedIndex) {
      setSelectedIndex(cardIndex)
    }
  }, [selectedSessionId, sessionCards, selectedIndex])

  // Auto-select session when canvas opens (visual selection only, no modal)
  // Prefers the persisted active session, falls back to first card
  useEffect(() => {
    if (selectedIndex !== null || selectedSessionId) return
    if (sessionCards.length === 0) return

    // Try to find the persisted active session for this worktree
    const activeId = useChatStore.getState().activeSessionIds[worktreeId]
    let targetIndex = activeId
      ? sessionCards.findIndex(c => c.session.id === activeId)
      : -1
    if (targetIndex === -1) targetIndex = 0

    setSelectedIndex(targetIndex)
    const targetCard = sessionCards[targetIndex]
    if (targetCard) {
      useChatStore
        .getState()
        .setCanvasSelectedSession(worktreeId, targetCard.session.id)
      // Sync projects store so commands (CMD+O, open terminal, etc.) work immediately
      useProjectsStore.getState().selectWorktree(worktreeId)
      useChatStore.getState().registerWorktreePath(worktreeId, worktreePath)
    }
  }, [sessionCards, selectedIndex, selectedSessionId, worktreeId, worktreePath])

  // Keep selectedIndex stable when sessionCards reorders (e.g. status changes during streaming)
  useEffect(() => {
    if (selectedIndex === null) return
    const currentSessionId =
      useChatStore.getState().canvasSelectedSessionIds[worktreeId]
    if (!currentSessionId) return
    const newIndex = sessionCards.findIndex(
      c => c.session.id === currentSessionId
    )
    if (newIndex !== -1 && newIndex !== selectedIndex) {
      setSelectedIndex(newIndex)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionCards, worktreeId]) // intentionally omit selectedIndex to avoid loops

  // Sync selection to store for cancel shortcut - updates when user navigates with arrow keys
  useEffect(() => {
    if (selectedSessionId) {
      useChatStore
        .getState()
        .setCanvasSelectedSession(worktreeId, selectedSessionId)
    }
  }, [selectedSessionId, worktreeId])

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex-1 flex flex-col overflow-auto">
        {/* Header with Search - sticky over content */}
        <div className="sticky top-0 z-10 flex items-center justify-between gap-4 bg-background/60 backdrop-blur-md px-4 py-[10px] border-b border-border/30">
          <div className="flex items-center gap-2 shrink-0">
            <div className="flex items-center gap-1">
              <h2 className="text-lg font-semibold">
                {project?.name && (
                  <button
                    type="button"
                    className="hover:text-foreground/70 transition-colors cursor-pointer"
                    onClick={() => useChatStore.getState().clearActiveWorktree()}
                  >
                    {project.name}
                  </button>
                )}
                {(() => {
                  const displayBranch =
                    gitStatus?.current_branch ?? worktree?.branch
                  return displayBranch ? (
                    <span className="ml-1.5 text-sm font-normal text-muted-foreground">
                      · {displayBranch}
                    </span>
                  ) : null
                })()}
              </h2>
              <GitStatusBadges
                behindCount={behindCount}
                unpushedCount={unpushedCount}
                diffAdded={diffAdded}
                diffRemoved={diffRemoved}
                onPull={handlePull}
                onPush={handlePush}
                onDiffClick={handleDiffClick}
              />
              {project && (
                <>
                  <NewIssuesBadge projectPath={project.path} projectId={project.id} />
                  <OpenPRsBadge projectPath={project.path} projectId={project.id} />
                  <SecurityAlertsBadge projectPath={project.path} projectId={project.id} />
                  <FailedRunsBadge projectPath={project.path} />
                </>
              )}
              {worktree?.project_id && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground"
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem
                      onSelect={() =>
                        window.dispatchEvent(
                          new CustomEvent('create-new-session')
                        )
                      }
                    >
                      <Plus className="h-4 w-4" />
                      New Session
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() =>
                        useProjectsStore
                          .getState()
                          .openProjectSettings(worktree.project_id)
                      }
                    >
                      <Settings className="h-4 w-4" />
                      Project Settings
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </div>

          <div className="flex-1 flex justify-center max-w-md mx-auto">
            <div className="relative w-full">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchInputRef}
                placeholder="Search sessions..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="h-8 pl-9 bg-transparent border-border/30"
              />
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <OpenInButton
              worktreePath={worktreePath}
              branch={gitStatus?.current_branch ?? worktree?.branch}
            />
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              value={canvasLayout}
              onValueChange={value => {
                if (value) {
                  patchPreferences.mutate({
                    canvas_layout: value as 'grid' | 'list',
                  })
                }
              }}
            >
              <ToggleGroupItem value="grid" aria-label="Grid view">
                <LayoutGrid className="h-3.5 w-3.5" />
              </ToggleGroupItem>
              <ToggleGroupItem value="list" aria-label="List view">
                <List className="h-3.5 w-3.5" />
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>

        {/* Canvas View */}
        <div className="flex-1 pb-16 pt-6 px-4">
          {worktree?.status === 'pending' ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin" />
              <span>Setting up worktree...</span>
            </div>
          ) : sessionCards.length === 0 ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              {searchQuery
                ? 'No sessions match your search'
                : (
                  <span className="flex items-center gap-2">
                    Add new session
                    <span className="flex items-center gap-0.5">
                      <Kbd>⌘</Kbd>
                      <Kbd>T</Kbd>
                    </span>
                  </span>
                )}
            </div>
          ) : canvasLayout === 'list' ? (
            <CanvasList
              cards={sessionCards}
              worktreeId={worktreeId}
              worktreePath={worktreePath}
              selectedIndex={selectedIndex}
              onSelectedIndexChange={handleSelectedIndexChange}
              selectedSessionId={selectedSessionId}
              onSelectedSessionIdChange={setSelectedSessionId}
              onArchiveSession={handleArchiveSession}
              onDeleteSession={handleDeleteSession}
              onPlanApproval={handlePlanApproval}
              onPlanApprovalYolo={handlePlanApprovalYolo}
              onClearContextApproval={handleClearContextApproval}
              onClearContextApprovalBuild={handleClearContextApprovalBuild}
              onWorktreeApproval={handleWorktreeApproval}
              onWorktreeApprovalYolo={handleWorktreeApprovalYolo}
              onCloseWorktree={handleCloseWorktreeOrConfirm}
              searchInputRef={searchInputRef}
            />
          ) : (
            <CanvasGrid
              cards={sessionCards}
              worktreeId={worktreeId}
              worktreePath={worktreePath}
              selectedIndex={selectedIndex}
              onSelectedIndexChange={handleSelectedIndexChange}
              selectedSessionId={selectedSessionId}
              onSelectedSessionIdChange={setSelectedSessionId}
              onArchiveSession={handleArchiveSession}
              onDeleteSession={handleDeleteSession}
              onPlanApproval={handlePlanApproval}
              onPlanApprovalYolo={handlePlanApprovalYolo}
              onClearContextApproval={handleClearContextApproval}
              onClearContextApprovalBuild={handleClearContextApprovalBuild}
              onWorktreeApproval={handleWorktreeApproval}
              onWorktreeApprovalYolo={handleWorktreeApprovalYolo}
              onCloseWorktree={handleCloseWorktreeOrConfirm}
              searchInputRef={searchInputRef}
            />
          )}
        </div>
      </div>

      <Suspense fallback={null}>
        <GitDiffModal
          diffRequest={diffRequest}
          onClose={() => setDiffRequest(null)}
          uncommittedStats={{
            added: uncommittedAdded,
            removed: uncommittedRemoved,
          }}
          branchStats={{ added: branchDiffAdded, removed: branchDiffRemoved }}
        />
      </Suspense>

      <CloseWorktreeDialog
        open={closeWorktreeDialogOpen}
        onOpenChange={setCloseWorktreeDialogOpen}
        onConfirm={handleCloseWorktree}
        branchName={gitStatus?.current_branch ?? worktree?.branch}
      />
    </div>
  )
}
