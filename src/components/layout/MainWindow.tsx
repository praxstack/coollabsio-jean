import { useMemo, useCallback, useRef, useEffect, useState, lazy, Suspense } from 'react'
import { TitleBar } from '@/components/titlebar/TitleBar'
import { DevModeBanner } from './DevModeBanner'
import { LeftSideBar } from './LeftSideBar'
import { SidebarWidthProvider } from './SidebarWidthContext'
import { MainWindowContent } from './MainWindowContent'
import { CommandPalette } from '@/components/command-palette/CommandPalette'
import { ProjectSettingsDialog } from '@/components/projects/ProjectSettingsDialog'
import { CommitModal } from '@/components/commit/CommitModal'
import { OnboardingDialog } from '@/components/onboarding/OnboardingDialog'
import { FeatureTourDialog } from '@/components/onboarding/FeatureTourDialog'
import { JeanConfigWizard } from '@/components/onboarding/JeanConfigWizard'
import { CliUpdateModal } from '@/components/layout/CliUpdateModal'
import { UpdateAvailableModal } from '@/components/layout/UpdateAvailableModal'
import { CliLoginModal } from '@/components/preferences/CliLoginModal'
import { OpenInModal } from '@/components/open-in/OpenInModal'
import { RemotePickerModal } from '@/components/magic/RemotePickerModal'
import { UpdatePrDialog } from '@/components/magic/UpdatePrDialog'
import { AddProjectDialog } from '@/components/projects/AddProjectDialog'
import { GitInitModal } from '@/components/projects/GitInitModal'
import { CloneProjectModal } from '@/components/projects/CloneProjectModal'
import { QuitConfirmationDialog } from './QuitConfirmationDialog'
import { CloseWorktreeDialog } from '@/components/chat/CloseWorktreeDialog'
import { BranchConflictDialog } from '@/components/worktree/BranchConflictDialog'
import { TeardownOutputDialog } from '@/components/worktree/TeardownOutputDialog'

// Lazy-loaded heavy modals (code splitting)
const PreferencesDialog = lazy(() =>
  import('@/components/preferences/PreferencesDialog').then(mod => ({
    default: mod.PreferencesDialog,
  }))
)
const NewWorktreeModal = lazy(() =>
  import('@/components/worktree/NewWorktreeModal').then(mod => ({
    default: mod.NewWorktreeModal,
  }))
)
const ArchivedModal = lazy(() =>
  import('@/components/archive/ArchivedModal').then(mod => ({
    default: mod.ArchivedModal,
  }))
)
const ReleaseNotesDialog = lazy(() =>
  import('@/components/magic/ReleaseNotesDialog').then(mod => ({
    default: mod.ReleaseNotesDialog,
  }))
)
const WorkflowRunsModal = lazy(() =>
  import('@/components/shared/WorkflowRunsModal').then(mod => ({
    default: mod.WorkflowRunsModal,
  }))
)
const MagicModal = lazy(() =>
  import('@/components/magic/MagicModal').then(mod => ({
    default: mod.MagicModal,
  }))
)
const GitHubDashboardModal = lazy(() =>
  import('@/components/github-dashboard').then(mod => ({
    default: mod.GitHubDashboardModal,
  }))
)
import { FloatingDock } from '@/components/ui/floating-dock'
import { Toaster } from '@/components/ui/sonner'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import { useMainWindowEventListeners } from '@/hooks/useMainWindowEventListeners'
import { useCloseSessionOrWorktreeKeybinding } from '@/services/chat'
import { useUIStatePersistence } from '@/hooks/useUIStatePersistence'
import { useSessionStatePersistence } from '@/hooks/useSessionStatePersistence'
import { useSessionPrefetch } from '@/hooks/useSessionPrefetch'
import { useRestoreLastArchived } from '@/hooks/useRestoreLastArchived'
import { useArchiveCleanup } from '@/hooks/useArchiveCleanup'
import { usePrWorktreeSweep } from '@/hooks/usePrWorktreeSweep'
import {
  useAppFocusTracking,
  useGitStatusEvents,
  useWorktreePolling,
  type WorktreePollingInfo,
} from '@/services/git-status'
import {
  useWorktree,
  useProjects,
  useCreateWorktreeKeybinding,
  useWorktreeEvents,
} from '@/services/projects'
import { useChatStore } from '@/store/chat-store'
import { isNativeApp } from '@/lib/environment'

// Left sidebar resize constraints (pixels)
const MIN_SIDEBAR_WIDTH = 150
const MAX_SIDEBAR_WIDTH = 500

export function MainWindow() {
  const leftSidebarVisible = useUIStore(state => state.leftSidebarVisible)
  const leftSidebarSize = useUIStore(state => state.leftSidebarSize)
  const setLeftSidebarSize = useUIStore(state => state.setLeftSidebarSize)
  const selectedWorktreeId = useProjectsStore(state => state.selectedWorktreeId)

  // Fetch worktree data for polling initialization
  const { data: worktree } = useWorktree(selectedWorktreeId ?? null)
  const { data: projects } = useProjects()
  const project = worktree
    ? projects?.find(p => p.id === worktree.project_id)
    : null

  const isViewingCanvasTabRaw = useChatStore(state =>
    selectedWorktreeId
      ? (state.viewingCanvasTab[selectedWorktreeId] ?? true)
      : false
  )

  // Compute window title based on selected project/worktree
  const windowTitle = useMemo(() => {
    if (!project || !worktree) return 'Jean'
    const branchSuffix =
      worktree.branch !== worktree.name ? ` (${worktree.branch})` : ''

    return `${project.name} › ${worktree.name}${branchSuffix}`
  }, [project, worktree])

  // Determine if canvas view is active (for hiding title bar)
  const isViewingCanvasTab = isViewingCanvasTabRaw

  // Compute polling info - null if no worktree or data not loaded
  const pollingInfo: WorktreePollingInfo | null = useMemo(() => {
    if (!worktree || !project) return null
    return {
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      baseBranch: project.default_branch ?? 'main',
      prNumber: worktree.pr_number,
      prUrl: worktree.pr_url,
    }
  }, [worktree, project])

  // Initialize polling for active worktree (handles startup & worktree changes)
  useWorktreePolling(pollingInfo)

  // Persist UI state (last opened worktree, expanded projects)
  const { isInitialized } = useUIStatePersistence()

  // Persist session-specific state (answered questions, fixed findings, etc.)
  useSessionStatePersistence()

  // Prefetch sessions for all projects on startup (regardless of sidebar visibility).
  // Wait for UI state initialization first so sidebar rendering isn't starved of IPC bandwidth.
  useSessionPrefetch(isInitialized ? projects : undefined)

  // Ref for the sidebar element to update width directly during drag
  const sidebarRef = useRef<HTMLDivElement>(null)

  // Set up global event listeners (keyboard shortcuts, etc.)
  useMainWindowEventListeners()

  // Handle CMD+W keybinding to close session or worktree (with optional confirmation)
  const [closeConfirmBranch, setCloseConfirmBranch] = useState<
    string | undefined
  >()
  const [closeConfirmMode, setCloseConfirmMode] = useState<'worktree' | 'session'>('worktree')
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false)
  const handleConfirmRequired = useCallback((branchName?: string, mode?: 'worktree' | 'session') => {
    setCloseConfirmBranch(branchName)
    setCloseConfirmMode(mode ?? 'worktree')
    setCloseConfirmOpen(true)
  }, [])
  const { executeClose } = useCloseSessionOrWorktreeKeybinding(
    handleConfirmRequired
  )

  // Handle CMD+SHIFT+T to restore last archived item
  useRestoreLastArchived()

  // Archive modal state (triggered by command palette or sidebar button)
  const [archivedModalOpen, setArchivedModalOpen] = useState(false)
  useEffect(() => {
    const handler = () => setArchivedModalOpen(true)
    window.addEventListener('command:open-archived-modal', handler)
    return () =>
      window.removeEventListener('command:open-archived-modal', handler)
  }, [])


  // Auto-cleanup old archived items on startup
  useArchiveCleanup()

  // Sync all worktrees with open PRs to backend for sweep polling
  usePrWorktreeSweep(projects)

  // Track app focus state for background task manager
  useAppFocusTracking()

  // Listen for git status updates from the background task
  useGitStatusEvents()

  // Listen for background worktree events (creation/deletion) - must be here
  // (not in sidebar) so events are received even when sidebar is closed
  useWorktreeEvents()

  // Handle CMD+N keybinding to create new worktree
  useCreateWorktreeKeybinding()

  // Set browser tab title in web mode (native app sets window title via Tauri)
  useEffect(() => {
    if (!isNativeApp()) {
      document.title = windowTitle
    }
  }, [windowTitle])

  // Handle custom resize for left sidebar (pixel-based)
  // Uses direct DOM manipulation during drag for smooth performance,
  // commits to Zustand only on mouseup
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = leftSidebarSize
      let currentWidth = startWidth

      const handleMouseMove = (moveEvent: MouseEvent) => {
        // Dragging right increases width (sidebar is on left)
        const delta = moveEvent.clientX - startX
        currentWidth = Math.min(
          MAX_SIDEBAR_WIDTH,
          Math.max(MIN_SIDEBAR_WIDTH, startWidth + delta)
        )
        // Update DOM directly for smooth resize (no React re-render)
        if (sidebarRef.current) {
          sidebarRef.current.style.width = `${currentWidth}px`
        }
      }

      const handleMouseUp = () => {
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        // Commit final width to Zustand state
        setLeftSidebarSize(currentWidth)
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [leftSidebarSize, setLeftSidebarSize]
  )

  return (
    <div
      className={`flex h-dvh w-full flex-col overflow-hidden bg-background ${isNativeApp() ? 'rounded-xl' : ''}`}
    >
      {/* Dev Mode Banner */}
      <DevModeBanner />

      {/* Title Bar */}
      <TitleBar title={windowTitle} hideTitle={isViewingCanvasTab} />

      {/* Main Content Area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Sidebar with pixel-based width - only render after UI state is initialized */}
        {leftSidebarVisible && isInitialized && (
          <SidebarWidthProvider value={leftSidebarSize}>
            <div
              ref={sidebarRef}
              className="h-full overflow-hidden"
              style={{ width: leftSidebarSize }}
            >
              <LeftSideBar />
            </div>
          </SidebarWidthProvider>
        )}

        {/* Custom resize handle for left sidebar */}
        {leftSidebarVisible && isInitialized && (
          <div
            className="relative h-full w-px hover:bg-border"
            onMouseDown={handleResizeStart}
          >
            {/* Invisible wider hit area for easier clicking */}
            <div className="absolute inset-y-0 -left-1.5 -right-1.5 cursor-col-resize" />
          </div>
        )}

        {/* Main Content - flex-1 to fill remaining space */}
        <div className="relative min-w-0 flex-1 overflow-hidden">
          <MainWindowContent />
          <FloatingDock />
        </div>
      </div>

      {/* Global UI Components (hidden until triggered) */}
      <CommandPalette />
      <Suspense fallback={null}>
        <PreferencesDialog />
      </Suspense>
      <ProjectSettingsDialog />
      <CommitModal />
      <OnboardingDialog />
      <FeatureTourDialog />
      <JeanConfigWizard />
      <CliUpdateModal />
      <UpdateAvailableModal />
      <CliLoginModal />
      <OpenInModal />
      <Suspense fallback={null}>
        <WorkflowRunsModal />
      </Suspense>
      <Suspense fallback={null}>
        <MagicModal />
      </Suspense>
      <RemotePickerModal />
      <Suspense fallback={null}>
        <ReleaseNotesDialog />
      </Suspense>
      <UpdatePrDialog />
      <Suspense fallback={null}>
        <NewWorktreeModal />
      </Suspense>
      <AddProjectDialog />
      <GitInitModal />
      <CloneProjectModal />
      <Suspense fallback={null}>
        <ArchivedModal
          open={archivedModalOpen}
          onOpenChange={setArchivedModalOpen}
        />
      </Suspense>
      <CloseWorktreeDialog
        open={closeConfirmOpen}
        onOpenChange={setCloseConfirmOpen}
        onConfirm={executeClose}
        branchName={closeConfirmBranch}
        mode={closeConfirmMode}
      />
      <QuitConfirmationDialog />
      <Suspense fallback={null}>
        <GitHubDashboardModal />
      </Suspense>
      <BranchConflictDialog />
      <TeardownOutputDialog />
      <Toaster
        position="bottom-right"
        offset="52px"
        expand={true}
        toastOptions={{
          classNames: {
            toast:
              'group toast group-[.toaster]:bg-sidebar group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
            description: 'group-[.toast]:text-muted-foreground',
            actionButton:
              'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
            cancelButton:
              'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
          },
        }}
      />
    </div>
  )
}

export default MainWindow
