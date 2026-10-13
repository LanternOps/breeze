package ipc

import (
	"encoding/json"
	"testing"
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
	} {
		r := validCallerVerifyRequest()
		mutate(&r)
		if r.Validate() == nil {
			t.Errorf("%s: accepted invalid request", name)
		}
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
