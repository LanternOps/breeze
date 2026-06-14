package desktop

// Single-threaded input serializer (issue #966).
//
// WHY THIS EXISTS
//
// On Windows, the Win32 BlockInput API has a hard thread-affinity rule: while
// input is blocked, ONLY the thread that called BlockInput(TRUE) may inject
// input (via SendInput) or lift the block (via BlockInput(FALSE)). Injected
// input from any OTHER thread is swallowed exactly like physical input, and a
// BlockInput(FALSE) from another thread is a no-op. See MSDN BlockInput:
// "blocks keyboard and mouse input events from reaching applications ...
// Only the thread that blocked input can successfully unblock input."
//
// In the desktop session, these three things historically ran on three
// DIFFERENT goroutines (and therefore potentially three different OS threads):
//
//   1. BlockInput(TRUE)  — control DataChannel goroutine (handleControlMessage
//      -> handleBlockLocalInput -> manager.Engage -> backend.Block).
//   2. The operator's SendInput injection — the "input" DataChannel goroutine
//      (handleInputMessage -> inputHandler.HandleEvent), plus the WS fallback
//      path (ws_stream.go) and the AI computer-use path (computer_action.go).
//   3. BlockInput(FALSE) — Release()/doCleanup()/the max-duration watchdog,
//      each on yet another goroutine.
//
// That arrangement defeats the entire feature: BlockInput would block the
// operator's OWN injection, and the release would be unreliable.
//
// THE FIX
//
// Funnel EVERY user32 input syscall — BlockInput(TRUE), BlockInput(FALSE), and
// every SendInput / SetCursorPos / MapVirtualKeyW / GetSystemMetrics /
// VkKeyScanW / desktop-switch call — through ONE dedicated OS-thread-locked
// goroutine. That goroutine calls runtime.LockOSThread() once and never
// unlocks, so it owns a single OS thread for the agent's entire lifetime. All
// callers submit a closure via runOnInputThread and block until it has run on
// that thread. Because the thread is the same for the block, the injection and
// the release, the BlockInput affinity rule is satisfied by construction.
//
// runOnInputThread is the single entry point. On Windows it dispatches to the
// pinned serializer thread. On every other platform it runs the closure inline:
// macOS uses CGEvent (no equivalent thread-affinity constraint for the v1 stub,
// which is unsupported anyway) and Linux/other are no-ops, so there is nothing
// to serialize and the extra goroutine would only add latency.
//
// runOnInputThread MUST NOT be called re-entrantly from within a closure that
// is already running on the input thread (it would deadlock waiting for the
// single worker to drain). The Windows input call sites are structured so the
// top-level operation submits exactly one closure that performs all of its
// syscalls directly; no nested submission occurs.
