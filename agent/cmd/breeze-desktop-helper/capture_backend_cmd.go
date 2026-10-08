package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/spf13/cobra"
)

// Seams for tests.
var (
	geteuidFn         = os.Geteuid
	resetSCKVerdictFn = desktop.ResetScreenCaptureKitVerdict
	pinCoreGraphicsFn = desktop.PinCoreGraphicsCapture
)

// errCaptureBackendAsRoot: the verdict lives in the console user's home, and
// the user-session helper reads only its own account's.
var errCaptureBackendAsRoot = errors.New("run this as the console user, not root: the verdict is per user " +
	"(~/Library/Application Support/Breeze/capture-backend.json) and root's copy is never read. " +
	`From a root shell: launchctl asuser <uid> sudo -u '#<uid>' breeze-desktop-helper capture-backend ...`)

// newCaptureBackendCmd builds `capture-backend`: show, reset or pin the
// recorded ScreenCaptureKit verdict that capture sessions honour (#8058).
func newCaptureBackendCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "capture-backend",
		Short: "Show the recorded ScreenCaptureKit verdict for this user (macOS)",
		Long: `Show the recorded ScreenCaptureKit verdict for this user (macOS 14+).

When a remote-desktop session finds ScreenCaptureKit unusable (the user
declined its consent, or it never produced a frame) and CoreGraphics works,
the desktop helper records that, and later sessions use CoreGraphics without
calling ScreenCaptureKit, so macOS does not ask the user again. A recorded
verdict lapses when the helper binary, the macOS build or the Screen
Recording grant changes.

  reset             forget the verdict; the next session tries ScreenCaptureKit
  pin-coregraphics  always use CoreGraphics for this user, until reset

Run as the console user. A running helper that could not save its verdict
keeps CoreGraphics until it restarts.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runCaptureBackendShow(cmd.OutOrStdout())
		},
	}
	cmd.AddCommand(&cobra.Command{
		Use:   "reset",
		Short: "Forget the recorded verdict so the next session tries ScreenCaptureKit",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runCaptureBackendReset(cmd.OutOrStdout())
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "pin-coregraphics",
		Short: "Always capture this user's sessions with CoreGraphics, never ScreenCaptureKit",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runCaptureBackendPin(cmd.OutOrStdout())
		},
	})
	return cmd
}

func runCaptureBackendShow(w io.Writer) error {
	if geteuidFn() == 0 {
		return errCaptureBackendAsRoot
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(sckVerdictFn())
}

func runCaptureBackendReset(w io.Writer) error {
	if geteuidFn() == 0 {
		return errCaptureBackendAsRoot
	}
	path, removed, err := resetSCKVerdictFn()
	if err != nil {
		return fmt.Errorf("reset capture backend verdict: %w", err)
	}
	if removed {
		fmt.Fprintf(w, "removed %s; the next remote-desktop session tries ScreenCaptureKit\n", path)
	} else {
		fmt.Fprintf(w, "no verdict recorded at %s\n", path)
	}
	return nil
}

func runCaptureBackendPin(w io.Writer) error {
	if geteuidFn() == 0 {
		return errCaptureBackendAsRoot
	}
	path, err := pinCoreGraphicsFn()
	if err != nil {
		return fmt.Errorf("pin CoreGraphics capture: %w", err)
	}
	fmt.Fprintf(w, "wrote %s; remote-desktop sessions for this user use CoreGraphics until `capture-backend reset`\n", path)
	return nil
}
