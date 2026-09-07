package heartbeat

import (
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// #5129. `acknowledgedSecurityPatterns` is the server's record of which
// strict-level danger patterns a human signed off on for this script. The
// daemon has to decode it off the payload and hand it to the executor;
// dropping it silently re-breaks every acknowledged script.

const (
	hklmScript      = `Set-ItemProperty -Path 'HKLM:\SOFTWARE\Contoso' -Name Enabled -Value 1`
	hklmDescription = "PowerShell HKLM modification"
)

func TestHandleScriptHonoursAcknowledgedSecurityPatterns(t *testing.T) {
	tests := []struct {
		name string
		// payloadValue is what the server put on the wire, verbatim — the
		// decoder sees `[]any`, not `[]string`, because it comes out of JSON.
		payloadValue any
		// omit sends no key at all: an older API talking to a newer agent.
		omit        bool
		wantRefusal bool
	}{
		{name: "key absent behaves as before the feature existed", omit: true, wantRefusal: true},
		{name: "empty list is fail closed", payloadValue: []any{}, wantRefusal: true},
		{name: "null is fail closed", payloadValue: nil, wantRefusal: true},
		{name: "unrelated acknowledgement grants nothing", payloadValue: []any{"scheduled task creation"}, wantRefusal: true},
		{name: "matching acknowledgement is honoured", payloadValue: []any{hklmDescription}, wantRefusal: false},
		{
			name:         "acknowledgement is honoured alongside others",
			payloadValue: []any{"scheduled task creation", hklmDescription},
			wantRefusal:  false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := newTestHeartbeat(nil)

			payload := map[string]any{
				"content":        hklmScript,
				"language":       "bash",
				"scriptId":       "script-5129",
				"timeoutSeconds": 10,
			}
			if !tc.omit {
				payload["acknowledgedSecurityPatterns"] = tc.payloadValue
			}

			result := handleScript(h, Command{ID: "cmd-5129-" + tc.name, Type: tools.CmdScript, Payload: payload})

			// The acknowledged run really executes (harmlessly — the HKLM line
			// is not a shell builtin), so assert on the refusal message rather
			// than on status: only a VALIDATION refusal names the pattern.
			refused := strings.Contains(result.Error, "script validation failed")
			if refused != tc.wantRefusal {
				t.Fatalf("validation refusal = %v, want %v; error was %q", refused, tc.wantRefusal, result.Error)
			}
			if tc.wantRefusal && !strings.Contains(result.Error, hklmDescription) {
				t.Fatalf("refusal must name the pattern, got %q", result.Error)
			}
			if tc.wantRefusal && !strings.Contains(strings.ToLower(result.Error), "acknowledge") {
				t.Fatalf("refusal must tell the operator to acknowledge the pattern, got %q", result.Error)
			}
		})
	}
}

// A BASIC-level pattern is not acknowledgeable at any layer. Asserted through
// the handler, not just the validator, so a future payload-shaping change
// cannot accidentally route an acknowledgement past the level check.
func TestHandleScriptNeverAcknowledgesBasicPatterns(t *testing.T) {
	h := newTestHeartbeat(nil)

	result := handleScript(h, Command{
		ID:   "cmd-5129-basic",
		Type: tools.CmdScript,
		Payload: map[string]any{
			"content":                      `Format-Volume -DriveLetter D`,
			"language":                     "bash",
			"timeoutSeconds":               10,
			"acknowledgedSecurityPatterns": []any{"PowerShell volume format"},
		},
	})

	if !strings.Contains(result.Error, "script validation failed") {
		t.Fatalf("a basic pattern must be refused despite the acknowledgement; got %q", result.Error)
	}
	if !strings.Contains(result.Error, "cannot be overridden") {
		t.Fatalf("the refusal must say the block is absolute; got %q", result.Error)
	}
}

// The daemon half of the runAs=user hop: the acknowledgement must survive the
// re-marshalled payload sendCommandToUserHelper puts on the IPC wire, or an
// acknowledged script runs in SYSTEM context and refuses in user context.
// Same failure shape as #4882, which is why this is asserted here and not
// only in the helper's own decoder test.
func TestHandleScriptForwardsAcknowledgementsToUserHelper(t *testing.T) {
	for _, goos := range []string{"linux", "windows"} {
		t.Run(goos, func(t *testing.T) {
			h, clientIPC := newPinnedRunAsUserHelper(t, goos, "helper-ack-"+goos)
			payloads := serveOneHelperCommand(t, clientIPC)

			result := handleScript(h, Command{
				ID:   "cmd-ack-" + goos,
				Type: tools.CmdScript,
				Payload: map[string]any{
					"content":                      hklmScript,
					"language":                     "bash",
					"runAs":                        "user",
					"scriptId":                     "script-5129",
					"timeoutSeconds":               10,
					"acknowledgedSecurityPatterns": []any{hklmDescription},
				},
			})
			if result.Status != "completed" {
				t.Fatalf("expected completed, got %s (%s)", result.Status, result.Error)
			}

			payload, ok := <-payloads
			if !ok {
				t.Fatal("user helper never received the forwarded command")
			}

			forwarded, ok := payload["acknowledgedSecurityPatterns"].([]any)
			if !ok {
				t.Fatalf("forwarded payload dropped `acknowledgedSecurityPatterns`; got keys %v", payloadKeys(payload))
			}
			if len(forwarded) != 1 || forwarded[0] != hklmDescription {
				t.Fatalf("forwarded acknowledgements = %#v, want [%q]", forwarded, hklmDescription)
			}
		})
	}
}
