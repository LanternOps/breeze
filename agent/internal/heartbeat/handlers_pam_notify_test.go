package heartbeat

import (
	"encoding/json"
	"runtime"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

const pamNotifyTestRequestID = "40000000-0000-4000-8000-000000000001"

func pamNotifyCommand(payload map[string]any) Command {
	return Command{ID: "70000000-0000-4000-8000-000000000001", Type: tools.CmdPamRequestNotify, Payload: payload}
}

func trackedNotifyHeartbeat(t *testing.T) (*Heartbeat, *pamNotifyRecorder) {
	t.Helper()
	h := &Heartbeat{}
	rec := recordPamNotices(h)
	h.pamTracker().MarkAwaiting(pamNotifyTestRequestID, "5", "mmc.exe", "Contoso IT")
	return h, rec
}

func TestPamRequestNotifyRegistered(t *testing.T) {
	if _, ok := handlerRegistry[tools.CmdPamRequestNotify]; !ok {
		t.Fatalf("%s has no handler", tools.CmdPamRequestNotify)
	}
}

func TestPamRequestNotifyDeniedWithReason(t *testing.T) {
	h, rec := trackedNotifyHeartbeat(t)
	result := handlePamRequestNotify(h, pamNotifyCommand(map[string]any{
		"requestId": pamNotifyTestRequestID,
		"outcome":   "denied",
		"reason":    "Use the self-service portal.\nCall us if it is urgent.",
	}))
	if result.Status != "completed" {
		t.Fatalf("result = %+v", result)
	}
	want := pamNotifyCall{
		Title:      "Request denied",
		Body:       "mmc.exe was denied by Contoso IT.\nReason: Use the self-service portal.\nCall us if it is urgent.",
		WinSession: "5",
	}
	if calls := rec.Calls(); len(calls) != 1 || calls[0] != want {
		t.Fatalf("notices = %+v, want [%+v]", calls, want)
	}
	if _, ok := h.pamTracker().Get(pamNotifyTestRequestID); ok {
		t.Fatal("a delivered outcome must remove the tracker entry")
	}

	// Redelivery of the same command: untracked now, success and no toast.
	again := handlePamRequestNotify(h, pamNotifyCommand(map[string]any{
		"requestId": pamNotifyTestRequestID, "outcome": "denied", "reason": "x",
	}))
	if again.Status != "completed" || len(rec.Calls()) != 1 {
		t.Fatalf("redelivery: result=%+v notices=%d", again, len(rec.Calls()))
	}
}

func TestPamRequestNotifyDeniedNoReason(t *testing.T) {
	for name, payload := range map[string]map[string]any{
		"absent": {"requestId": pamNotifyTestRequestID, "outcome": "denied"},
		"empty":  {"requestId": pamNotifyTestRequestID, "outcome": "denied", "reason": ""},
		"null":   {"requestId": pamNotifyTestRequestID, "outcome": "denied", "reason": nil},
	} {
		t.Run(name, func(t *testing.T) {
			h, rec := trackedNotifyHeartbeat(t)
			result := handlePamRequestNotify(h, pamNotifyCommand(payload))
			if result.Status != "completed" {
				t.Fatalf("result = %+v", result)
			}
			want := pamNotifyCall{Title: "Request denied", Body: "mmc.exe was denied by Contoso IT.", WinSession: "5"}
			if calls := rec.Calls(); len(calls) != 1 || calls[0] != want {
				t.Fatalf("notices = %+v, want [%+v]", calls, want)
			}
		})
	}
}

func TestPamRequestNotifyExpired(t *testing.T) {
	h, rec := trackedNotifyHeartbeat(t)
	result := handlePamRequestNotify(h, pamNotifyCommand(map[string]any{
		"requestId": pamNotifyTestRequestID,
		"outcome":   "expired",
	}))
	if result.Status != "completed" {
		t.Fatalf("result = %+v", result)
	}
	want := pamNotifyCall{
		Title:      "Request expired",
		Body:       "Your request for mmc.exe expired before Contoso IT responded. Try again or contact Contoso IT.",
		WinSession: "5",
	}
	if calls := rec.Calls(); len(calls) != 1 || calls[0] != want {
		t.Fatalf("notices = %+v, want [%+v]", calls, want)
	}
	if _, ok := h.pamTracker().Get(pamNotifyTestRequestID); ok {
		t.Fatal("a delivered outcome must remove the tracker entry")
	}
}

// The support name and program come from the tracker, so a tracked request
// with no support name says IT.
func TestPamRequestNotifyUsesTrackerNamesWithITFallback(t *testing.T) {
	h := &Heartbeat{}
	rec := recordPamNotices(h)
	h.rememberSupportName("Fabrikam Support") // cache must not leak into a tracked entry
	h.pamTracker().MarkAwaiting(pamNotifyTestRequestID, "", "setup.exe", "")
	result := handlePamRequestNotify(h, pamNotifyCommand(map[string]any{
		"requestId": pamNotifyTestRequestID, "outcome": "expired",
	}))
	if result.Status != "completed" {
		t.Fatalf("result = %+v", result)
	}
	want := pamNotifyCall{
		Title: "Request expired",
		Body:  "Your request for setup.exe expired before IT responded. Try again or contact IT.",
	}
	if calls := rec.Calls(); len(calls) != 1 || calls[0] != want {
		t.Fatalf("notices = %+v, want [%+v]", calls, want)
	}
}

// Review Focus 3: after a restart, or for a request the user declined
// locally, there is no tracker entry. The command must still succeed (so the
// server does not retry it) and nothing is shown.
func TestPamRequestNotifyUntrackedNoToast(t *testing.T) {
	h := &Heartbeat{}
	rec := recordPamNotices(h)
	for _, outcome := range []string{"denied", "expired"} {
		result := handlePamRequestNotify(h, pamNotifyCommand(map[string]any{
			"requestId": pamNotifyTestRequestID, "outcome": outcome, "reason": "r",
		}))
		if result.Status != "completed" {
			t.Fatalf("%s: result = %+v", outcome, result)
		}
	}
	if calls := rec.Calls(); len(calls) != 0 {
		t.Fatalf("untracked request showed notices: %+v", calls)
	}
}

// A request that already got its outcome notice (an approved toast) is not
// toasted again by a late deny/expiry notify, but the entry is still cleared.
func TestPamRequestNotifyAlreadyNotifiedNoSecondToast(t *testing.T) {
	h, rec := trackedNotifyHeartbeat(t)
	if _, ok := h.pamTracker().ClaimNotify(pamNotifyTestRequestID); !ok {
		t.Fatal("setup claim failed")
	}
	result := handlePamRequestNotify(h, pamNotifyCommand(map[string]any{
		"requestId": pamNotifyTestRequestID, "outcome": "expired",
	}))
	if result.Status != "completed" || len(rec.Calls()) != 0 {
		t.Fatalf("result=%+v notices=%+v", result, rec.Calls())
	}
	if _, ok := h.pamTracker().Get(pamNotifyTestRequestID); ok {
		t.Fatal("entry must be removed")
	}
}

func TestPamRequestNotifyRejectsOversizedReason(t *testing.T) {
	t.Run("501 runes refused", func(t *testing.T) {
		h, rec := trackedNotifyHeartbeat(t)
		result := handlePamRequestNotify(h, pamNotifyCommand(map[string]any{
			"requestId": pamNotifyTestRequestID, "outcome": "denied", "reason": strings.Repeat("é", 501),
		}))
		if result.Status != "failed" || result.Error == "" {
			t.Fatalf("result = %+v, want a refusal", result)
		}
		if len(rec.Calls()) != 0 {
			t.Fatalf("refused notify showed a notice: %+v", rec.Calls())
		}
		if _, ok := h.pamTracker().Get(pamNotifyTestRequestID); !ok {
			t.Fatal("a refused notify must not consume the tracker entry")
		}
	})
	t.Run("500 runes accepted", func(t *testing.T) {
		h, rec := trackedNotifyHeartbeat(t)
		reason := strings.Repeat("é", 500)
		result := handlePamRequestNotify(h, pamNotifyCommand(map[string]any{
			"requestId": pamNotifyTestRequestID, "outcome": "denied", "reason": reason,
		}))
		if result.Status != "completed" {
			t.Fatalf("result = %+v", result)
		}
		if calls := rec.Calls(); len(calls) != 1 || !strings.HasSuffix(calls[0].Body, "\nReason: "+reason) {
			t.Fatalf("notices = %+v", calls)
		}
	})
}

func TestPamRequestNotifyRejectsUnknownOutcome(t *testing.T) {
	for _, outcome := range []any{"approved", "withdrawn", "", "DENIED", nil, 1} {
		h, rec := trackedNotifyHeartbeat(t)
		result := handlePamRequestNotify(h, pamNotifyCommand(map[string]any{
			"requestId": pamNotifyTestRequestID, "outcome": outcome,
		}))
		if result.Status != "failed" {
			t.Fatalf("outcome %v: result = %+v, want a refusal", outcome, result)
		}
		if len(rec.Calls()) != 0 {
			t.Fatalf("outcome %v showed a notice", outcome)
		}
	}
}

func TestPamRequestNotifyRejectsNonUUID(t *testing.T) {
	for _, id := range []any{
		"not-a-uuid",
		"",
		"4000000A-0000-4000-8000-00000000000A", // upper-case hex is not canonical
		"{" + pamNotifyTestRequestID + "}",
		"urn:uuid:" + pamNotifyTestRequestID,
		strings.ReplaceAll(pamNotifyTestRequestID, "-", ""),
		" " + pamNotifyTestRequestID,
		nil,
		42,
	} {
		h, rec := trackedNotifyHeartbeat(t)
		result := handlePamRequestNotify(h, pamNotifyCommand(map[string]any{
			"requestId": id, "outcome": "expired",
		}))
		if result.Status != "failed" {
			t.Fatalf("requestId %v: result = %+v, want a refusal", id, result)
		}
		if len(rec.Calls()) != 0 {
			t.Fatalf("requestId %v showed a notice", id)
		}
	}
}

// The server must be able to tell which builds claim pam_request_notify: the
// capability is declared on Windows builds only, under the exact JSON key the
// heartbeat schema reads, and omitted elsewhere.
func TestHeartbeatDeclaresPamUserNotifyCapability(t *testing.T) {
	want := 0
	if runtime.GOOS == "windows" {
		want = 1
	}
	caps := compiledSecurityCapabilities()
	if caps.PamUserNotifyProtocolVersion != want {
		t.Fatalf("PamUserNotifyProtocolVersion = %d, want %d on %s", caps.PamUserNotifyProtocolVersion, want, runtime.GOOS)
	}

	body, err := json.Marshal(HeartbeatPayload{SecurityCapabilities: caps})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded struct {
		SecurityCapabilities map[string]any `json:"securityCapabilities"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	got, ok := decoded.SecurityCapabilities["pamUserNotifyProtocolVersion"]
	if want == 0 {
		if ok {
			t.Fatalf("pamUserNotifyProtocolVersion must be omitted off Windows, got %v", got)
		}
		return
	}
	if !ok || got != float64(1) {
		t.Fatalf("pamUserNotifyProtocolVersion = %v (present=%v), want 1", got, ok)
	}
}
