use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use once_cell::sync::Lazy;
use tauri::AppHandle;

use super::claude::CancelledEvent;
use super::run_log;
use super::storage;
use crate::http_server::EmitExt;

/// Global registry of running Claude process PIDs by session_id
/// Allows cancellation of in-progress chat requests via SIGKILL
/// Key is session_id (not worktree_id) to support multiple concurrent sessions per worktree
static PROCESS_REGISTRY: Lazy<Mutex<HashMap<String, u32>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Sessions where cancel was requested before the CLI process was registered.
/// When `register_process` is called for a pending session, the process is killed immediately.
static PENDING_CANCELS: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));

/// Cancel flags for OpenCode sessions (HTTP-based, no PID to kill).
/// When cancel is requested, the flag is set so the blocking HTTP thread can detect it.
static CANCEL_FLAGS: Lazy<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Register a running Claude process PID for a session.
/// Returns `false` if the session was cancelled before registration (process is killed immediately).
pub fn register_process(session_id: String, pid: u32) -> bool {
    // Check pending cancels first
    {
        let mut pending = PENDING_CANCELS.lock().unwrap();
        log::info!(
            "[Registry] register_process session={session_id} pid={pid} pending_cancels={:?}",
            pending.iter().collect::<Vec<_>>()
        );
        if pending.remove(&session_id) {
            log::warn!(
                "[Registry] Session {session_id} was cancelled before process registered, killing PID {pid}"
            );
            use crate::platform::{kill_process, kill_process_tree};
            let _ = kill_process_tree(pid);
            let _ = kill_process(pid);
            return false;
        }
    }

    let mut registry = PROCESS_REGISTRY.lock().unwrap();
    log::info!("[Registry] Registering process pid={pid} for session={session_id}, registry_keys={:?}", registry.keys().collect::<Vec<_>>());
    registry.insert(session_id, pid);
    true
}

/// Remove a session from the pending cancellation set.
/// Called when send_chat_message fails before reaching register_process,
/// to prevent stale entries in the pending set.
pub fn clear_pending_cancel(session_id: &str) {
    let existed = PENDING_CANCELS.lock().unwrap().remove(session_id);
    if existed {
        log::info!("[Registry] clear_pending_cancel session={session_id} (entry existed)");
    }
}

/// Remove a process from the registry (called after completion or cancellation)
pub fn unregister_process(session_id: &str) {
    let mut registry = PROCESS_REGISTRY.lock().unwrap();
    if let Some(pid) = registry.remove(session_id) {
        log::trace!("Unregistered Claude process {pid} for session: {session_id}");
    }
}

/// Register a cancellation flag for an OpenCode session.
/// Returns `false` if the session was already cancelled (flag is set immediately).
pub fn register_cancel_flag(session_id: String, flag: Arc<AtomicBool>) -> bool {
    // Check pending cancels: if cancel was requested before we registered, cancel immediately
    {
        let mut pending = PENDING_CANCELS.lock().unwrap();
        if pending.remove(&session_id) {
            log::warn!(
                "Session {session_id} was cancelled before cancel flag registered, setting flag"
            );
            flag.store(true, Ordering::SeqCst);
            return false;
        }
    }

    CANCEL_FLAGS.lock().unwrap().insert(session_id, flag);
    true
}

/// Remove a session's cancel flag (called after completion).
pub fn unregister_cancel_flag(session_id: &str) {
    CANCEL_FLAGS.lock().unwrap().remove(session_id);
}

/// Check if a session has a running process
#[allow(dead_code)]
pub fn is_process_running(session_id: &str) -> bool {
    PROCESS_REGISTRY.lock().unwrap().contains_key(session_id)
}

/// Get all session IDs that currently have running processes
pub fn get_running_sessions() -> Vec<String> {
    PROCESS_REGISTRY.lock().unwrap().keys().cloned().collect()
}

/// Get all session IDs that are actively managed (running process OR cancel flag).
/// Used by recover_incomplete_runs to skip sessions that don't need recovery.
pub fn get_actively_managed_sessions() -> HashSet<String> {
    let mut sessions: HashSet<String> =
        PROCESS_REGISTRY.lock().unwrap().keys().cloned().collect();
    sessions.extend(CANCEL_FLAGS.lock().unwrap().keys().cloned());
    sessions
}

/// Check if a specific session is actively managed (has a running process or cancel flag).
/// Used by resume_session to avoid starting a duplicate tail.
pub fn is_session_actively_managed(session_id: &str) -> bool {
    PROCESS_REGISTRY.lock().unwrap().contains_key(session_id)
        || CANCEL_FLAGS.lock().unwrap().contains_key(session_id)
}

/// Cancel a running Claude process for a session by sending SIGKILL to the process group
/// Returns true if a process was found and signal sent, false otherwise
///
/// SAFETY: We kill the entire process group (negative PID) to ensure all child processes
/// spawned by Claude CLI are also terminated. This is safe because:
/// 1. Claude is spawned with process_group(0), creating a NEW group separate from Jean
/// 2. We guard against dangerous PIDs (0, 1) that could affect system processes
pub fn cancel_process(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
) -> Result<bool, String> {
    let mut registry = PROCESS_REGISTRY.lock().unwrap();
    log::warn!("cancel_process called for session: {session_id}");
    log::warn!("Registry state: {:?}", registry.iter().collect::<Vec<_>>());

    if let Some(pid) = registry.remove(session_id) {
        // SAFETY: Never kill PID 0 (would kill our own process group) or PID 1 (init/launchd)
        if pid == 0 || pid == 1 {
            log::error!("Refusing to kill dangerous PID: {pid}");
            return Err(format!("Invalid PID: {pid}"));
        }

        log::trace!("Cancelling Claude process group {pid} for session: {session_id}");

        // Kill the entire process tree to ensure child processes are also terminated
        // Uses platform-specific implementation from the platform module
        use crate::platform::{is_process_alive, kill_process, kill_process_tree};

        log::trace!("Killing process tree for pid={pid}");

        // First, check if the process exists
        if !is_process_alive(pid) {
            log::warn!("Process {pid} check failed (may have exited)");
        } else {
            log::trace!("Process {pid} exists, proceeding with kill");
        }

        // Kill the process tree (process group on Unix, taskkill /T on Windows)
        if let Err(e) = kill_process_tree(pid) {
            log::error!("Failed to kill process tree for pid={pid}: {e}");
        } else {
            log::trace!("Successfully sent kill to process tree pid={pid}");
        }

        // Also try killing the process directly as fallback
        if let Err(e) = kill_process(pid) {
            log::trace!("Direct kill of pid={pid} failed (may be redundant): {e}");
        } else {
            log::trace!("Direct kill of pid={pid} succeeded");
        }

        // Update manifest SYNCHRONOUSLY before emitting event
        // This ensures any frontend refetch sees "Cancelled" status, not "Running"
        if let Err(e) = run_log::mark_running_run_cancelled(app, session_id) {
            log::warn!("Failed to mark run as cancelled in manifest: {e}");
        }

        // Emit cancelled event for responsive UI
        let event = CancelledEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            undo_send: false, // Process was running, may have partial content
        };
        if let Err(e) = app.emit_all("chat:cancelled", &event) {
            log::error!("Failed to emit chat:cancelled event: {e}");
        }

        Ok(true)
    } else if let Some(flag) = CANCEL_FLAGS.lock().unwrap().get(session_id).cloned() {
        // OpenCode session: set the cancel flag so the HTTP thread detects it
        log::warn!("OpenCode session {session_id}: setting cancel flag");
        flag.store(true, Ordering::SeqCst);

        // Mark run as cancelled immediately (before HTTP call returns)
        if let Err(e) = run_log::mark_running_run_cancelled(app, session_id) {
            log::warn!("Failed to mark run as cancelled in manifest: {e}");
        }

        // Emit cancelled event with undo_send=true since no content has streamed yet
        let event = CancelledEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            undo_send: true,
        };
        if let Err(e) = app.emit_all("chat:cancelled", &event) {
            log::error!("Failed to emit chat:cancelled event: {e}");
        }

        Ok(true)
    } else {
        // Process not yet registered — queue for pending cancellation.
        // When register_process or register_cancel_flag is called later, the cancel is applied immediately.
        {
            let mut pending = PENDING_CANCELS.lock().unwrap();
            log::warn!("[Registry] cancel_process: no PID/flag for session={session_id}, adding to PENDING_CANCELS (before={:?})", pending.iter().collect::<Vec<_>>());
            pending.insert(session_id.to_string());
        }

        // Try to mark run as cancelled (may not exist yet if still preparing, that's ok)
        let _ = run_log::mark_running_run_cancelled(app, session_id);

        // Emit cancelled event so frontend handles it immediately
        let event = CancelledEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            undo_send: true, // No content was streamed yet
        };
        if let Err(e) = app.emit_all("chat:cancelled", &event) {
            log::error!("Failed to emit chat:cancelled event: {e}");
        }

        Ok(true)
    }
}

/// Cancel a running Claude process only if one is actively registered.
/// Unlike `cancel_process`, this does NOT add to PENDING_CANCELS and does NOT emit
/// `chat:cancelled` when the session is idle. Safe to call on idle sessions during
/// close/archive operations to avoid spurious "Request cancelled" events.
pub fn cancel_process_if_running(
    app: &AppHandle,
    session_id: &str,
    worktree_id: &str,
) -> Result<bool, String> {
    let mut registry = PROCESS_REGISTRY.lock().unwrap();

    if let Some(pid) = registry.remove(session_id) {
        if pid == 0 || pid == 1 {
            log::error!("Refusing to kill dangerous PID: {pid}");
            return Err(format!("Invalid PID: {pid}"));
        }

        log::trace!("Cancelling Claude process group {pid} for session: {session_id}");

        use crate::platform::{is_process_alive, kill_process, kill_process_tree};

        if !is_process_alive(pid) {
            log::warn!("Process {pid} check failed (may have exited)");
        }

        if let Err(e) = kill_process_tree(pid) {
            log::error!("Failed to kill process tree for pid={pid}: {e}");
        }
        let _ = kill_process(pid);

        if let Err(e) = run_log::mark_running_run_cancelled(app, session_id) {
            log::warn!("Failed to mark run as cancelled in manifest: {e}");
        }

        let event = CancelledEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            undo_send: false,
        };
        if let Err(e) = app.emit_all("chat:cancelled", &event) {
            log::error!("Failed to emit chat:cancelled event: {e}");
        }

        Ok(true)
    } else if let Some(flag) = CANCEL_FLAGS.lock().unwrap().get(session_id).cloned() {
        // OpenCode session actively running — set the cancel flag
        log::trace!("OpenCode session {session_id} is running, setting cancel flag");
        flag.store(true, Ordering::SeqCst);

        if let Err(e) = run_log::mark_running_run_cancelled(app, session_id) {
            log::warn!("Failed to mark run as cancelled in manifest: {e}");
        }

        let event = CancelledEvent {
            session_id: session_id.to_string(),
            worktree_id: worktree_id.to_string(),
            undo_send: true,
        };
        if let Err(e) = app.emit_all("chat:cancelled", &event) {
            log::error!("Failed to emit chat:cancelled event: {e}");
        }

        Ok(true)
    } else {
        // Session is idle — do nothing. No PENDING_CANCELS, no event emission.
        log::trace!("Session {session_id} has no running process, skipping cancel");
        Ok(false)
    }
}

/// Cancel all running Claude processes for a given worktree
/// Called before worktree deletion to clean up orphaned processes
pub fn cancel_processes_for_worktree(app: &AppHandle, worktree_id: &str) {
    log::trace!("Cancelling all Claude processes for worktree: {worktree_id}");

    // Load sessions for this worktree from app data directory
    match storage::load_sessions_by_id(app, worktree_id) {
        Ok(sessions) => {
            let mut cancelled_count = 0;
            for session in &sessions.sessions {
                if let Ok(true) = cancel_process(app, &session.id, worktree_id) {
                    cancelled_count += 1;
                }
            }
            if cancelled_count > 0 {
                log::trace!(
                    "Cancelled {cancelled_count} Claude process(es) for worktree: {worktree_id}"
                );
            }
        }
        Err(e) => {
            // Not an error - worktree may have no sessions yet
            log::trace!("No sessions found for worktree {worktree_id}: {e}");
        }
    }
}
