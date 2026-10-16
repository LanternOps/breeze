package watchdoginstall

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/netpolicy"
	"github.com/breeze-rmm/agent/internal/updater"
)

type fakeNetErr struct{}

func (fakeNetErr) Error() string   { return "dial tcp: i/o timeout" }
func (fakeNetErr) Timeout() bool   { return true }
func (fakeNetErr) Temporary() bool { return true }

var _ net.Error = fakeNetErr{}

func TestClassify(t *testing.T) {
	cases := []struct {
		name      string
		err       error
		class     ErrorClass
		permanent bool
	}{
		{"checksum", fmt.Errorf("checksum verification failed: %w", updater.ErrChecksumMismatch), ClassChecksum, true},
		{"manifest sig", fmt.Errorf("x: %w", updater.ErrManifestSignature), ClassSignature, true},
		{"manifest key", fmt.Errorf("x: %w", updater.ErrManifestKey), ClassSignature, true},
		{"untrusted release", fmt.Errorf("%w: reason", updater.ErrUntrustedRelease), ClassSignature, true},
		{"code signature", fmt.Errorf("%w: detail", updater.ErrCodeSignatureInvalid), ClassSignature, true},
		{"policy", &netpolicy.PolicyError{Reason: "redirect_refused"}, ClassPolicy, true},
		{"policy wrapped in url.Error", &url.Error{Op: "Get", URL: "https://x", Err: &netpolicy.PolicyError{Reason: "private_address"}}, ClassPolicy, true},
		{"dev build", ErrDevBuild, ClassDevBuild, true},
		{"unsupported os", ErrUnsupportedOS, ClassUnsupportedOS, true},
		{"timeout", &url.Error{Op: "Get", URL: "https://x", Err: context.DeadlineExceeded}, ClassNetwork, false},
		{"net error", fakeNetErr{}, ClassNetwork, false},
		{"url eof", &url.Error{Op: "Get", URL: "https://x", Err: io.EOF}, ClassNetwork, false},
		{"http 503", &updater.HTTPStatusError{Code: 503}, ClassServer, false},
		{"http 429", &updater.HTTPStatusError{Code: 429}, ClassServer, false},
		{"http 404", &updater.HTTPStatusError{Code: 404}, ClassUnknown, false},
		{"locked file", updater.ErrFileLocked, ClassLocked, false},
		{"lock held", ErrLockHeld, ClassLocked, false},
		{"read-only fs", updater.ErrReadOnlyFS, ClassInstallCmd, false},
		{"install command", fmt.Errorf("%w: exit status 1", ErrInstallCommand), ClassInstallCmd, false},
		{"plain unknown", errors.New("boom"), ClassUnknown, false},
		{"nil", nil, ClassUnknown, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, p := Classify(tc.err)
			if c != tc.class || p != tc.permanent {
				t.Fatalf("got (%s,%v) want (%s,%v)", c, p, tc.class, tc.permanent)
			}
		})
	}
}

// Classify's output must never contain a URL or error text.
func TestClassifyNeverEchoesErrorText(t *testing.T) {
	c, _ := Classify(&url.Error{Op: "Get", URL: "https://secret.example/x?cap=abc", Err: io.EOF})
	if strings.Contains(string(c), "secret") || strings.Contains(string(c), "cap=") {
		t.Fatal("leaked")
	}
	if !c.Valid() {
		t.Fatalf("class %q not in the closed set", c)
	}
}

func TestErrorClassValidIsClosedSet(t *testing.T) {
	for _, c := range AllErrorClasses() {
		if !c.Valid() {
			t.Fatalf("%q should be valid", c)
		}
	}
	if ErrorClass("https://x").Valid() || ErrorClass("").Valid() {
		t.Fatal("arbitrary strings must not be valid classes")
	}
	if len(AllErrorClasses()) != 10 {
		t.Fatalf("closed set drifted: %d", len(AllErrorClasses()))
	}
}
