package ipc

import (
	"encoding/json"
	"testing"
)

func TestHelperAssistConstants(t *testing.T) {
	if HelperRoleAssist != "assist" {
		t.Fatalf("HelperRoleAssist = %q, want \"assist\"", HelperRoleAssist)
	}
	if HelperBinaryAssistHelper != "assist_helper" {
		t.Fatalf("HelperBinaryAssistHelper = %q, want \"assist_helper\"", HelperBinaryAssistHelper)
	}
	if TypeHelperTokenUpdate != "helper_token_update" {
		t.Fatalf("TypeHelperTokenUpdate = %q, want \"helper_token_update\"", TypeHelperTokenUpdate)
	}
}

func TestHelperTokenUpdateRoundTrip(t *testing.T) {
	in := HelperTokenUpdate{Token: "brz_abc", ExpiresAt: "2026-06-01T00:00:00Z"}
	b, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	var out HelperTokenUpdate
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	if out != in {
		t.Fatalf("round-trip mismatch: %+v != %+v", out, in)
	}
	b2, _ := json.Marshal(HelperTokenUpdate{Token: "brz_x"})
	if string(b2) != `{"token":"brz_x"}` {
		t.Fatalf("omitempty failed: %s", b2)
	}
}

func TestConsentRequestRoundTrip(t *testing.T) {
	in := ConsentRequest{SessionID: "s1", TechnicianName: "Jordan Lee", TimeoutMs: 30000, OnTimeout: "proceed"}
	b, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	var out ConsentRequest
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	if out.OnTimeout != "proceed" || out.TimeoutMs != 30000 {
		t.Fatalf("round-trip mismatch: %+v", out)
	}
}

func TestPamDialogMessagesRoundTrip(t *testing.T) {
	req := PamRequestDialog{
		ExePath:        `C:\Windows\System32\cmd.exe`,
		Signer:         "Microsoft Windows",
		Hash:           "abc123",
		SubjectUser:    `ACME\alice`,
		CommandLine:    `cmd.exe /c whoami`,
		Reason:         "Install approved update",
		IntentSummary:  "Run a privileged command shell",
		TimeoutSeconds: 30,
	}

	reqBytes, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	var reqOut PamRequestDialog
	if err := json.Unmarshal(reqBytes, &reqOut); err != nil {
		t.Fatal(err)
	}
	if reqOut != req {
		t.Fatalf("request round-trip mismatch: %+v != %+v", reqOut, req)
	}

	result := PamDialogResult{Approved: true, Reason: "approved", DismissedByUser: false}
	resultBytes, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	var resultOut PamDialogResult
	if err := json.Unmarshal(resultBytes, &resultOut); err != nil {
		t.Fatal(err)
	}
	if resultOut != result {
		t.Fatalf("result round-trip mismatch: %+v != %+v", resultOut, result)
	}

	if TypePamRequestDialog != "pam_request_dialog" {
		t.Fatalf("TypePamRequestDialog = %q, want pam_request_dialog", TypePamRequestDialog)
	}
	if TypePamDialogResult != "pam_dialog_result" {
		t.Fatalf("TypePamDialogResult = %q, want pam_dialog_result", TypePamDialogResult)
	}
	if ScopePam != "pam" {
		t.Fatalf("ScopePam = %q, want pam", ScopePam)
	}
	if ScopeConsentUI != "consent_ui" {
		t.Fatalf("ScopeConsentUI = %q, want consent_ui", ScopeConsentUI)
	}
}

func TestPamDismissConsentMessagesRoundTrip(t *testing.T) {
	if TypePamDismissConsent != "pam_dismiss_consent" {
		t.Fatalf("TypePamDismissConsent = %q, want pam_dismiss_consent", TypePamDismissConsent)
	}
	if TypePamDismissConsentResult != "pam_dismiss_consent_result" {
		t.Fatalf("TypePamDismissConsentResult = %q, want pam_dismiss_consent_result", TypePamDismissConsentResult)
	}

	request := PamDismissConsentRequest{DeadlineUnixMs: 1784221200123}
	requestBytes, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	if string(requestBytes) != `{"deadlineUnixMs":1784221200123}` {
		t.Fatalf("request JSON = %s", requestBytes)
	}
	var requestOut PamDismissConsentRequest
	if err := json.Unmarshal(requestBytes, &requestOut); err != nil {
		t.Fatal(err)
	}
	if requestOut != request {
		t.Fatalf("request round-trip mismatch: %+v != %+v", requestOut, request)
	}

	result := PamDismissConsentResult{
		Success:       true,
		Reason:        "dismissed",
		DetailMessage: "consent process terminated",
	}
	resultBytes, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if string(resultBytes) != `{"success":true,"reason":"dismissed","detailMessage":"consent process terminated"}` {
		t.Fatalf("result JSON = %s", resultBytes)
	}
	var resultOut PamDismissConsentResult
	if err := json.Unmarshal(resultBytes, &resultOut); err != nil {
		t.Fatal(err)
	}
	if resultOut != result {
		t.Fatalf("result round-trip mismatch: %+v != %+v", resultOut, result)
	}

	withoutDetail, err := json.Marshal(PamDismissConsentResult{Success: false, Reason: "not_found"})
	if err != nil {
		t.Fatal(err)
	}
	if string(withoutDetail) != `{"success":false,"reason":"not_found"}` {
		t.Fatalf("omitempty failed: %s", withoutDetail)
	}
}
