package storagesession

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// b2DownloadCapBody is the body Backblaze B2's S3-compatible API answered a
// GET with once the account's download bandwidth / Class B cap was reached
// (#12623, observed by the reporter).
const b2DownloadCapBody = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Error>
    <Code>AccessDenied</Code>
    <Message>Cannot download file, download bandwidth or transaction (Class B) cap exceeded. See the Caps &amp; Alerts page to increase your cap.</Message>
</Error>`

// capMessageWords are pieces of the provider's text that must never reach an
// error, whatever the reason token says.
var capMessageWords = []string{"Cannot download", "bandwidth", "Class B", "Caps", "Alerts", "increase your cap", "Usage cap"}

func assertNoMessageLeak(t *testing.T, msg string) {
	t.Helper()
	for _, leak := range capMessageWords {
		if strings.Contains(msg, leak) {
			t.Fatalf("error %q leaks the provider's message text %q", msg, leak)
		}
	}
}

func readCloser(s string) io.ReadCloser { return io.NopCloser(strings.NewReader(s)) }

func errorDoc(inner string) string { return `<Error>` + inner + `</Error>` }

func TestReadStoreErrorReason(t *testing.T) {
	cases := []struct {
		name       string
		body       string
		wantCode   string
		wantReason string
	}{
		{"b2 download cap", b2DownloadCapBody, "AccessDenied", storeReasonProviderCapExceeded},
		{"b2 native usage cap wording", errorDoc(`<Code>AccessDenied</Code><Message>Usage cap exceeded.</Message>`), "AccessDenied", storeReasonProviderCapExceeded},
		{"b2 native transaction cap wording", errorDoc(`<Code>AccessDenied</Code><Message>Transaction cap exceeded. Daily transaction caps apply to non-paying accounts.</Message>`), "AccessDenied", storeReasonProviderCapExceeded},
		{"b2 storage cap wording", errorDoc(`<Code>AccessDenied</Code><Message>Cannot upload files, storage cap exceeded.</Message>`), "AccessDenied", storeReasonProviderCapExceeded},
		{"mixed case", errorDoc(`<Code>AccessDenied</Code><Message>STORAGE Cap EXCEEDED</Message>`), "AccessDenied", storeReasonProviderCapExceeded},
		{"line break inside the phrase", errorDoc("<Code>AccessDenied</Code><Message>download cap\n   exceeded</Message>"), "AccessDenied", storeReasonProviderCapExceeded},
		{"message before code", errorDoc(`<Message>Usage cap exceeded.</Message><Code>AccessDenied</Code>`), "AccessDenied", storeReasonProviderCapExceeded},
		{"cap message without a code", errorDoc(`<Message>Usage cap exceeded.</Message>`), "", storeReasonProviderCapExceeded},
		{"ordinary access denied", errorDoc(`<Code>AccessDenied</Code><Message>Access Denied</Message>`), "AccessDenied", ""},
		{"message present, no match", s3ErrorBody("AccessDenied"), "AccessDenied", ""},
		{"no message", errorDoc(`<Code>AccessDenied</Code>`), "AccessDenied", ""},
		{"phrase inside a longer word", errorDoc(`<Code>AccessDenied</Code><Message>handicap exceeded</Message>`), "AccessDenied", ""},
		{"words apart", errorDoc(`<Code>AccessDenied</Code><Message>cap was exceeded</Message>`), "AccessDenied", ""},
		{"message not a direct child", errorDoc(`<Code>AccessDenied</Code><Detail><Message>Usage cap exceeded.</Message></Detail>`), "AccessDenied", ""},
		{"markup inside message", errorDoc(`<Code>AccessDenied</Code><Message>Usage <b>cap exceeded</b></Message>`), "AccessDenied", ""},
		{"message over its bound", errorDoc(`<Code>AccessDenied</Code><Message>cap exceeded ` + strings.Repeat("x", maxStoreErrorMessageBytes) + `</Message>`), "AccessDenied", ""},
		{"message past the read limit", errorDoc(`<Code>AccessDenied</Code><Pad>` + strings.Repeat("x", maxStoreErrorBodyBytes) + `</Pad><Message>Usage cap exceeded.</Message>`), "AccessDenied", ""},
		{"truncated after the message", `<Error><Code>AccessDenied</Code><Message>Usage cap exceeded.</Message><Req`, "AccessDenied", ""},
		{"unterminated message", `<Error><Code>AccessDenied</Code><Message>Usage cap exceeded.`, "AccessDenied", ""},
		{"malformed xml", `<Error><Code>AccessDenied</Code><Message>Usage cap exceeded.</Mess></Error>`, "AccessDenied", ""},
		{"root is not Error", `<Fault><Code>AccessDenied</Code><Message>Usage cap exceeded.</Message></Fault>`, "", ""},
		{"plain text", "Usage cap exceeded.", "", ""},
		{"undeclared entity", `<!DOCTYPE Error [<!ENTITY x "cap exceeded">]><Error><Code>AccessDenied</Code><Message>&x;</Message></Error>`, "AccessDenied", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			code, reason := readStoreError(strings.NewReader(tc.body))
			if code != tc.wantCode || reason != tc.wantReason {
				t.Fatalf("readStoreError = (%q, %q), want (%q, %q)", code, reason, tc.wantCode, tc.wantReason)
			}
		})
	}
}

// Only a 403 carries the cap reason: B2 refuses with 403, and a 5xx or 429
// stays on the transient path whatever its body says.
func TestStorageStatusErrorCapReasonOnlyOn403(t *testing.T) {
	for _, tc := range []struct {
		status     int
		wantReason string
	}{
		{http.StatusForbidden, storeReasonProviderCapExceeded},
		{http.StatusUnauthorized, ""},
		{http.StatusTooManyRequests, ""},
		{http.StatusServiceUnavailable, ""},
	} {
		t.Run(fmt.Sprint(tc.status), func(t *testing.T) {
			resp := &http.Response{StatusCode: tc.status, Header: http.Header{}, Body: readCloser(b2DownloadCapBody)}
			e := newStorageStatusError(resp)
			if e.reason != tc.wantReason {
				t.Fatalf("reason = %q, want %q", e.reason, tc.wantReason)
			}
			if e.code != "AccessDenied" {
				t.Fatalf("code = %q, want AccessDenied", e.code)
			}
		})
	}
}

func TestStorageStatusErrorAnswerCarriesReason(t *testing.T) {
	for _, tc := range []struct {
		e    storageStatusError
		want string
	}{
		{storageStatusError{status: 403, code: "AccessDenied", reason: storeReasonProviderCapExceeded}, "storage answered status 403 (AccessDenied, provider_cap_exceeded)"},
		{storageStatusError{status: 403, reason: storeReasonProviderCapExceeded}, "storage answered status 403 (provider_cap_exceeded)"},
		{storageStatusError{status: 403, code: "AccessDenied"}, "storage answered status 403 (AccessDenied)"},
		{storageStatusError{status: 403}, "storage answered status 403"},
	} {
		if got := tc.e.answer(); got != tc.want {
			t.Fatalf("answer = %q, want %q", got, tc.want)
		}
	}
}

// A capped store's refusal says why, keeps its S3 code for the code-based
// rules and logs, and carries none of the provider's text.
func TestWriteProviderCapRefusalCarriesReason(t *testing.T) {
	noSleep(t)
	b := newFakeWriteBackend(t)
	b.storageHook = func(w http.ResponseWriter, r *http.Request) bool {
		w.Header().Set("Content-Type", "application/xml")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(b2DownloadCapBody))
		return true
	}
	p := newTestWriteProvider(t, b, Options{})
	err := p.UploadContext(t.Context(), writeTempData(t, []byte("abc")), objKey("files/a"))
	if err == nil {
		t.Fatal("upload to a capped store succeeded")
	}
	if got, want := err.Error(), "storage session: storage answered status 403 (AccessDenied, provider_cap_exceeded)"; got != want {
		t.Fatalf("error = %q, want %q", got, want)
	}
	if got := providers.StoreErrorCode(err); got != "AccessDenied" {
		t.Fatalf("StoreErrorCode = %q, want AccessDenied", got)
	}
	assertNoMessageLeak(t, err.Error())
	assertNoResponseLeak(t, err.Error(), b)
}

// A cap refusal still counts toward the destination-refusal trip: a capped
// account refuses every request until the cap resets or is raised, so the
// run fails fast, and the destination error names the cap.
func TestWriteProviderCapRefusalsTripTheDestination(t *testing.T) {
	noSleep(t)
	b := newFakeWriteBackend(t)
	b.storageHook = func(w http.ResponseWriter, r *http.Request) bool {
		w.Header().Set("Content-Type", "application/xml")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(b2DownloadCapBody))
		return true
	}
	p := newTestWriteProvider(t, b, Options{})
	src := writeTempData(t, []byte("abc"))
	var last error
	for i := 0; i < destinationRefusalThreshold; i++ {
		last = p.UploadContext(t.Context(), src, objKey(fmt.Sprintf("files/f%03d", i)))
	}
	if !errors.Is(last, providers.ErrDestinationRefused) {
		t.Fatalf("last error = %v, want the destination error", last)
	}
	if got, want := last.Error(), "backup destination refused every request: storage answered status 403 (AccessDenied, provider_cap_exceeded)"; got != want {
		t.Fatalf("destination error = %q, want %q", got, want)
	}
	assertNoMessageLeak(t, last.Error())
}

// The read-only provider (restore, verify) carries the reason too: this is
// the reporter's restore path.
func TestStorageCapRefusalCarriesReason(t *testing.T) {
	st := newFakeStorage(t)
	cp := newFakeControlPlane(t, st)
	st.setHook(func(w http.ResponseWriter, r *http.Request) bool {
		w.Header().Set("Content-Type", "application/xml")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(b2DownloadCapBody))
		return true
	})
	p := newTestProvider(t, cp, testDescriptor(cp, time.Now()), Options{})
	err := p.Download("snapshots/s1/manifest.json", filepath.Join(t.TempDir(), "o"))
	if err == nil || err.Error() != "storage session: storage answered status 403 (AccessDenied, provider_cap_exceeded)" {
		t.Fatalf("error = %v, want the 403 with its code and the cap reason", err)
	}
	assertNoMessageLeak(t, err.Error())
}
