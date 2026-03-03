import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { listen } from '@tauri-apps/api/event'
import { useChatStore } from '@/store/chat-store'
import { usePreferences } from '@/services/preferences'
import {
  useCreateSession,
  useSendMessage,
  markPlanApproved,
  readPlanFile,
  chatQueryKeys,
} from '@/services/chat'
import { invoke } from '@/lib/transport'
import { isTauri } from '@/services/projects'
import type { Session, WorktreeSessions } from '@/types/chat'
import type { SessionCardData } from '../session-card-utils'

interface UseClearContextApprovalParams {
  worktreeId: string
  worktreePath: string
}

/**
 * Provides a "Clear Context & Approve" handler for canvas session cards.
 * Marks the plan approved on the original session, creates a new session,
 * switches to it, and sends the plan as the first message in YOLO mode.
 */
export function useClearContextApproval({
  worktreeId,
  worktreePath,
}: UseClearContextApprovalParams) {
  const queryClient = useQueryClient()
  const { data: preferences } = usePreferences()
  const createSession = useCreateSession()
  const sendMessage = useSendMessage()

  const handleClearContextApproval = useCallback(
    async (card: SessionCardData, updatedPlan?: string) => {
      const sessionId = card.session.id
      const messageId = card.pendingPlanMessageId

      // Step 1: Mark plan approved on original session
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

        queryClient.invalidateQueries({
          queryKey: chatQueryKeys.sessions(worktreeId),
        })
      }

      // Clear waiting state on original session
      const store = useChatStore.getState()
      store.clearToolCalls(sessionId)
      store.clearStreamingContentBlocks(sessionId)
      store.setSessionReviewing(sessionId, false)
      store.setWaitingForInput(sessionId, false)
      store.setPendingPlanMessageId(sessionId, null)

      invoke('update_session_state', {
        worktreeId,
        worktreePath,
        sessionId,
        waitingForInput: false,
        waitingForInputType: null,
      }).catch(err => {
        console.error(
          '[useClearContextApproval] Failed to clear waiting state:',
          err
        )
      })

      // Step 2: Resolve plan content
      let planContent = updatedPlan || card.planContent
      if (!planContent && card.planFilePath) {
        try {
          planContent = await readPlanFile(card.planFilePath)
        } catch (err) {
          toast.error(`Failed to read plan file: ${err}`)
          return
        }
      }
      if (!planContent) {
        toast.error('No plan content available')
        return
      }

      // Step 3: Create new session
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

      // Step 4: Switch to new session
      store.setActiveSession(worktreeId, newSession.id)
      store.addUserInitiatedSession(newSession.id)

      // Step 5: Send plan as first message in YOLO mode
      const model = preferences?.yolo_model ?? preferences?.selected_model ?? 'opus'
      toast.info(`Using ${model} model for yolo`)
      const thinkingLevel = preferences?.thinking_level ?? 'off'
      const resolvedPlanFilePath = card.planFilePath || store.getPlanFilePath(sessionId)
      const planFileLine = resolvedPlanFilePath ? `\nPlan file: ${resolvedPlanFilePath}\n` : ''
      const message = `Execute this plan. Implement all changes described.${planFileLine}\n\n<plan>\n${planContent}\n</plan>`

      store.setExecutionMode(newSession.id, 'yolo')
      store.setLastSentMessage(newSession.id, message)
      store.setError(newSession.id, null)
      store.addSendingSession(newSession.id)
      store.setSelectedModel(newSession.id, model)
      store.setExecutingMode(newSession.id, 'yolo')

      sendMessage.mutate({
        sessionId: newSession.id,
        worktreeId,
        worktreePath,
        message,
        model,
        executionMode: 'yolo',
        thinkingLevel,
        customProfileName: card.session.selected_provider ?? undefined,
      })

      // Optionally close the original session — but only after the new session's
      // send_chat_message has started (chat:sending event). This avoids a race where
      // close_session runs concurrently with send_chat_message and interferes with
      // the new session's startup. Falls back to a 10s timeout as a safety net.
      if (preferences?.close_original_on_clear_context) {
        const command =
          preferences.removal_behavior === 'archive'
            ? 'archive_session'
            : 'close_session'

        const doClose = () => {
          invoke(command, {
            worktreeId,
            worktreePath,
            sessionId,
          })
            .then(() => {
              queryClient.invalidateQueries({
                queryKey: chatQueryKeys.sessions(worktreeId),
              })
            })
            .catch(err => {
              console.error(
                '[useClearContextApproval] Failed to close original session:',
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
            // If listen fails, fall back to immediate close
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
      worktreeId,
      worktreePath,
      queryClient,
      preferences,
      createSession,
      sendMessage,
    ]
  )

  return { handleClearContextApproval }
}
