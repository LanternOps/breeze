//go:build !windows

package terminal

import (
	"os/exec"
	"testing"
)

func TestForwardSignalNilCmd(t *testing.T) {
	s := &Session{
		ID:  "sig-nil-cmd",
		cmd: nil,
	}
	// Should not panic with nil cmd.
	s.forwardSignal(0x03)
}

func TestForwardSignalNilProcess(t *testing.T) {
	s := &Session{
		ID:  "sig-nil-proc",
		cmd: &exec.Cmd{},
	}
	// cmd.Process is nil — should not panic.
	s.forwardSignal(0x03)
}

func TestForwardSignalUnrecognizedByte(t *testing.T) {
	s := &Session{
		ID:  "sig-unrecognized",
		cmd: &exec.Cmd{},
	}
	// Non-signal byte should be a no-op and not panic.
	s.forwardSignal(0x41) // 'A'
	s.forwardSignal(0x0D) // carriage return
	s.forwardSignal(0x0A) // newline
	s.forwardSignal(0x00) // null
}

func TestForwardSignalRecognizedBytes(t *testing.T) {
	// Table-driven test for all recognized control characters.
	tests := []struct {
		name string
		b    byte
	}{
		{"Ctrl+C (SIGINT)", 0x03},
		{"Ctrl+\\ (SIGQUIT)", 0x1c},
		{"Ctrl+Z (SIGTSTP)", 0x1a},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// With nil process, forwardSignal should return early without panic.
			s := &Session{
				ID:  "sig-recognized",
				cmd: nil,
			}
			s.forwardSignal(tt.b)

			// With nil Process field, should also be safe.
			s2 := &Session{
				ID:  "sig-recognized-2",
				cmd: &exec.Cmd{},
			}
			s2.forwardSignal(tt.b)
		})
	}
}

func TestForwardSignalWithRealProcess(t *testing.T) {
	// Start a real process (sleep) and verify that forwarding SIGINT
	// kills it without panic.
	cmd := exec.Command("sleep", "60")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start sleep: %v", err)
	}

	s := &Session{
		ID:  "sig-real",
		cmd: cmd,
	}

	// Send SIGINT — this should signal the process group.
	// It may fail with "no such process" on the group kill, but should not panic.
	s.forwardSignal(0x03)

	// Clean up the process.
	cmd.Process.Kill()
	cmd.Wait()
}

func TestForwardSignalAllBytesNoAction(t *testing.T) {
	// Verify that iterating through every byte value that is NOT a signal
	// results in no action (no panic, no signal sent).
	signalBytes := map[byte]bool{
		0x03: true, // Ctrl+C
		0x1c: true, // Ctrl+backslash
		0x1a: true, // Ctrl+Z
	}

	s := &Session{
		ID:  "sig-all-bytes",
		cmd: nil,
	}

	for b := byte(0); b < 255; b++ {
		if signalBytes[b] {
			continue
		}
		s.forwardSignal(b)
	}
	// The byte 255 is also not a signal.
	s.forwardSignal(255)
}
