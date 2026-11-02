package heartbeat

import (
	"encoding/json"
	"errors"
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

// pamNotifyResultBody decodes the handler's success payload.
func pamNotifyResultBody(t *testing.T, result tools.CommandResult) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal([]byte(result.Stdout), &body); err != nil {
		t.Fatalf("result stdout %q is not JSON: %v", result.Stdout, err)
	}
	return body
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
		Body:       "Contoso IT denied the request for mmc.exe.\nReason: Use the self-service portal. Call us if it is urgent.",
		WinSession: "5",
	}
	if calls := rec.Calls(); len(calls) != 1 || calls[0] != want {
		t.Fatalf("notices = %+v, want [%+v]", calls, want)
	}
	if body := pamNotifyResultBody(t, result); body["shown"] != true || body["notShownReason"] != nil {
		t.Fatalf("result body = %+v, want shown:true and no notShownReason", body)
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
			want := pamNotifyCall{Title: "Request denied", Body: "Contoso IT denied the request for mmc.exe.", WinSession: "5"}
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
		Body:       "Your request for mmc.exe expired before Contoso IT answered.",
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
// with no support name uses the generic "your IT support team" sentence.
func TestPamRequestNotifyUsesTrackerNamesWithITFallback(t *testing.T) {
	h := &Heartbeat{}
	rec := recordPamNotices(h)
	h.rememberSupportName("Fabrikam Support") // cache must not leak into a tracked entry
	h.pamTracker().MarkAwaiting(pamNotifyTestRequestID, "3", "setup.exe", "")
	result := handlePamRequestNotify(h, pamNotifyCommand(map[string]any{
		"requestId": pamNotifyTestRequestID, "outcome": "expired",
	}))
	if result.Status != "completed" {
		t.Fatalf("result = %+v", result)
	}
	want := pamNotifyCall{
		Title:      "Request expired",
		Body:       "Your request for setup.exe expired before your IT support team answered.",
		WinSession: "3",
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

// A tracked notice whose send fails (no helper in the session, pipe error)
// must not be reported as shown: the result says shown:false with the reason.
// The command still completes (the server never retries it) and the entry is
// still removed, because the server's outcome is final.
func TestPamRequestNotifyReportsNotShownWhenSendFails(t *testing.T) {
	for _, tc := range []struct {
		err    error
		reason string
	}{
		{errNoticeNoNotifyHelper, "no_notify_helper"},
		{errNoticeNoSessionBroker, "no_session_broker"},
		{errors.New("pipe closed"), "send_failed"},
	} {
		t.Run(tc.reason, func(t *testing.T) {
			h, rec := trackedNotifyHeartbeat(t)
			rec.FailWith(tc.err)
			result := handlePamRequestNotify(h, pamNotifyCommand(map[string]any{
				"requestId": pamNotifyTestRequestID, "outcome": "denied", "reason": "no",
			}))
			if result.Status != "completed" {
				t.Fatalf("result = %+v", result)
			}
			body := pamNotifyResultBody(t, result)
			if body["shown"] != false || body["notShownReason"] != tc.reason {
				t.Fatalf("result body = %+v, want shown:false notShownReason:%s", body, tc.reason)
			}
			if rec.Attempts() != 1 || len(rec.Calls()) != 0 {
				t.Fatalf("attempts=%d shown=%+v", rec.Attempts(), rec.Calls())
			}
			if _, ok := h.pamTracker().Get(pamNotifyTestRequestID); ok {
				t.Fatal("the outcome is final: the entry must be removed even when the notice failed")
			}
		})
	}
}

// An untracked request reports why nothing was shown.
func TestPamRequestNotifyUntrackedReportsReason(t *testing.T) {
	h := &Heartbeat{}
	_ = recordPamNotices(h)
	result := handlePamRequestNotify(h, pamNotifyCommand(map[string]any{
		"requestId": pamNotifyTestRequestID, "outcome": "expired",
	}))
	body := pamNotifyResultBody(t, result)
	if body["shown"] != false || body["notShownReason"] != "not_tracked" {
		t.Fatalf("result body = %+v, want shown:false notShownReason:not_tracked", body)
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
