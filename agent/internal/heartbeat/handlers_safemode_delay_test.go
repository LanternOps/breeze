package heartbeat

import (
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// The toast is rendered from the delay that tools.ShutdownDelayMinutes already
// parsed and clamped, so it can no longer disagree with the reboot that gets
// scheduled (issue #3373).
func TestSafeModeRebootNotice(t *testing.T) {
	tests := []struct {
		name         string
		delayMinutes int
		want         string
	}{
		{
			name:         "immediate",
			delayMinutes: 0,
			want:         "System is rebooting into Safe Mode with Networking. Please save all work.",
		},
		{
			name:         "singular minute is not pluralised",
			delayMinutes: 1,
			want:         "System will reboot into Safe Mode with Networking in 1 minute. Please save all work.",
		},
		{
			name:         "plural minutes",
			delayMinutes: 15,
			want:         "System will reboot into Safe Mode with Networking in 15 minutes. Please save all work.",
		},
		{
			name:         "clamped maximum is announced as the clamped value",
			delayMinutes: 1440,
			want:         "System will reboot into Safe Mode with Networking in 1440 minutes. Please save all work.",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := safeModeRebootNotice(tt.delayMinutes); got != tt.want {
				t.Errorf("safeModeRebootNotice(%d)\n got: %q\nwant: %q", tt.delayMinutes, got, tt.want)
			}
		})
	}
}

// The announced delay must be the CLAMPED delay. Before the fix the handler
// re-read the raw payload, so an out-of-range value was announced verbatim
// while the reboot itself used the clamped one.
func TestSafeModeNoticeMatchesScheduledDelay(t *testing.T) {
	for _, raw := range []any{15, "15", float64(15), 5000, -5} {
		delay, err := tools.ShutdownDelayMinutes(map[string]any{"delay": raw})
		if err != nil {
			t.Fatalf("delay %#v: unexpected error %v", raw, err)
		}
		notice := safeModeRebootNotice(delay)

		if delay > 0 && !strings.Contains(notice, strconv.Itoa(delay)) {
			t.Errorf("delay %#v resolves to %d but the notice omits it: %q", raw, delay, notice)
		}
		if delay == 0 && strings.Contains(notice, "will reboot") {
			t.Errorf("delay %#v resolves to 0 (immediate) but the notice promises a delay: %q", raw, notice)
		}
	}
}

// A malformed delay must fail the command outright — before anything is
// broadcast to logged-in users and before the reboot tool is reached. The old
// code defaulted to 0, so users were warned of, and then subjected to, an
// immediate forced reboot into Safe Mode that nobody requested.
func TestHandleRebootSafeModeRejectsMalformedDelay(t *testing.T) {
	tests := []struct {
		name string
		raw  any
	}{
		{"non-numeric string", "soon"},
		{"empty string", ""},
		{"bool", true},
		{"non-integral float", 15.5},
		{"object", map[string]any{"minutes": 15}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// A nil sessionBroker means no broadcast is attempted; the strict
			// parse returns before the safe-mode tool is called on any OS.
			result := handleRebootSafeMode(&Heartbeat{}, Command{
				ID:      "cmd-1",
				Type:    tools.CmdRebootSafeMode,
				Payload: map[string]any{"delay": tt.raw},
			})

			if result.Status != "failed" {
				t.Fatalf("delay %#v: status = %q, want failed", tt.raw, result.Status)
			}
			if !strings.Contains(result.Error, "delay") {
				t.Errorf("delay %#v: error %q does not name the delay field", tt.raw, result.Error)
			}
			// A rejected command must not be reported as a safe-mode reboot
			// that was attempted and failed for some other reason.
			if strings.Contains(result.Error, "only supported on Windows") {
				t.Errorf("delay %#v: reached the safe-mode tool instead of failing validation: %q", tt.raw, result.Error)
			}
		})
	}
}

// A well-formed delay must flow through to the safe-mode tool. On non-Windows
// that tool is an inert stub, which makes this wiring assertion safe to run —
// it can never schedule a real reboot.
func TestHandleRebootSafeModeAcceptsWellFormedDelay(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("RebootToSafeMode actually reboots on Windows; wiring is asserted on other platforms")
	}

	for _, raw := range []any{15, "15", float64(15), nil} {
		result := handleRebootSafeMode(&Heartbeat{}, Command{
			ID:      "cmd-1",
			Type:    tools.CmdRebootSafeMode,
			Payload: map[string]any{"delay": raw},
		})

		// Reaching the platform stub proves validation passed and the handler
		// delegated, rather than rejecting a legitimate delay.
		if !strings.Contains(result.Error, "only supported on Windows") {
			t.Errorf("delay %#v: expected to reach the safe-mode tool, got %q", raw, result.Error)
		}
	}
}
