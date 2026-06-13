//go:build windows

package desktop

import (
	"fmt"
)

// procBlockInput is the Win32 user32!BlockInput. user32 itself is the LazyDLL
// already declared in input_windows.go (same package), so we only add the proc.
var procBlockInput = user32.NewProc("BlockInput")

// windowsInputBlockBackend blocks local physical input via the Win32 BlockInput
// API.
//
// THREAD AFFINITY (critical): BlockInput(TRUE), the operator's SendInput
// injection, and BlockInput(FALSE) must ALL run on the same OS thread, because
// Windows only honours injection / unblock from the thread that blocked input.
// Both Block and Unblock below therefore funnel their syscall through
// runOnInputThread (the single pinned input serializer), and the operator's
// injection path is routed through the same serializer in input_windows.go.
// See input_thread.go for the full rationale.
//
// BlockInput(TRUE) blocks all physical keyboard and mouse input. Two properties
// make it the right v1 primitive for issue #966:
//
//   - Injected input is NOT blocked. SendInput from the thread that called
//     BlockInput continues to work, so the remote operator's mouse/keyboard
//     (which the agent injects through WindowsInputHandler.HandleEvent) keeps
//     flowing while the on-site user's physical input is swallowed. That is
//     exactly the "stop fighting for control" behaviour the issue asks for.
//   - Ctrl+Alt+Del (the Secure Attention Sequence) is intentionally NOT blocked
//     by BlockInput, so the local user can always escape to the secure desktop.
//     This is a deliberate Windows safety guarantee, not a gap.
//
// Requirements / caveats:
//   - Requires the calling process to be running with the same or higher
//     integrity/privileges as the foreground thread; the agent runs as the
//     LocalSystem service, which satisfies this.
//   - If the calling THREAD exits, Windows automatically releases the block.
//     Combined with process-death release, this is our primary crash-safety
//     guarantee — a dead agent can never leave the keyboard wedged.
//   - BlockInput is also released automatically when the system switches to the
//     secure desktop (e.g. the user hits Ctrl+Alt+Del), and Windows re-enables
//     it on return. No action needed from us.
//
// FUTURE (not in this slice): for finer control — e.g. allowing specific local
// keys, or surviving secure-desktop transitions differently — switch to
// low-level hooks (SetWindowsHookEx WH_KEYBOARD_LL / WH_MOUSE_LL) which give
// per-event veto power. Hooks need a message pump on the hooking thread and
// careful teardown on every exit path, so they are deferred until the simpler
// BlockInput approach is proven on real targets.
type windowsInputBlockBackend struct{}

func newInputBlockBackend() inputBlockBackend {
	return &windowsInputBlockBackend{}
}

func (b *windowsInputBlockBackend) Supported() bool { return true }

func (b *windowsInputBlockBackend) Block() error {
	// BlockInput(TRUE) — must run on the single pinned input thread so the same
	// thread can later inject the operator's input and lift the block.
	var ret uintptr
	var callErr error
	runOnInputThread(func() {
		ret, _, callErr = procBlockInput.Call(1)
	})
	if ret == 0 {
		// A zero return means input is already blocked by ANOTHER thread, or the
		// caller lacks the required privilege. Surface it so Engage() can roll
		// back the refcount and the viewer learns the block did not take.
		return fmt.Errorf("BlockInput(TRUE): %w", callErr)
	}
	return nil
}

func (b *windowsInputBlockBackend) Unblock() error {
	// BlockInput(FALSE) — routed through the SAME pinned input thread that
	// called BlockInput(TRUE); a release from any other thread is a silent
	// no-op. Best-effort: a zero return here typically means input was already
	// unblocked (e.g. Windows released it on a secure-desktop switch), which is
	// a benign no-op for our purposes.
	var ret uintptr
	var callErr error
	runOnInputThread(func() {
		ret, _, callErr = procBlockInput.Call(0)
	})
	if ret == 0 {
		return fmt.Errorf("BlockInput(FALSE): %w", callErr)
	}
	return nil
}
