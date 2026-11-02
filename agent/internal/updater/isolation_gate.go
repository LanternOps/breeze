package updater

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
)

// ErrUpdateBlockedByIsolation means isolation forbids the update's destination
// or its artifact lacks the signed verification required during containment.
var ErrUpdateBlockedByIsolation = errors.New("update blocked by network isolation")

type isolationGate struct{ active func() bool }

var currentIsolationGate atomic.Pointer[isolationGate]

// SetIsolationGate installs the agent's isolation-state provider. A nil provider
// disables the gate. The provider must itself be safe for concurrent calls.
func SetIsolationGate(active func() bool) {
	if active == nil {
		currentIsolationGate.Store(nil)
		return
	}
	currentIsolationGate.Store(&isolationGate{active: active})
}

func isolationActive() bool {
	gate := currentIsolationGate.Load()
	return gate != nil && gate.active()
}

// isolationAuthority compares DNS names case-insensitively and normalizes
// explicit/default numeric ports. Schemes remain constrained to HTTP(S).
func isolationAuthority(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Hostname() == "" {
		return ""
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return ""
	}
	port := u.Port()
	if port == "" {
		if scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return ""
	}
	return net.JoinHostPort(strings.ToLower(u.Hostname()), strconv.Itoa(n))
}

func (u *Updater) checkIsolationURL(raw string) error {
	if !isolationActive() {
		return nil
	}
	authority := isolationAuthority(raw)
	if authority == "" {
		return ErrUpdateBlockedByIsolation
	}
	if authority == isolationAuthority(u.serverURL()) {
		return nil
	}
	if u.config != nil && authority == isolationAuthority(u.config.BackupServerURL) {
		return nil
	}
	return ErrUpdateBlockedByIsolation
}

type isolationTransport struct {
	updater *Updater
	base    http.RoundTripper
}

func (t isolationTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if err := t.updater.checkIsolationURL(req.URL.String()); err != nil {
		return nil, err
	}
	return t.base.RoundTrip(req)
}

// artifactRequest preserves the existing client and its netpolicy transport,
// including redirect credential stripping. The copy adds a fresh gate check
// before each hop, including when isolation starts during a download chain.
func (u *Updater) artifactRequest(req *http.Request) (*http.Response, error) {
	if err := u.checkClient(); err != nil {
		return nil, err
	}
	if err := u.checkIsolationURL(req.URL.String()); err != nil {
		return nil, err
	}
	client := *u.client
	transport := client.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	client.Transport = isolationTransport{updater: u, base: transport}
	redirect := client.CheckRedirect
	client.CheckRedirect = func(next *http.Request, via []*http.Request) error {
		if err := u.checkIsolationURL(next.URL.String()); err != nil {
			return err
		}
		if redirect != nil {
			return redirect(next, via)
		}
		if len(via) >= 10 {
			return errors.New("stopped after 10 redirects")
		}
		return nil
	}
	return client.Do(req)
}

// verifyIsolationSize is also called immediately before the first mutation:
// isolation may have started after the download began. Legacy manifests with
// no signed size remain supported only outside containment.
func verifyIsolationSize(path string, signedSize int64) error {
	if !isolationActive() {
		return nil
	}
	if signedSize <= 0 || signedSize > maxUpdateBinaryBytes {
		return fmt.Errorf("%w: artifact requires a signed size", ErrUpdateBlockedByIsolation)
	}
	stat, err := os.Stat(path)
	if err != nil {
		return err
	}
	if stat.Size() != signedSize {
		return fmt.Errorf("%w: artifact size does not match signed size", ErrChecksumMismatch)
	}
	return nil
}

// BinaryPair carries no signed metadata. Until its provenance can be checked
// here, containment refuses companion swaps even if the caller staged them.
func checkIsolationCompanions(opts UpdateOptions) error {
	if isolationActive() && (opts.UserHelper != nil || opts.Backup != nil) {
		return fmt.Errorf("%w: companion artifacts have no signed verification metadata", ErrUpdateBlockedByIsolation)
	}
	return nil
}

// checkIsolationInstall runs at the swap boundary, after potentially slow
// backup/package work. A nil manifest denotes the unsigned dev-update path.
// Rehashing also detects a staged file changed since its initial verification.
func (u *Updater) checkIsolationInstall(path string, manifest *updateManifest, opts UpdateOptions) error {
	if !isolationActive() {
		return nil
	}
	if manifest == nil {
		return ErrUpdateBlockedByIsolation
	}
	if err := checkIsolationCompanions(opts); err != nil {
		return err
	}
	if err := verifyIsolationSize(path, manifest.Size); err != nil {
		return err
	}
	return u.verifyChecksum(path, manifest.Checksum)
}
