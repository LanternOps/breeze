package ipc

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestCallerVerifyWire(t *testing.T) {
	if TypeCallerVerifyRequest != "caller_verify_request" || TypeCallerVerifyResponse != "caller_verify_response" {
		t.Fatal("wire names changed")
	}

	var caps Capabilities
	if err := json.Unmarshal([]byte(`{"callerVerify":true}`), &caps); err != nil {
		t.Fatal(err)
	}
	if !caps.CallerVerify {
		t.Fatal("callerVerify capability lost in decode")
	}
	// An old helper never sends the field: it must read as false.
	var old Capabilities
	if err := json.Unmarshal([]byte(`{"canNotify":true,"canTray":true}`), &old); err != nil {
		t.Fatal(err)
	}
	if old.CallerVerify {
		t.Fatal("missing callerVerify must be false")
	}

	req := CallerVerifyRequest{
		VerificationID: "11111111-1111-4111-8111-111111111111", Username: `ACME\alex`,
		TechnicianName: "Sam", OrgName: "Acme", ActionLabel: "reset the password",
		TargetLabel: "alex@example.com", ReverseCode: "7319",
		Choices: []string{"42", "17", "86"}, TimeoutMs: 120000,
	}
	b, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(b, &decoded); err != nil {
		t.Fatal(err)
	}
	want := []string{"verificationId", "username", "technicianName", "orgName", "actionLabel", "targetLabel", "reverseCode", "choices", "timeoutMs"}
	if len(decoded) != len(want) {
		t.Fatalf("unexpected field count: %s", b)
	}
	for _, k := range want {
		if _, ok := decoded[k]; !ok {
			t.Fatalf("missing %q in %s", k, b)
		}
	}

	// #8668: the optional absolute deadline is forwarded verbatim when the API
	// sent one, and omitted otherwise (an old helper never sees a new key).
	req.DeadlineAt = "2026-10-16T12:00:00.000Z"
	b, _ = json.Marshal(req)
	decoded = map[string]any{}
	_ = json.Unmarshal(b, &decoded)
	if decoded["deadlineAt"] != "2026-10-16T12:00:00.000Z" || len(decoded) != len(want)+1 {
		t.Fatalf("deadlineAt not forwarded: %s", b)
	}
	var fromAPI CallerVerifyRequest
	if err := json.Unmarshal([]byte(`{"timeoutMs":30000,"deadlineAt":"2026-10-16T12:00:00+02:00"}`), &fromAPI); err != nil || fromAPI.DeadlineAt != "2026-10-16T12:00:00+02:00" {
		t.Fatalf("deadlineAt decode: %v %+v", err, fromAPI)
	}

	resp, err := json.Marshal(CallerVerifyResponse{Choice: "not_me", HelperVersion: "1.2.3"})
	if err != nil {
		t.Fatal(err)
	}
	if string(resp) != `{"choice":"not_me","helperVersion":"1.2.3"}` {
		t.Fatalf("response wire changed: %s", resp)
	}
}

func validCallerVerifyRequest() CallerVerifyRequest {
	return CallerVerifyRequest{
		VerificationID: "11111111-1111-4111-8111-111111111111", Username: "alex",
		TechnicianName: "Sam", OrgName: "Acme", ActionLabel: "reset the password",
		TargetLabel: "alex@example.com", ReverseCode: "7319",
		Choices: []string{"42", "17", "86"}, TimeoutMs: 30000,
	}
}

func TestCallerVerifyRequestValidate(t *testing.T) {
	ok := validCallerVerifyRequest()
	if err := ok.Validate(); err != nil {
		t.Fatalf("valid request rejected: %v", err)
	}
	// 320 multi-byte characters is within the shared limit.
	wide := validCallerVerifyRequest()
	wide.TargetLabel = strings.Repeat("é", 320)
	if err := wide.Validate(); err != nil {
		t.Fatalf("320-character label rejected: %v", err)
	}
	for name, mutate := range map[string]func(*CallerVerifyRequest){
		"bad id":          func(r *CallerVerifyRequest) { r.VerificationID = "v" },
		"no user":         func(r *CallerVerifyRequest) { r.Username = " " },
		"short timeout":   func(r *CallerVerifyRequest) { r.TimeoutMs = 29999 },
		"long timeout":    func(r *CallerVerifyRequest) { r.TimeoutMs = 300001 },
		"two choices":     func(r *CallerVerifyRequest) { r.Choices = []string{"42", "17"} },
		"four choices":    func(r *CallerVerifyRequest) { r.Choices = []string{"42", "17", "86", "11"} },
		"dup choice":      func(r *CallerVerifyRequest) { r.Choices = []string{"42", "42", "86"} },
		"one-digit":       func(r *CallerVerifyRequest) { r.Choices = []string{"4", "17", "86"} },
		"reserved choice": func(r *CallerVerifyRequest) { r.Choices = []string{"not_me", "17", "86"} },
		"reverse code":    func(r *CallerVerifyRequest) { r.ReverseCode = "73a9" },
		"no technician":   func(r *CallerVerifyRequest) { r.TechnicianName = "" },
		"long label":      func(r *CallerVerifyRequest) { r.TargetLabel = strings.Repeat("a", 321) },
		"bad deadline":    func(r *CallerVerifyRequest) { r.DeadlineAt = "tomorrow" },
		"date-only":       func(r *CallerVerifyRequest) { r.DeadlineAt = "2026-10-16" },
	} {
		r := validCallerVerifyRequest()
		mutate(&r)
		if r.Validate() == nil {
			t.Errorf("%s: accepted invalid request", name)
		}
	}
}

func TestCallerVerifyRequestWithDeadlineValidates(t *testing.T) {
	for _, d := range []string{"2026-10-16T12:00:00.000Z", "2026-10-16T12:00:00Z", "2026-10-16T14:00:00+02:00"} {
		r := validCallerVerifyRequest()
		r.DeadlineAt = d
		if err := r.Validate(); err != nil {
			t.Errorf("%s rejected: %v", d, err)
		}
	}
}

// #8668: the countdown is min(timeoutMs, deadlineAt - now + skew) and the card
// is refused once that is not positive. The deadline never extends timeoutMs.
func TestCallerVerifyCountdown(t *testing.T) {
	now := time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)
	at := func(d time.Duration) string { return now.Add(d).Format(time.RFC3339Nano) }
	for _, tc := range []struct {
		name     string
		deadline string
		want     time.Duration
		show     bool
	}{
		{name: "no deadline (older API)", deadline: "", want: 30 * time.Second, show: true},
		{name: "deadline beyond timeout never extends it", deadline: at(10 * time.Minute), want: 30 * time.Second, show: true},
		{name: "late delivery clamps", deadline: at(20 * time.Second), want: 25 * time.Second, show: true},
		{name: "other offset, same instant", deadline: now.Add(20 * time.Second).In(time.FixedZone("x", 2*3600)).Format(time.RFC3339), want: 25 * time.Second, show: true},
		{name: "just past, within skew allowance", deadline: at(-3 * time.Second), want: 2 * time.Second, show: true},
		{name: "past by exactly the allowance", deadline: at(-CallerVerifyDeadlineSkew), want: 0, show: false},
		{name: "long past", deadline: at(-time.Hour), want: 0, show: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := validCallerVerifyRequest()
			r.DeadlineAt = tc.deadline
			got, show := r.Countdown(now)
			if got != tc.want || show != tc.show {
				t.Fatalf("Countdown = %s,%v want %s,%v", got, show, tc.want, tc.show)
			}
		})
	}
}

func TestCallerVerifyAnswerAllowed(t *testing.T) {
	req := validCallerVerifyRequest()
	for _, c := range []string{"42", "17", "86", "not_me", "timeout"} {
		if !req.AnswerAllowed(c) {
			t.Errorf("%q should be allowed", c)
		}
	}
	for _, c := range []string{"", "99", "allow", "approve", "42 "} {
		if req.AnswerAllowed(c) {
			t.Errorf("%q must not be allowed", c)
		}
	}
}
