import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { invoke } from '@/lib/transport'
import { prefetchSessions } from '@/services/chat'
import { useProjectsStore } from '@/store/projects-store'
import type { Project, Worktree } from '@/types/projects'
import { isNativeApp } from '@/lib/environment'

/**
 * Prefetch sessions for all projects on app startup.
 * This runs regardless of sidebar visibility to ensure session statuses
 * (reviewingSessions, waitingForInputSessionIds) are restored immediately.
 *
 * Without this, session statuses only load when:
 * 1. The sidebar is open (ProjectsSidebar mounts and runs its own prefetch)
 * 2. A session is explicitly opened (useSessions runs with refetchOnMount)
 */
export function useSessionPrefetch(projects: Project[] | undefined) {
  const queryClient = useQueryClient()
  const hasFetchedRef = useRef(false)

  useEffect(() => {
    if (!isNativeApp()) return
    if (hasFetchedRef.current || !projects || projects.length === 0) return
    hasFetchedRef.current = true

    // Filter to only actual projects (not folders)
    const actualProjects = projects.filter(p => !p.is_folder)
    if (actualProjects.length === 0) return

    // Get expanded projects from store (use getState to avoid subscription)
    const { expandedProjectIds } = useProjectsStore.getState()

    // Split into expanded (priority) and collapsed projects
    const expandedProjects = actualProjects.filter(p =>
      expandedProjectIds.has(p.id)
    )
    const collapsedProjects = actualProjects.filter(
      p => !expandedProjectIds.has(p.id)
    )

    // Fetch sessions for all worktrees in a project
    const fetchSessionsForProject = async (projectId: string) => {
      try {
        const worktrees = await invoke<Worktree[]>('list_worktrees', {
          projectId,
        })
        await Promise.all(
          worktrees.map(w =>
            prefetchSessions(queryClient, w.id, w.path).catch(() => {
              /* silent */
            })
          )
        )
      } catch {
        // Silently ignore — worktrees may not be available yet
      }
    }

    const fetchAll = async () => {
      const concurrencyLimit = 3

      // First: fetch expanded projects (user sees these immediately)
      for (let i = 0; i < expandedProjects.length; i += concurrencyLimit) {
        const batch = expandedProjects.slice(i, i + concurrencyLimit)
        await Promise.all(batch.map(p => fetchSessionsForProject(p.id)))
      }

      // Then: fetch collapsed projects in background
      for (let i = 0; i < collapsedProjects.length; i += concurrencyLimit) {
        const batch = collapsedProjects.slice(i, i + concurrencyLimit)
        await Promise.all(batch.map(p => fetchSessionsForProject(p.id)))
      }
    }

    fetchAll()
  }, [projects, queryClient])
}
