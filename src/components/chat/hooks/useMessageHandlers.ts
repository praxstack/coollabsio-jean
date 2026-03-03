import { useCallback, type RefObject } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@/lib/transport'
import { isTauri } from '@/services/projects'
import {
  chatQueryKeys,
  markPlanApproved as markPlanApprovedService,
  readPlanFile,
} from '@/services/chat'
import { useChatStore } from '@/store/chat-store'
import type {
  ChatMessage,
  EffortLevel,
  ExecutionMode,
  Question,
  QuestionAnswer,
  Session,
  ThinkingLevel,
  WorktreeSessions,
} from '@/types/chat'
import type { ReviewFinding } from '@/types/chat'
import { formatAnswersAsNaturalLanguage } from '@/services/chat'
import { parseReviewFindings, getFindingKey } from '../review-finding-utils'
import { findPlanContent, findPlanFilePath } from '../tool-call-utils'
import { generateId } from '@/lib/uuid'
import { preferencesQueryKeys } from '@/services/preferences'
import type { AppPreferences } from '@/types/preferences'

/** Git commands to auto-approve for magic prompts (no permission prompts needed) */
export const GIT_ALLOWED_TOOLS = [
  'Bash(git:*)', // All git commands
  // gh-cli/claude-cli are auto-allowed via --allowedTools in build_claude_args()
]

/** Type for the sendMessage mutation */
interface SendMessageMutation {
  mutate: (
    params: {
      sessionId: string
      worktreeId: string
      worktreePath: string
      message: string
      model?: string
      executionMode?: ExecutionMode
      thinkingLevel?: ThinkingLevel
      effortLevel?: string
      allowedTools?: string[]
      mcpConfig?: string
      customProfileName?: string
    },
    options?: {
      onSettled?: () => void
    }
  ) => void
}

/** Type for the createSession mutation */
interface CreateSessionMutation {
  mutateAsync: (params: {
    worktreeId: string
    worktreePath: string
    name?: string
  }) => Promise<Session>
}

interface UseMessageHandlersParams {
  // Refs for session/worktree IDs (stable across re-renders)
  activeSessionIdRef: RefObject<string | null | undefined>
  activeWorktreeIdRef: RefObject<string | null | undefined>
  activeWorktreePathRef: RefObject<string | null | undefined>
  // Refs for settings (stable across re-renders)
  selectedModelRef: RefObject<string>
  buildModelRef: RefObject<string | null>
  yoloModelRef: RefObject<string | null>
  getCustomProfileName: () => string | undefined
  executionModeRef: RefObject<ExecutionMode>
  selectedThinkingLevelRef: RefObject<ThinkingLevel>
  selectedEffortLevelRef: RefObject<EffortLevel>
  useAdaptiveThinkingRef: RefObject<boolean>
  // MCP config builder (reads current refs internally)
  getMcpConfig: () => string | undefined
  // Actions
  sendMessage: SendMessageMutation
  createSession: CreateSessionMutation
  queryClient: QueryClient
  // Callbacks
  scrollToBottom: (instant?: boolean) => void
  inputRef: RefObject<HTMLTextAreaElement | null>
  // For pending plan approval callback
  pendingPlanMessage: ChatMessage | null | undefined
}

interface MessageHandlers {
  handleQuestionAnswer: (
    toolCallId: string,
    answers: QuestionAnswer[],
    questions: Question[]
  ) => void
  handleSkipQuestion: (toolCallId: string) => void
  handlePlanApproval: (messageId: string, updatedPlan?: string) => void
  handlePlanApprovalYolo: (messageId: string, updatedPlan?: string) => void
  handleStreamingPlanApproval: () => void
  handleStreamingPlanApprovalYolo: () => void
  handleClearContextApproval: (messageId: string) => void
  handleStreamingClearContextApproval: () => void
  handlePendingPlanApprovalCallback: () => void
  handlePermissionApproval: (
    sessionId: string,
    approvedPatterns: string[]
  ) => void
  handlePermissionApprovalYolo: (
    sessionId: string,
    approvedPatterns: string[]
  ) => void
  handlePermissionDeny: (sessionId: string) => void
  handleFixFinding: (
    finding: ReviewFinding,
    customSuggestion?: string
  ) => Promise<void>
  handleFixAllFindings: (
    findingsWithSuggestions: { finding: ReviewFinding; suggestion?: string }[]
  ) => Promise<void>
}

/**
 * Hook that extracts message-related handlers from ChatWindow.
 *
 * PERFORMANCE: Uses refs for session/worktree IDs to keep callbacks stable across session switches.
 */
export function useMessageHandlers({
  activeSessionIdRef,
  activeWorktreeIdRef,
  activeWorktreePathRef,
  selectedModelRef,
  buildModelRef,
  yoloModelRef,
  getCustomProfileName,
  executionModeRef,
  selectedThinkingLevelRef,
  selectedEffortLevelRef,
  useAdaptiveThinkingRef,
  getMcpConfig,
  sendMessage,
  createSession,
  queryClient,
  scrollToBottom,
  inputRef,
  pendingPlanMessage,
}: UseMessageHandlersParams): MessageHandlers {
  'use no memo'

  // Handle answer submission for AskUserQuestion
  // PERFORMANCE: Uses refs for session/worktree IDs to keep callback stable across session switches
  const handleQuestionAnswer = useCallback(
    (toolCallId: string, answers: QuestionAnswer[], questions: Question[]) => {
      const sessionId = activeSessionIdRef.current
      const worktreeId = activeWorktreeIdRef.current
      const worktreePath = activeWorktreePathRef.current
      if (!sessionId || !worktreeId || !worktreePath) return

      // Mark as answered so it becomes read-only (also stores answers for collapsed view)
      const {
        markQuestionAnswered,
        addSendingSession,
        setSelectedModel,
        setExecutingMode,
        setSessionReviewing,
        setWaitingForInput,
        clearToolCalls,
        clearStreamingContentBlocks,
      } = useChatStore.getState()
      markQuestionAnswered(sessionId, toolCallId, answers)

      // Clear the preserved tool calls and review state since we're sending a response
      clearToolCalls(sessionId)
      clearStreamingContentBlocks(sessionId)
      setSessionReviewing(sessionId, false)
      setWaitingForInput(sessionId, false)

      // Persist cleared waiting state to backend (for canvas view where session may not be active)
      invoke('update_session_state', {
        worktreeId,
        worktreePath,
        sessionId,
        waitingForInput: false,
        waitingForInputType: null,
      }).catch(err => {
        console.error(
          '[useMessageHandlers] Failed to clear waiting state:',
          err
        )
      })

      // Scroll to bottom after DOM updates from collapsing the question form.
      // rAF ensures React has processed state changes before we read scrollHeight.
      // Using instant scroll so stale scrollHeight during animation isn't a concern.
      requestAnimationFrame(() => {
        scrollToBottom(true)
      })
      // Safety net: if React committed after our rAF scroll (large content blocks),
      // the scroll position may be past the now-shorter content → empty viewport.
      // Re-scroll after React has definitely flushed.
      setTimeout(() => {
        scrollToBottom(true)
      }, 100)

      // Format answers as natural language
      const message = formatAnswersAsNaturalLanguage(questions, answers)

      // Add to sending state
      addSendingSession(sessionId)
      setSelectedModel(sessionId, selectedModelRef.current)
      setExecutingMode(sessionId, executionModeRef.current)

      // Send the formatted answer
      sendMessage.mutate(
        {
          sessionId,
          worktreeId,
          worktreePath,
          message,
          model: selectedModelRef.current,
          executionMode: executionModeRef.current,
          thinkingLevel: selectedThinkingLevelRef.current,
          effortLevel: useAdaptiveThinkingRef.current
            ? selectedEffortLevelRef.current
            : undefined,
          mcpConfig: getMcpConfig(),
          customProfileName: getCustomProfileName(),
        },
        {
          onSettled: () => {
            inputRef.current?.focus()
          },
        }
      )
    },
    [
      activeSessionIdRef,
      activeWorktreeIdRef,
      activeWorktreePathRef,
      selectedModelRef,
      executionModeRef,
      selectedThinkingLevelRef,
      selectedEffortLevelRef,
      useAdaptiveThinkingRef,
      getMcpConfig,
      getCustomProfileName,
      sendMessage,
      scrollToBottom,
      inputRef,
    ]
  )

  // Handle skipping questions - cancels the question flow without sending anything to Claude
  // Sets session-level skip state to auto-skip all subsequent questions until next user message
  // PERFORMANCE: Uses refs for session/worktree IDs to keep callback stable across session switches
  const handleSkipQuestion = useCallback(
    (toolCallId: string) => {
      const sessionId = activeSessionIdRef.current
      const worktreeId = activeWorktreeIdRef.current
      const worktreePath = activeWorktreePathRef.current
      if (!sessionId || !worktreeId || !worktreePath) return

      const {
        markQuestionAnswered,
        setQuestionsSkipped,
        clearToolCalls,
        clearStreamingContentBlocks,
        removeSendingSession,
        setWaitingForInput,
        setSessionReviewing,
      } = useChatStore.getState()

      // Mark this question as answered (empty answers = skipped)
      markQuestionAnswered(sessionId, toolCallId, [])

      // Set session-level skip state to auto-skip all subsequent questions
      // No message is sent to Claude - the flow is simply cancelled
      setQuestionsSkipped(sessionId, true)

      // Clear the preserved tool calls and sending state since we're done with this interaction
      clearToolCalls(sessionId)
      clearStreamingContentBlocks(sessionId)
      removeSendingSession(sessionId)

      // Clear waiting state and mark as reviewing since interaction is complete
      setWaitingForInput(sessionId, false)
      setSessionReviewing(sessionId, true)

      // Persist cleared waiting state to backend (for canvas view where session may not be active)
      invoke('update_session_state', {
        worktreeId,
        worktreePath,
        sessionId,
        waitingForInput: false,
        waitingForInputType: null,
      }).catch(err => {
        console.error(
          '[useMessageHandlers] Failed to clear waiting state:',
          err
        )
      })

      // Focus input so user can type their next message
      inputRef.current?.focus()
    },
    [activeSessionIdRef, activeWorktreeIdRef, activeWorktreePathRef, inputRef]
  )

  // Handle plan approval for ExitPlanMode
  // PERFORMANCE: Uses refs for session/worktree IDs to keep callback stable across session switches
  const handlePlanApproval = useCallback(
    (messageId: string, updatedPlan?: string) => {
      const sessionId = activeSessionIdRef.current
      const worktreeId = activeWorktreeIdRef.current
      const worktreePath = activeWorktreePathRef.current
      if (!sessionId || !worktreeId || !worktreePath) return

      // Mark plan as approved in the message (persisted to disk)
      markPlanApprovedService(worktreeId, worktreePath, sessionId, messageId)

      // Optimistically update the UI to hide the approve button
      queryClient.setQueryData<Session>(
        chatQueryKeys.session(sessionId),
        old => {
          if (!old) return old
          return {
            ...old,
            approved_plan_message_ids: [
              ...(old.approved_plan_message_ids ?? []),
              messageId,
            ],
            messages: old.messages.map(msg =>
              msg.id === messageId ? { ...msg, plan_approved: true } : msg
            ),
          }
        }
      )

      // Invalidate sessions list so canvas cards update
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(worktreeId),
      })

      // Explicitly set to build mode (not toggle, to avoid switching back to plan if already in build)
      const {
        setExecutionMode: setMode,
        addSendingSession,
        setSelectedModel,
        setLastSentMessage,
        setError,
        setExecutingMode,
        setSessionReviewing,
        setWaitingForInput,
        clearToolCalls,
        clearStreamingContentBlocks,
      } = useChatStore.getState()
      setMode(sessionId, 'build')

      // Clear the preserved tool calls and review state since we're sending a response
      clearToolCalls(sessionId)
      clearStreamingContentBlocks(sessionId)
      setSessionReviewing(sessionId, false)
      setWaitingForInput(sessionId, false)

      // Scroll to bottom after DOM updates from collapsing the plan approval UI
      requestAnimationFrame(() => {
        scrollToBottom(true)
      })
      // Safety net: if React committed after our rAF scroll (large content blocks),
      // the scroll position may be past the now-shorter content → empty viewport.
      setTimeout(() => {
        scrollToBottom(true)
      }, 100)

      // Format approval message - include updated plan if provided
      // For Codex: use explicit execution instruction since it resumes a thread
      const isCodex =
        useChatStore.getState().selectedBackends[sessionId] === 'codex'
      const message = updatedPlan
        ? `I've updated the plan. Please review and execute:\n\n<updated-plan>\n${updatedPlan}\n</updated-plan>`
        : isCodex
          ? 'Execute the plan you created. Implement all changes described.'
          : 'Plan approved. Begin implementing the changes now. Do not re-explain the plan — start writing code.'
      // Send approval message so the backend continues with execution
      // NOTE: setLastSentMessage is critical for permission denial flow - without it,
      // the denied message context won't be set and approval UI won't work
      const buildModel = buildModelRef.current ?? selectedModelRef.current
      if (buildModelRef.current && buildModelRef.current !== selectedModelRef.current) {
        toast.info(`Using ${buildModelRef.current} model for build`)
      }
      setLastSentMessage(sessionId, message)
      setError(sessionId, null)
      addSendingSession(sessionId)
      setSelectedModel(sessionId, buildModel)
      setExecutingMode(sessionId, 'build')

      sendMessage.mutate(
        {
          sessionId,
          worktreeId,
          worktreePath,
          message,
          model: buildModel,
          executionMode: 'build',
          thinkingLevel: selectedThinkingLevelRef.current,
          effortLevel: useAdaptiveThinkingRef.current
            ? selectedEffortLevelRef.current
            : undefined,
          mcpConfig: getMcpConfig(),
          customProfileName: getCustomProfileName(),
        },
        {
          onSettled: () => {
            inputRef.current?.focus()
          },
        }
      )
    },
    [
      activeSessionIdRef,
      activeWorktreeIdRef,
      activeWorktreePathRef,
      selectedModelRef,
      buildModelRef,
      selectedThinkingLevelRef,
      selectedEffortLevelRef,
      useAdaptiveThinkingRef,
      getMcpConfig,
      getCustomProfileName,
      scrollToBottom,
      sendMessage,
      queryClient,
      inputRef,
    ]
  )

  // Handle plan approval with yolo mode (auto-approve all future tools)
  // PERFORMANCE: Uses refs for session/worktree IDs to keep callback stable across session switches
  const handlePlanApprovalYolo = useCallback(
    (messageId: string, updatedPlan?: string) => {
      const sessionId = activeSessionIdRef.current
      const worktreeId = activeWorktreeIdRef.current
      const worktreePath = activeWorktreePathRef.current
      if (!sessionId || !worktreeId || !worktreePath) return

      // Mark plan as approved in the message (persisted to disk)
      markPlanApprovedService(worktreeId, worktreePath, sessionId, messageId)

      // Optimistically update the UI to hide the approve button
      queryClient.setQueryData<Session>(
        chatQueryKeys.session(sessionId),
        old => {
          if (!old) return old
          return {
            ...old,
            approved_plan_message_ids: [
              ...(old.approved_plan_message_ids ?? []),
              messageId,
            ],
            messages: old.messages.map(msg =>
              msg.id === messageId ? { ...msg, plan_approved: true } : msg
            ),
          }
        }
      )

      // Invalidate sessions list so canvas cards update
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(worktreeId),
      })

      // Set to yolo mode for auto-approval of all future tools
      const {
        setExecutionMode: setMode,
        addSendingSession,
        setSelectedModel,
        setLastSentMessage,
        setError,
        setExecutingMode,
        setSessionReviewing,
        setWaitingForInput,
        clearToolCalls,
        clearStreamingContentBlocks,
      } = useChatStore.getState()
      setMode(sessionId, 'yolo')

      // Clear the preserved tool calls and review state since we're sending a response
      clearToolCalls(sessionId)
      clearStreamingContentBlocks(sessionId)
      setSessionReviewing(sessionId, false)
      setWaitingForInput(sessionId, false)

      // Scroll to bottom after DOM updates from collapsing the plan approval UI
      requestAnimationFrame(() => {
        scrollToBottom(true)
      })
      // Safety net: if React committed after our rAF scroll (large content blocks),
      // the scroll position may be past the now-shorter content → empty viewport.
      setTimeout(() => {
        scrollToBottom(true)
      }, 100)

      // Format approval message - include updated plan if provided
      const isCodexYolo =
        useChatStore.getState().selectedBackends[sessionId] === 'codex'
      const message = updatedPlan
        ? `I've updated the plan. Please review and execute:\n\n<updated-plan>\n${updatedPlan}\n</updated-plan>`
        : isCodexYolo
          ? 'Execute the plan you created. Implement all changes described.'
          : 'Plan approved (yolo mode). Begin implementing all changes immediately without asking for confirmation. Do not re-explain the plan — start writing code.'
      // Send approval message so the backend continues with execution
      const yoloModel = yoloModelRef.current ?? selectedModelRef.current
      if (yoloModelRef.current && yoloModelRef.current !== selectedModelRef.current) {
        toast.info(`Using ${yoloModelRef.current} model for yolo`)
      }
      setLastSentMessage(sessionId, message)
      setError(sessionId, null)
      addSendingSession(sessionId)
      setSelectedModel(sessionId, yoloModel)
      setExecutingMode(sessionId, 'yolo')

      sendMessage.mutate(
        {
          sessionId,
          worktreeId,
          worktreePath,
          message,
          model: yoloModel,
          executionMode: 'yolo',
          thinkingLevel: selectedThinkingLevelRef.current,
          effortLevel: useAdaptiveThinkingRef.current
            ? selectedEffortLevelRef.current
            : undefined,
          mcpConfig: getMcpConfig(),
          customProfileName: getCustomProfileName(),
        },
        {
          onSettled: () => {
            inputRef.current?.focus()
          },
        }
      )
    },
    [
      activeSessionIdRef,
      activeWorktreeIdRef,
      activeWorktreePathRef,
      selectedModelRef,
      yoloModelRef,
      selectedThinkingLevelRef,
      selectedEffortLevelRef,
      useAdaptiveThinkingRef,
      getMcpConfig,
      getCustomProfileName,
      scrollToBottom,
      sendMessage,
      queryClient,
      inputRef,
    ]
  )

  // Callback for floating button pending plan approval
  const handlePendingPlanApprovalCallback = useCallback(() => {
    if (pendingPlanMessage) {
      handlePlanApproval(pendingPlanMessage.id)
    }
  }, [pendingPlanMessage, handlePlanApproval])

  // Handle plan approval during streaming (when message isn't persisted yet)
  // PERFORMANCE: Uses refs for session/worktree IDs to keep callback stable across session switches
  const handleStreamingPlanApproval = useCallback(() => {
    const sessionId = activeSessionIdRef.current
    const worktreeId = activeWorktreeIdRef.current
    const worktreePath = activeWorktreePathRef.current
    if (!sessionId || !worktreeId || !worktreePath) return

    // Mark as approved in streaming state (prevents double-approval)
    const {
      setStreamingPlanApproved,
      setExecutionMode: setMode,
      setSelectedModel,
      setLastSentMessage,
      setError,
      addSendingSession,
      setExecutingMode,
      setSessionReviewing,
      setWaitingForInput,
      clearToolCalls,
      clearStreamingContentBlocks,
    } = useChatStore.getState()
    setStreamingPlanApproved(sessionId, true)

    // Clear the preserved tool calls and review state since we're sending a response
    clearToolCalls(sessionId)
    clearStreamingContentBlocks(sessionId)
    setSessionReviewing(sessionId, false)
    setWaitingForInput(sessionId, false)

    // Scroll to bottom after DOM updates from collapsing the plan approval UI
    requestAnimationFrame(() => {
      scrollToBottom(true)
    })

    // Explicitly set to build mode (not toggle, to avoid switching back to plan if already in build)
    const buildModel = buildModelRef.current ?? selectedModelRef.current
    if (buildModelRef.current && buildModelRef.current !== selectedModelRef.current) {
      toast.info(`Using ${buildModelRef.current} model for build`)
    }
    setMode(sessionId, 'build')
    setSelectedModel(sessionId, buildModel)

    // Send approval message to Claude so it continues with execution
    // NOTE: setLastSentMessage is critical for permission denial flow - without it,
    // the denied message context won't be set and approval UI won't work
    const buildApprovalMsg = 'Plan approved. Begin implementing the changes now. Do not re-explain the plan — start writing code.'
    setLastSentMessage(sessionId, buildApprovalMsg)
    setError(sessionId, null)
    addSendingSession(sessionId)
    setExecutingMode(sessionId, 'build')

    sendMessage.mutate(
      {
        sessionId,
        worktreeId,
        worktreePath,
        message: buildApprovalMsg,
        model: buildModel,
        executionMode: 'build',
        thinkingLevel: selectedThinkingLevelRef.current,
        effortLevel: useAdaptiveThinkingRef.current
          ? selectedEffortLevelRef.current
          : undefined,
        mcpConfig: getMcpConfig(),
        customProfileName: getCustomProfileName(),
      },
      {
        onSettled: () => {
          inputRef.current?.focus()
        },
      }
    )
  }, [
    activeSessionIdRef,
    activeWorktreeIdRef,
    activeWorktreePathRef,
    selectedModelRef,
    buildModelRef,
    selectedThinkingLevelRef,
    selectedEffortLevelRef,
    useAdaptiveThinkingRef,
    getMcpConfig,
    getCustomProfileName,
    scrollToBottom,
    sendMessage,
    inputRef,
  ])

  // Handle plan approval during streaming with yolo mode (auto-approve all future tools)
  // PERFORMANCE: Uses refs for session/worktree IDs to keep callback stable across session switches
  const handleStreamingPlanApprovalYolo = useCallback(() => {
    const sessionId = activeSessionIdRef.current
    const worktreeId = activeWorktreeIdRef.current
    const worktreePath = activeWorktreePathRef.current
    if (!sessionId || !worktreeId || !worktreePath) return

    // Mark as approved in streaming state (prevents double-approval)
    const {
      setStreamingPlanApproved,
      setExecutionMode: setMode,
      setSelectedModel,
      setLastSentMessage,
      setError,
      addSendingSession,
      setExecutingMode,
      setSessionReviewing,
      setWaitingForInput,
      clearToolCalls,
      clearStreamingContentBlocks,
    } = useChatStore.getState()
    setStreamingPlanApproved(sessionId, true)

    // Clear the preserved tool calls and review state since we're sending a response
    clearToolCalls(sessionId)
    clearStreamingContentBlocks(sessionId)
    setSessionReviewing(sessionId, false)
    setWaitingForInput(sessionId, false)

    // Scroll to bottom after DOM updates from collapsing the plan approval UI
    requestAnimationFrame(() => {
      scrollToBottom(true)
    })

    // Set to yolo mode for auto-approval of all future tools
    const yoloModel = yoloModelRef.current ?? selectedModelRef.current
    if (yoloModelRef.current && yoloModelRef.current !== selectedModelRef.current) {
      toast.info(`Using ${yoloModelRef.current} model for yolo`)
    }
    setMode(sessionId, 'yolo')
    setSelectedModel(sessionId, yoloModel)

    // Send approval message to Claude so it continues with execution
    const yoloApprovalMsg = 'Plan approved (yolo mode). Begin implementing all changes immediately without asking for confirmation. Do not re-explain the plan — start writing code.'
    setLastSentMessage(sessionId, yoloApprovalMsg)
    setError(sessionId, null)
    addSendingSession(sessionId)
    setExecutingMode(sessionId, 'yolo')

    sendMessage.mutate(
      {
        sessionId,
        worktreeId,
        worktreePath,
        message: yoloApprovalMsg,
        model: yoloModel,
        executionMode: 'yolo',
        thinkingLevel: selectedThinkingLevelRef.current,
        effortLevel: useAdaptiveThinkingRef.current
          ? selectedEffortLevelRef.current
          : undefined,
        mcpConfig: getMcpConfig(),
        customProfileName: getCustomProfileName(),
      },
      {
        onSettled: () => {
          inputRef.current?.focus()
        },
      }
    )
  }, [
    activeSessionIdRef,
    activeWorktreeIdRef,
    activeWorktreePathRef,
    selectedModelRef,
    yoloModelRef,
    selectedThinkingLevelRef,
    selectedEffortLevelRef,
    useAdaptiveThinkingRef,
    getMcpConfig,
    getCustomProfileName,
    scrollToBottom,
    sendMessage,
    inputRef,
  ])

  // Handle clear context approval for persisted messages
  // Resolves plan content from message tool calls, marks approved, creates new session, sends plan
  const handleClearContextApproval = useCallback(
    async (messageId: string) => {
      const sessionId = activeSessionIdRef.current
      const worktreeId = activeWorktreeIdRef.current
      const worktreePath = activeWorktreePathRef.current
      if (!sessionId || !worktreeId || !worktreePath) return

      // Get the message to extract plan content
      const sessionData = queryClient.getQueryData<Session>(
        chatQueryKeys.session(sessionId)
      )
      const message = sessionData?.messages.find(m => m.id === messageId)
      if (!message?.tool_calls) {
        toast.error('No plan content available')
        return
      }

      // Resolve plan content from tool calls
      let planContent = findPlanContent(message.tool_calls)
      if (!planContent) {
        const planFilePath = findPlanFilePath(message.tool_calls)
        if (planFilePath) {
          try {
            planContent = await readPlanFile(planFilePath)
          } catch (err) {
            toast.error(`Failed to read plan file: ${err}`)
            return
          }
        }
      }
      if (!planContent) {
        toast.error('No plan content available')
        return
      }

      // Mark plan approved on original session
      markPlanApprovedService(worktreeId, worktreePath, sessionId, messageId)
      queryClient.setQueryData<Session>(
        chatQueryKeys.session(sessionId),
        old => {
          if (!old) return old
          return {
            ...old,
            approved_plan_message_ids: [
              ...(old.approved_plan_message_ids ?? []),
              messageId,
            ],
            messages: old.messages.map(msg =>
              msg.id === messageId ? { ...msg, plan_approved: true } : msg
            ),
          }
        }
      )
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.sessions(worktreeId),
      })

      const store = useChatStore.getState()
      store.clearToolCalls(sessionId)
      store.clearStreamingContentBlocks(sessionId)
      store.setSessionReviewing(sessionId, false)
      store.setWaitingForInput(sessionId, false)

      // Create new session
      let newSession: Session
      try {
        newSession = await createSession.mutateAsync({
          worktreeId,
          worktreePath,
        })
      } catch (err) {
        toast.error(`Failed to create session: ${err}`)
        return
      }

      // Switch to new session
      store.setActiveSession(worktreeId, newSession.id)

      // Send plan as first message in YOLO mode
      const yoloModel = yoloModelRef.current ?? selectedModelRef.current
      if (yoloModelRef.current && yoloModelRef.current !== selectedModelRef.current) {
        toast.info(`Using ${yoloModelRef.current} model for yolo`)
      }
      const planMessage = `Execute this plan. Implement all changes described.\n\n<plan>\n${planContent}\n</plan>`
      store.setExecutionMode(newSession.id, 'yolo')
      store.setLastSentMessage(newSession.id, planMessage)
      store.setError(newSession.id, null)
      store.addSendingSession(newSession.id)
      store.setSelectedModel(newSession.id, yoloModel)
      store.setExecutingMode(newSession.id, 'yolo')

      sendMessage.mutate({
        sessionId: newSession.id,
        worktreeId,
        worktreePath,
        message: planMessage,
        model: yoloModel,
        executionMode: 'yolo',
        thinkingLevel: selectedThinkingLevelRef.current,
        effortLevel: useAdaptiveThinkingRef.current
          ? selectedEffortLevelRef.current
          : undefined,
        mcpConfig: getMcpConfig(),
        customProfileName: getCustomProfileName(),
      })

      // Optionally close the original session — but only after the new session's
      // send_chat_message has started (chat:sending event). This avoids a race where
      // close_session runs concurrently with send_chat_message and interferes with
      // the new session's startup. Falls back to a 10s timeout as a safety net.
      const prefs = queryClient.getQueryData<AppPreferences>(
        preferencesQueryKeys.preferences()
      )
      if (prefs?.close_original_on_clear_context) {
        const command =
          prefs.removal_behavior === 'archive'
            ? 'archive_session'
            : 'close_session'

        const doClose = () => {
          invoke(command, { worktreeId, worktreePath, sessionId }).catch(err => {
            console.error(
              '[useMessageHandlers] Failed to close original session:',
              err
            )
          })
        }

        if (isTauri()) {
          const newSessionId = newSession.id
          let closed = false
          const timeout = setTimeout(() => {
            if (!closed) {
              closed = true
              doClose()
            }
          }, 10000)

          listen<{ session_id: string }>('chat:sending', event => {
            if (event.payload.session_id === newSessionId && !closed) {
              closed = true
              clearTimeout(timeout)
              doClose()
            }
          }).catch(() => {
            if (!closed) {
              closed = true
              clearTimeout(timeout)
              doClose()
            }
          })
        } else {
          doClose()
        }
      }
    },
    [
      activeSessionIdRef,
      activeWorktreeIdRef,
      activeWorktreePathRef,
      selectedModelRef,
      yoloModelRef,
      selectedThinkingLevelRef,
      selectedEffortLevelRef,
      useAdaptiveThinkingRef,
      getMcpConfig,
      getCustomProfileName,
      createSession,
      sendMessage,
      queryClient,
    ]
  )

  // Handle clear context approval during streaming
  const handleStreamingClearContextApproval = useCallback(async () => {
    const sessionId = activeSessionIdRef.current
    const worktreeId = activeWorktreeIdRef.current
    const worktreePath = activeWorktreePathRef.current
    if (!sessionId || !worktreeId || !worktreePath) return

    // Get streaming content blocks to extract plan content
    const store = useChatStore.getState()
    const contentBlocks = store.streamingContentBlocks[sessionId]
    const toolCalls = store.activeToolCalls[sessionId]

    // Try to get plan content from tool calls first, then from streaming blocks
    let planContent: string | null = null
    if (toolCalls) {
      planContent = findPlanContent(toolCalls)
      if (!planContent) {
        const planFilePath = findPlanFilePath(toolCalls)
        if (planFilePath) {
          try {
            planContent = await readPlanFile(planFilePath)
          } catch {
            // Fall through to content blocks
          }
        }
      }
    }

    if (!planContent && contentBlocks) {
      // Try to extract from streaming content blocks (text content)
      for (const block of contentBlocks) {
        if ('text' in block && block.text) {
          planContent = block.text
          break
        }
      }
    }

    if (!planContent) {
      toast.error('No plan content available')
      return
    }

    // Mark as approved in streaming state
    store.setStreamingPlanApproved(sessionId, true)
    store.clearToolCalls(sessionId)
    store.clearStreamingContentBlocks(sessionId)
    store.setSessionReviewing(sessionId, false)
    store.setWaitingForInput(sessionId, false)

    // Create new session
    let newSession: Session
    try {
      newSession = await createSession.mutateAsync({
        worktreeId,
        worktreePath,
      })
    } catch (err) {
      toast.error(`Failed to create session: ${err}`)
      return
    }

    // Switch to new session
    store.setActiveSession(worktreeId, newSession.id)

    // Send plan as first message in YOLO mode
    const yoloModel = yoloModelRef.current ?? selectedModelRef.current
    if (yoloModelRef.current && yoloModelRef.current !== selectedModelRef.current) {
      toast.info(`Using ${yoloModelRef.current} model for yolo`)
    }
    const planMessage = `Execute this plan. Implement all changes described.\n\n<plan>\n${planContent}\n</plan>`
    store.setExecutionMode(newSession.id, 'yolo')
    store.setLastSentMessage(newSession.id, planMessage)
    store.setError(newSession.id, null)
    store.addSendingSession(newSession.id)
    store.setSelectedModel(newSession.id, yoloModel)
    store.setExecutingMode(newSession.id, 'yolo')

    sendMessage.mutate({
      sessionId: newSession.id,
      worktreeId,
      worktreePath,
      message: planMessage,
      model: yoloModel,
      executionMode: 'yolo',
      thinkingLevel: selectedThinkingLevelRef.current,
      effortLevel: useAdaptiveThinkingRef.current
        ? selectedEffortLevelRef.current
        : undefined,
      mcpConfig: getMcpConfig(),
      customProfileName: getCustomProfileName(),
    })

    // Optionally close the original session — but only after the new session's
    // send_chat_message has started (chat:sending event). This avoids a race where
    // close_session runs concurrently with send_chat_message and interferes with
    // the new session's startup. Falls back to a 10s timeout as a safety net.
    const prefs = queryClient.getQueryData<AppPreferences>(
      preferencesQueryKeys.preferences()
    )
    if (prefs?.close_original_on_clear_context) {
      const command =
        prefs.removal_behavior === 'archive'
          ? 'archive_session'
          : 'close_session'

      const doClose = () => {
        invoke(command, { worktreeId, worktreePath, sessionId }).catch(err => {
          console.error(
            '[useMessageHandlers] Failed to close original session:',
            err
          )
        })
      }

      if (isTauri()) {
        const newSessionId = newSession.id
        let closed = false
        const timeout = setTimeout(() => {
          if (!closed) {
            closed = true
            doClose()
          }
        }, 10000)

        listen<{ session_id: string }>('chat:sending', event => {
          if (event.payload.session_id === newSessionId && !closed) {
            closed = true
            clearTimeout(timeout)
            doClose()
          }
        }).catch(() => {
          if (!closed) {
            closed = true
            clearTimeout(timeout)
            doClose()
          }
        })
      } else {
        doClose()
      }
    }
  }, [
    activeSessionIdRef,
    activeWorktreeIdRef,
    activeWorktreePathRef,
    selectedModelRef,
    yoloModelRef,
    selectedThinkingLevelRef,
    selectedEffortLevelRef,
    useAdaptiveThinkingRef,
    getMcpConfig,
    getCustomProfileName,
    createSession,
    sendMessage,
    queryClient,
  ])

  // Handle permission approval (when tools require user approval)
  // PERFORMANCE: Uses refs for session/worktree IDs to keep callback stable across session switches
  const handlePermissionApproval = useCallback(
    (sessionId: string, approvedPatterns: string[]) => {
      const worktreeId = activeWorktreeIdRef.current
      const worktreePath = activeWorktreePathRef.current
      if (!worktreeId || !worktreePath) return

      const {
        addApprovedTool,
        clearPendingDenials,
        getDeniedMessageContext,
        clearDeniedMessageContext,
        getApprovedTools,
        getPendingDenials,
        addSendingSession,
        setLastSentMessage,
        setError,
        setSelectedModel,
        setExecutingMode,
        setExecutionMode,
        setWaitingForInput,
        selectedBackends,
      } = useChatStore.getState()

      const backend = selectedBackends[sessionId] ?? 'claude'

      // Codex path: send approval response via JSON-RPC (process is still running)
      if (backend === 'codex') {
        const denials = getPendingDenials(sessionId)
        clearPendingDenials(sessionId)
        clearDeniedMessageContext(sessionId)
        setWaitingForInput(sessionId, false)
        setExecutionMode(sessionId, 'build')

        requestAnimationFrame(() => {
          scrollToBottom(true)
        })

        // Send accept for each denial that has an rpc_id
        for (const denial of denials) {
          if (denial.rpc_id != null) {
            invoke('approve_codex_command', {
              sessionId,
              rpcId: denial.rpc_id,
              decision: 'accept',
            }).catch(err => {
              console.error(
                '[ChatWindow] Failed to approve Codex command:',
                err
              )
              toast.error(`Failed to approve command: ${err}`)
            })
          }
        }
        return
      }

      // Claude path: re-send message with approved tools
      for (const pattern of approvedPatterns) {
        addApprovedTool(sessionId, pattern)
      }

      const allApprovedTools = getApprovedTools(sessionId)

      const context = getDeniedMessageContext(sessionId)
      if (!context) {
        console.error(
          '[ChatWindow] No denied message context found for re-send'
        )
        clearPendingDenials(sessionId)
        return
      }

      clearPendingDenials(sessionId)
      clearDeniedMessageContext(sessionId)
      setWaitingForInput(sessionId, false)
      setExecutionMode(sessionId, 'build')

      requestAnimationFrame(() => {
        scrollToBottom(true)
      })

      const bashCommands: string[] = []
      const otherPatterns: string[] = []
      for (const pattern of approvedPatterns) {
        const bashMatch = pattern.match(/^Bash\((.+)\)$/)
        if (bashMatch?.[1]) {
          bashCommands.push(bashMatch[1])
        } else {
          otherPatterns.push(pattern)
        }
      }

      let continuationMessage: string
      if (bashCommands.length > 0 && otherPatterns.length === 0) {
        if (bashCommands.length === 1) {
          continuationMessage = `I approved the command. Run it now: \`${bashCommands[0]}\``
        } else {
          continuationMessage = `I approved these commands. Run them now:\n${bashCommands.map(cmd => `- \`${cmd}\``).join('\n')}`
        }
      } else if (bashCommands.length > 0) {
        continuationMessage = `I approved: ${approvedPatterns.join(', ')}. Execute them now.`
      } else {
        continuationMessage = `I approved ${approvedPatterns.join(', ')}. Continue with the task.`
      }

      const modelToUse = context.model ?? selectedModelRef.current
      const modeToUse = context.executionMode ?? executionModeRef.current
      setLastSentMessage(sessionId, continuationMessage)
      setError(sessionId, null)
      addSendingSession(sessionId)
      setSelectedModel(sessionId, modelToUse)
      setExecutingMode(sessionId, modeToUse)

      sendMessage.mutate(
        {
          sessionId,
          worktreeId,
          worktreePath,
          message: continuationMessage,
          model: modelToUse,
          executionMode: modeToUse,
          thinkingLevel:
            context.thinkingLevel ?? selectedThinkingLevelRef.current,
          effortLevel: useAdaptiveThinkingRef.current
            ? selectedEffortLevelRef.current
            : undefined,
          allowedTools: [...GIT_ALLOWED_TOOLS, ...allApprovedTools],
          mcpConfig: getMcpConfig(),
          customProfileName: getCustomProfileName(),
        },
        {
          onSettled: () => {
            inputRef.current?.focus()
          },
        }
      )
    },
    [
      activeWorktreeIdRef,
      activeWorktreePathRef,
      selectedModelRef,
      executionModeRef,
      selectedThinkingLevelRef,
      selectedEffortLevelRef,
      useAdaptiveThinkingRef,
      getMcpConfig,
      getCustomProfileName,
      scrollToBottom,
      sendMessage,
      inputRef,
    ]
  )

  // Handle permission approval with yolo mode (auto-approve all future tools)
  // PERFORMANCE: Uses refs for session/worktree IDs to keep callback stable across session switches
  const handlePermissionApprovalYolo = useCallback(
    (sessionId: string, approvedPatterns: string[]) => {
      const worktreeId = activeWorktreeIdRef.current
      const worktreePath = activeWorktreePathRef.current
      if (!worktreeId || !worktreePath) return

      const {
        addApprovedTool,
        clearPendingDenials,
        getDeniedMessageContext,
        clearDeniedMessageContext,
        getPendingDenials,
        addSendingSession,
        setLastSentMessage,
        setError,
        setSelectedModel,
        setExecutingMode,
        setExecutionMode: setMode,
        setWaitingForInput,
        selectedBackends,
      } = useChatStore.getState()

      const backend = selectedBackends[sessionId] ?? 'claude'

      // Codex path: accept current denial and switch to yolo for future messages
      if (backend === 'codex') {
        const denials = getPendingDenials(sessionId)
        clearPendingDenials(sessionId)
        clearDeniedMessageContext(sessionId)
        setWaitingForInput(sessionId, false)
        setMode(sessionId, 'yolo')

        requestAnimationFrame(() => {
          scrollToBottom(true)
        })

        for (const denial of denials) {
          if (denial.rpc_id != null) {
            invoke('approve_codex_command', {
              sessionId,
              rpcId: denial.rpc_id,
              decision: 'accept',
            }).catch(err => {
              console.error(
                '[ChatWindow] Failed to approve Codex command:',
                err
              )
            })
          }
        }
        return
      }

      // Claude path
      for (const pattern of approvedPatterns) {
        addApprovedTool(sessionId, pattern)
      }

      const context = getDeniedMessageContext(sessionId)
      if (!context) {
        console.error(
          '[ChatWindow] No denied message context found for re-send'
        )
        clearPendingDenials(sessionId)
        return
      }

      clearPendingDenials(sessionId)
      clearDeniedMessageContext(sessionId)
      setWaitingForInput(sessionId, false)

      // Scroll to bottom after DOM updates from collapsing the permission approval UI
      requestAnimationFrame(() => {
        scrollToBottom(true)
      })

      // Build explicit continuation message that tells Claude exactly what to run
      // Extract commands from Bash(command) patterns for a more direct instruction
      const bashCommands: string[] = []
      const otherPatterns: string[] = []
      for (const pattern of approvedPatterns) {
        const bashMatch = pattern.match(/^Bash\((.+)\)$/)
        if (bashMatch?.[1]) {
          bashCommands.push(bashMatch[1])
        } else {
          otherPatterns.push(pattern)
        }
      }

      // Build a message that explicitly asks Claude to run the commands
      let continuationMessage: string
      if (bashCommands.length > 0 && otherPatterns.length === 0) {
        // Only Bash commands - be very explicit
        if (bashCommands.length === 1) {
          continuationMessage = `I approved the command. Run it now: \`${bashCommands[0]}\``
        } else {
          continuationMessage = `I approved these commands. Run them now:\n${bashCommands.map(cmd => `- \`${cmd}\``).join('\n')}`
        }
      } else if (bashCommands.length > 0) {
        // Mix of Bash and other tools
        continuationMessage = `I approved: ${approvedPatterns.join(', ')}. Execute them now.`
      } else {
        // Only non-Bash tools
        continuationMessage = `I approved ${approvedPatterns.join(', ')}. Continue with the task.`
      }

      // Set to yolo mode for auto-approval of all future tools
      setMode(sessionId, 'yolo')

      // Send continuation with yolo mode (no need for allowedTools in yolo mode)
      const modelToUse = context.model ?? selectedModelRef.current
      setLastSentMessage(sessionId, continuationMessage)
      setError(sessionId, null)
      addSendingSession(sessionId)
      setSelectedModel(sessionId, modelToUse)
      setExecutingMode(sessionId, 'yolo')

      sendMessage.mutate(
        {
          sessionId,
          worktreeId,
          worktreePath,
          message: continuationMessage,
          model: modelToUse,
          executionMode: 'yolo',
          thinkingLevel:
            context.thinkingLevel ?? selectedThinkingLevelRef.current,
          effortLevel: useAdaptiveThinkingRef.current
            ? selectedEffortLevelRef.current
            : undefined,
          mcpConfig: getMcpConfig(),
          customProfileName: getCustomProfileName(),
        },
        {
          onSettled: () => {
            inputRef.current?.focus()
          },
        }
      )
    },
    [
      activeWorktreeIdRef,
      activeWorktreePathRef,
      selectedModelRef,
      selectedThinkingLevelRef,
      selectedEffortLevelRef,
      useAdaptiveThinkingRef,
      getMcpConfig,
      getCustomProfileName,
      scrollToBottom,
      sendMessage,
      inputRef,
    ]
  )

  // Handle permission denial (user cancels approval request)
  const handlePermissionDeny = useCallback((sessionId: string) => {
    const {
      clearPendingDenials,
      clearDeniedMessageContext,
      getPendingDenials,
      setWaitingForInput,
      removeSendingSession,
      selectedBackends,
    } = useChatStore.getState()

    const backend = selectedBackends[sessionId] ?? 'claude'

    // For Codex: send decline response to unblock the attached process
    if (backend === 'codex') {
      const denials = getPendingDenials(sessionId)
      for (const denial of denials) {
        if (denial.rpc_id != null) {
          invoke('approve_codex_command', {
            sessionId,
            rpcId: denial.rpc_id,
            decision: 'decline',
          }).catch(err => {
            console.error('[ChatWindow] Failed to decline Codex command:', err)
          })
        }
      }
    }

    clearPendingDenials(sessionId)
    clearDeniedMessageContext(sessionId)
    setWaitingForInput(sessionId, false)
    removeSendingSession(sessionId)
    toast.info('Request cancelled')
  }, [])

  // Handle fixing a review finding
  // PERFORMANCE: Uses refs for session/worktree IDs to keep callback stable across session switches
  const handleFixFinding = useCallback(
    async (finding: ReviewFinding, customSuggestion?: string) => {
      const sessionId = activeSessionIdRef.current
      const worktreeId = activeWorktreeIdRef.current
      const worktreePath = activeWorktreePathRef.current
      if (!sessionId || !worktreeId || !worktreePath) return

      // Use custom suggestion if provided, otherwise use first suggestion
      const suggestionToApply =
        customSuggestion ?? finding.suggestions[0]?.code ?? ''

      const message = `Fix the following code review finding:

**File:** ${finding.file}
**Line:** ${finding.line}
**Issue:** ${finding.title}

${finding.description}

**Current code:**
\`\`\`
${finding.code}
\`\`\`

**Suggested fix:**
${suggestionToApply}

Please apply this fix to the file.`

      const {
        addSendingSession,
        setLastSentMessage,
        setError,
        setSelectedModel,
        setExecutingMode,
        markFindingFixed,
        isSending,
        enqueueMessage,
      } = useChatStore.getState()

      // Mark this finding as fixed (we don't have the index here, so we generate a key based on file+line)
      // The finding key format is: file:line:index - we'll match on file:line prefix
      // Get sessions data from query cache instead of closure for stable callback
      const cachedSessionsData = queryClient.getQueryData<WorktreeSessions>(
        chatQueryKeys.sessions(worktreeId)
      )
      const allContent =
        cachedSessionsData?.sessions
          ?.find((s: Session) => s.id === sessionId)
          ?.messages?.filter((m: { role: string }) => m.role === 'assistant')
          ?.map((m: { content: string }) => m.content)
          ?.join('\n') ?? ''
      const findings = parseReviewFindings(allContent)
      const findingIndex = findings.findIndex(
        f =>
          f.file === finding.file &&
          f.line === finding.line &&
          f.title === finding.title
      )
      if (findingIndex >= 0) {
        markFindingFixed(sessionId, getFindingKey(finding, findingIndex))
      }

      // If session is already busy, queue the fix message
      if (isSending(sessionId)) {
        enqueueMessage(sessionId, {
          id: generateId(),
          message,
          pendingImages: [],
          pendingFiles: [],
          pendingSkills: [],
          pendingTextFiles: [],
          model: selectedModelRef.current,
          provider: getCustomProfileName() ?? null,
          executionMode: 'build',
          thinkingLevel: selectedThinkingLevelRef.current,
          effortLevel: useAdaptiveThinkingRef.current
            ? selectedEffortLevelRef.current
            : undefined,
          mcpConfig: getMcpConfig(),
          queuedAt: Date.now(),
        })
        toast.info('Fix queued — will start when current task completes')
        return
      }

      setLastSentMessage(sessionId, message)
      setError(sessionId, null)
      addSendingSession(sessionId)
      setSelectedModel(sessionId, selectedModelRef.current)
      setExecutingMode(sessionId, 'build') // Fixes are always in build mode

      sendMessage.mutate(
        {
          sessionId,
          worktreeId,
          worktreePath,
          message,
          model: selectedModelRef.current,
          executionMode: 'build',
          thinkingLevel: selectedThinkingLevelRef.current,
          effortLevel: useAdaptiveThinkingRef.current
            ? selectedEffortLevelRef.current
            : undefined,
          mcpConfig: getMcpConfig(),
          customProfileName: getCustomProfileName(),
        },
        {
          onSettled: () => {
            inputRef.current?.focus()
          },
        }
      )
    },
    [
      activeSessionIdRef,
      activeWorktreeIdRef,
      activeWorktreePathRef,
      selectedModelRef,
      selectedThinkingLevelRef,
      selectedEffortLevelRef,
      useAdaptiveThinkingRef,
      getMcpConfig,
      getCustomProfileName,
      sendMessage,
      queryClient,
      inputRef,
    ]
  )

  // Handle fixing all review findings at once
  // PERFORMANCE: Uses refs for session/worktree IDs to keep callback stable across session switches
  const handleFixAllFindings = useCallback(
    async (
      findingsWithSuggestions: { finding: ReviewFinding; suggestion?: string }[]
    ) => {
      const sessionId = activeSessionIdRef.current
      const worktreeId = activeWorktreeIdRef.current
      const worktreePath = activeWorktreePathRef.current
      if (!sessionId || !worktreeId || !worktreePath) return

      const message = `Fix the following ${findingsWithSuggestions.length} code review findings:

${findingsWithSuggestions
  .map(
    ({ finding, suggestion }, i) => `
### ${i + 1}. ${finding.title}
**File:** ${finding.file}
**Line:** ${finding.line}

${finding.description}

**Current code:**
\`\`\`
${finding.code}
\`\`\`

**Suggested fix:**
${suggestion ?? finding.suggestions[0]?.code ?? '(no suggestion)'}
`
  )
  .join('\n---\n')}

Please apply all these fixes to the respective files.`

      const {
        addSendingSession,
        setLastSentMessage,
        setError,
        setSelectedModel,
        setExecutingMode,
        markFindingFixed,
        isSending,
        enqueueMessage,
      } = useChatStore.getState()

      // Mark all findings as fixed
      // Get sessions data from query cache instead of closure for stable callback
      const cachedSessionsData = queryClient.getQueryData<WorktreeSessions>(
        chatQueryKeys.sessions(worktreeId)
      )
      const allContent =
        cachedSessionsData?.sessions
          ?.find((s: Session) => s.id === sessionId)
          ?.messages?.filter((m: { role: string }) => m.role === 'assistant')
          ?.map((m: { content: string }) => m.content)
          ?.join('\n') ?? ''
      const allFindings = parseReviewFindings(allContent)

      for (const { finding } of findingsWithSuggestions) {
        const findingIndex = allFindings.findIndex(
          f =>
            f.file === finding.file &&
            f.line === finding.line &&
            f.title === finding.title
        )
        if (findingIndex >= 0) {
          markFindingFixed(sessionId, getFindingKey(finding, findingIndex))
        }
      }

      // If session is already busy, queue the fix message
      if (isSending(sessionId)) {
        enqueueMessage(sessionId, {
          id: generateId(),
          message,
          pendingImages: [],
          pendingFiles: [],
          pendingSkills: [],
          pendingTextFiles: [],
          model: selectedModelRef.current,
          provider: getCustomProfileName() ?? null,
          executionMode: 'build',
          thinkingLevel: selectedThinkingLevelRef.current,
          effortLevel: useAdaptiveThinkingRef.current
            ? selectedEffortLevelRef.current
            : undefined,
          mcpConfig: getMcpConfig(),
          queuedAt: Date.now(),
        })
        toast.info('Fix queued — will start when current task completes')
        return
      }

      setLastSentMessage(sessionId, message)
      setError(sessionId, null)
      addSendingSession(sessionId)
      setSelectedModel(sessionId, selectedModelRef.current)
      setExecutingMode(sessionId, 'build') // Fixes are always in build mode

      sendMessage.mutate(
        {
          sessionId,
          worktreeId,
          worktreePath,
          message,
          model: selectedModelRef.current,
          executionMode: 'build',
          thinkingLevel: selectedThinkingLevelRef.current,
          effortLevel: useAdaptiveThinkingRef.current
            ? selectedEffortLevelRef.current
            : undefined,
          mcpConfig: getMcpConfig(),
          customProfileName: getCustomProfileName(),
        },
        {
          onSettled: () => {
            inputRef.current?.focus()
          },
        }
      )
    },
    [
      activeSessionIdRef,
      activeWorktreeIdRef,
      activeWorktreePathRef,
      selectedModelRef,
      selectedThinkingLevelRef,
      selectedEffortLevelRef,
      useAdaptiveThinkingRef,
      getMcpConfig,
      getCustomProfileName,
      sendMessage,
      queryClient,
      inputRef,
    ]
  )

  return {
    handleQuestionAnswer,
    handleSkipQuestion,
    handlePlanApproval,
    handlePlanApprovalYolo,
    handleStreamingPlanApproval,
    handleStreamingPlanApprovalYolo,
    handleClearContextApproval,
    handleStreamingClearContextApproval,
    handlePendingPlanApprovalCallback,
    handlePermissionApproval,
    handlePermissionApprovalYolo,
    handlePermissionDeny,
    handleFixFinding,
    handleFixAllFindings,
  }
}
