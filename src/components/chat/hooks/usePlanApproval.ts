import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useChatStore } from '@/store/chat-store'
import { usePreferences } from '@/services/preferences'
import {
  useSendMessage,
  markPlanApproved,
  chatQueryKeys,
} from '@/services/chat'
import { invoke } from '@/lib/transport'
import type { Session, WorktreeSessions } from '@/types/chat'
import type { SessionCardData } from '../session-card-utils'

interface UsePlanApprovalParams {
  worktreeId: string
  worktreePath: string
}

/**
 * Formats the approval message, including updated plan if content was changed.
 */
function formatApprovalMessage(
  baseMessage: string,
  updatedPlan?: string,
  originalPlan?: string | null
): string {
  // No updated plan provided, or plan unchanged
  if (!updatedPlan || updatedPlan === originalPlan) {
    return baseMessage
  }

  return `I've updated the plan. Please review and execute:

<updated-plan>
${updatedPlan}
</updated-plan>`
}

/**
 * Provides plan approval handlers for canvas session cards.
 */
export function usePlanApproval({
  worktreeId,
  worktreePath,
}: UsePlanApprovalParams) {
  const queryClient = useQueryClient()
  const { data: preferences } = usePreferences()
  const sendMessage = useSendMessage()

  const {
    setExecutionMode,
    addSendingSession,
    setSelectedModel,
    setLastSentMessage,
    setError,
    setExecutingMode,
    setSessionReviewing,
    setWaitingForInput,
    clearToolCalls,
    clearStreamingContentBlocks,
    setPendingPlanMessageId,
  } = useChatStore.getState()

  const handlePlanApproval = useCallback(
    (card: SessionCardData, updatedPlan?: string) => {
      console.warn('[usePlanApproval] handlePlanApproval (BUILD) CALLED', card.session.id)
      const sessionId = card.session.id
      const messageId = card.pendingPlanMessageId
      const originalPlan = card.planContent

      // If there's a pending plan message, mark it as approved
      if (messageId) {
        markPlanApproved(worktreeId, worktreePath, sessionId, messageId)

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

        // Optimistically clear waiting_for_input in sessions cache to prevent
        // stale "waiting" status during the refetch window
        queryClient.setQueryData<WorktreeSessions>(
          chatQueryKeys.sessions(worktreeId),
          old => {
            if (!old) return old
            return {
              ...old,
              sessions: old.sessions.map(s =>
                s.id === sessionId
                  ? {
                      ...s,
                      waiting_for_input: false,
                      pending_plan_message_id: undefined,
                      waiting_for_input_type: undefined,
                    }
                  : s
              ),
            }
          }
        )

        // Backend's emit_cache_invalidation (from mark_plan_approved and
        // update_session_state) will trigger the eventual refetch with correct data.
        // Don't invalidate here — the refetch races with backend mutations and can
        // overwrite the optimistic update with stale waiting_for_input: true.
      }

      setExecutionMode(sessionId, 'build')
      console.log('[usePlanApproval] Broadcasting executionMode=build for session', sessionId)
      invoke('broadcast_session_setting', {
        sessionId,
        key: 'executionMode',
        value: 'build',
      }).then(() => {
        console.log('[usePlanApproval] Broadcast executionMode=build succeeded')
      }).catch(err => {
        console.error('[usePlanApproval] Broadcast executionMode=build failed:', err)
      })
      clearToolCalls(sessionId)
      clearStreamingContentBlocks(sessionId)
      setSessionReviewing(sessionId, false)
      setWaitingForInput(sessionId, false)
      setPendingPlanMessageId(sessionId, null)

      const model = preferences?.selected_model ?? 'opus'
      const thinkingLevel = preferences?.thinking_level ?? 'off'
      const sessionBackend = card.session.backend

      // Format message - if no pending plan, always include the updated plan content
      // For Codex: use explicit execution instruction since it resumes a thread
      const isCodex = sessionBackend === 'codex'
      const baseMsg = isCodex
        ? 'Execute the plan you created. Implement all changes described.'
        : 'Plan approved. Begin implementing the changes now. Do not re-explain the plan — start writing code.'
      const rawMessage = messageId
        ? formatApprovalMessage(baseMsg, updatedPlan, originalPlan)
        : `I've updated the plan. Please review and execute:\n\n<updated-plan>\n${updatedPlan}\n</updated-plan>`
      const buildInfo = [sessionBackend, model].filter(Boolean).join(' / ')
      const message = buildInfo ? `[Build: ${buildInfo}]\n${rawMessage}` : rawMessage

      // Persist cleared waiting state to backend BEFORE sending the message.
      // On WebSocket (web access), commands are dispatched concurrently via tokio::spawn.
      // Without awaiting, send_chat_message can start before update_session_state writes
      // to disk, causing chat:sending's invalidateQueries to refetch stale waiting_for_input.
      invoke('update_session_state', {
        worktreeId,
        worktreePath,
        sessionId,
        waitingForInput: false,
        waitingForInputType: null,
        selectedExecutionMode: 'build',
      })
        .catch(err => {
          console.error('[usePlanApproval] Failed to clear waiting state:', err)
        })
        .finally(() => {
          setLastSentMessage(sessionId, message)
          setError(sessionId, null)
          addSendingSession(sessionId)
          setSelectedModel(sessionId, model)
          setExecutingMode(sessionId, 'build')

          sendMessage.mutate({
            sessionId,
            worktreeId,
            worktreePath,
            message,
            model,
            executionMode: 'build',
            thinkingLevel,
            customProfileName: card.session.selected_provider ?? undefined,
          })
        })
    },
    [
      worktreeId,
      worktreePath,
      queryClient,
      preferences,
      sendMessage,
      setExecutionMode,
      clearToolCalls,
      clearStreamingContentBlocks,
      setSessionReviewing,
      setWaitingForInput,
      setPendingPlanMessageId,
      setLastSentMessage,
      setError,
      addSendingSession,
      setSelectedModel,
      setExecutingMode,
    ]
  )

  const handlePlanApprovalYolo = useCallback(
    (card: SessionCardData, updatedPlan?: string) => {
      console.warn('[usePlanApproval] handlePlanApprovalYolo (YOLO) CALLED', card.session.id)
      const sessionId = card.session.id
      const messageId = card.pendingPlanMessageId
      const originalPlan = card.planContent

      // If there's a pending plan message, mark it as approved
      if (messageId) {
        markPlanApproved(worktreeId, worktreePath, sessionId, messageId)

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

        // Optimistically clear waiting_for_input in sessions cache to prevent
        // stale "waiting" status during the refetch window
        queryClient.setQueryData<WorktreeSessions>(
          chatQueryKeys.sessions(worktreeId),
          old => {
            if (!old) return old
            return {
              ...old,
              sessions: old.sessions.map(s =>
                s.id === sessionId
                  ? {
                      ...s,
                      waiting_for_input: false,
                      pending_plan_message_id: undefined,
                      waiting_for_input_type: undefined,
                    }
                  : s
              ),
            }
          }
        )

        // Backend's emit_cache_invalidation will trigger the eventual refetch.
        // Don't invalidate here — races with backend mutations.
      }

      setExecutionMode(sessionId, 'yolo')
      console.log('[usePlanApproval] Broadcasting executionMode=yolo for session', sessionId)
      invoke('broadcast_session_setting', {
        sessionId,
        key: 'executionMode',
        value: 'yolo',
      }).then(() => {
        console.log('[usePlanApproval] Broadcast executionMode=yolo succeeded')
      }).catch(err => {
        console.error('[usePlanApproval] Broadcast executionMode=yolo failed:', err)
      })
      clearToolCalls(sessionId)
      clearStreamingContentBlocks(sessionId)
      setSessionReviewing(sessionId, false)
      setWaitingForInput(sessionId, false)
      setPendingPlanMessageId(sessionId, null)

      const model = preferences?.selected_model ?? 'opus'
      const thinkingLevel = preferences?.thinking_level ?? 'off'
      const sessionBackend = card.session.backend

      // Format message - if no pending plan, always include the updated plan content
      const isCodexYolo = sessionBackend === 'codex'
      const baseMsgYolo = isCodexYolo
        ? 'Execute the plan you created. Implement all changes described.'
        : 'Plan approved (yolo mode). Begin implementing all changes immediately without asking for confirmation. Do not re-explain the plan — start writing code.'
      const rawMessage = messageId
        ? formatApprovalMessage(baseMsgYolo, updatedPlan, originalPlan)
        : `I've updated the plan. Please review and execute:\n\n<updated-plan>\n${updatedPlan}\n</updated-plan>`
      const yoloInfo = [sessionBackend, model].filter(Boolean).join(' / ')
      const message = yoloInfo ? `[Yolo: ${yoloInfo}]\n${rawMessage}` : rawMessage

      // Persist cleared waiting state to backend BEFORE sending the message.
      // See handlePlanApproval comment for why this must be awaited.
      invoke('update_session_state', {
        worktreeId,
        worktreePath,
        sessionId,
        waitingForInput: false,
        waitingForInputType: null,
        selectedExecutionMode: 'yolo',
      })
        .catch(err => {
          console.error('[usePlanApproval] Failed to clear waiting state:', err)
        })
        .finally(() => {
          setLastSentMessage(sessionId, message)
          setError(sessionId, null)
          addSendingSession(sessionId)
          setSelectedModel(sessionId, model)
          setExecutingMode(sessionId, 'yolo')

          sendMessage.mutate({
            sessionId,
            worktreeId,
            worktreePath,
            message,
            model,
            executionMode: 'yolo',
            thinkingLevel,
            customProfileName: card.session.selected_provider ?? undefined,
          })
        })
    },
    [
      worktreeId,
      worktreePath,
      queryClient,
      preferences,
      sendMessage,
      setExecutionMode,
      clearToolCalls,
      clearStreamingContentBlocks,
      setSessionReviewing,
      setWaitingForInput,
      setPendingPlanMessageId,
      setLastSentMessage,
      setError,
      addSendingSession,
      setSelectedModel,
      setExecutingMode,
    ]
  )

  return { handlePlanApproval, handlePlanApprovalYolo }
}
