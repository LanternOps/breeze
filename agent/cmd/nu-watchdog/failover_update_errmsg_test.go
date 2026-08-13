package main

import (
	"errors"
	"net/url"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/netpolicy"
)

// Finding I5 of the wave-06 whole-branch review: doUpdateAgent/doUpdateWatchdog
// redacted their JOURNAL line with SafeDownloadErrorFields and then returned the
// raw error, which handleFailoverCommand assigned straight into errMsg —
// SubmitCommandResult puts that in body["error"] and POSTs it to the
// command-result endpoint, so it lands in device_commands and the UI. That was
// the only one of the four download-error consumers where the error leaves the
// box, and net/http's *url.Error message repeats the full URL of the failed hop
// (the presigned CDN URL after a redirect).
func TestFailoverUpdateErrMsgNeverCarriesTheDownloadURL(t *testing.T) {
	const secretURL = "https://cdn.example/nu-agent?X-Amz-Signature=CAPABILITY-SECRET"

	leaks := func(t *testing.T, msg string) {
		t.Helper()
		for _, forbidden := range []string{secretURL, "cdn.example", "CAPABILITY-SECRET", "X-Amz-Signature"} {
			if strings.Contains(msg, forbidden) {
				t.Fatalf("command-result error leaked %q: %q", forbidden, msg)
			}
		}
	}

	t.Run("ordinary transport failure", func(t *testing.T) {
		err := &url.Error{Op: "Get", URL: secretURL, Err: errors.New("dial tcp: i/o timeout")}
		// Setup invariant: the RAW error really does carry the URL, so this test
		// would have failed against the pre-fix `errMsg = err.Error()`.
		if !strings.Contains(err.Error(), "CAPABILITY-SECRET") {
			t.Fatal("test setup broken: url.Error.Error() should carry the URL")
		}
		msg := failoverUpdateErrMsg(err)
		leaks(t, msg)
		if msg == "" {
			t.Fatal("message is empty; the operator needs some diagnostic")
		}
	})

	t.Run("policy rejection", func(t *testing.T) {
		err := &url.Error{Op: "Get", URL: secretURL,
			Err: &netpolicy.PolicyError{Reason: netpolicy.ReasonForbiddenAddress}}
		msg := failoverUpdateErrMsg(err)
		leaks(t, msg)
		if !strings.Contains(msg, netpolicy.ReasonForbiddenAddress) {
			t.Fatalf("message = %q, want it to name the bounded reason %q", msg, netpolicy.ReasonForbiddenAddress)
		}
	})

	t.Run("wrapped one level deeper", func(t *testing.T) {
		// updater.UpdateTo wraps its download failures, so the *url.Error is
		// rarely the outermost error at this call site.
		inner := &url.Error{Op: "Get", URL: secretURL, Err: errors.New("connection refused")}
		msg := failoverUpdateErrMsg(errors.Join(errors.New("update agent"), inner))
		leaks(t, msg)
	})
}
