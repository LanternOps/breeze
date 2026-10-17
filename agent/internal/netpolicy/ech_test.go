package netpolicy

import (
	"errors"
	"net/http"
	"testing"

	"github.com/breeze-rmm/agent/internal/ech/echtest"
)

const echTestHost = "updates.example.com"

// The updater (self-update, helper and backup-helper downloads) talks to the
// control plane through this client. Behind an SNI filter the control plane is
// reachable only over ECH, so a ControlPlaneDownload client must make its TLS
// dial through the shared ECH dialer — and that dial's TCP leg must still be
// the policy dialer (one validated resolution), not the ECH dialer's own.
func TestControlPlaneDownloadDialsTLSThroughECHWithPolicyTCP(t *testing.T) {
	rig := echtest.Start(t, echTestHost, okHandler())
	res, rec := newStubResolver(), &dialRecorder{to: rig.Addr}
	res.set(echTestHost, publicAddrs(t, "203.0.113.10"))
	c := mustClient(t, testPolicy(res, rec))
	baseTransport(t, c).TLSClientConfig.RootCAs = rig.Pool

	status, _, err := get(c, rig.URL("/api/v1/agents/download/linux/amd64"))
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200 (421 = TLS dial did not use ECH)", status)
	}
	if want := []string{"203.0.113.10:443"}; !equalStrings(rec.dialed(), want) {
		t.Fatalf("policy dialer dialed %v, want %v (TCP leg bypassed the policy)", rec.dialed(), want)
	}
	if baseTransport(t, c).Proxy != nil {
		t.Fatal("Proxy must stay nil: download clients ignore HTTP(S)_PROXY")
	}
}

// Address enforcement still applies on the ECH path: the rig's own TCP
// fallback would happily connect, so only the policy dialer can refuse this.
func TestControlPlaneDownloadECHPathStillRejectsUnsafeAddress(t *testing.T) {
	rig := echtest.Start(t, echTestHost, okHandler())
	res, rec := newStubResolver(), &dialRecorder{to: rig.Addr}
	res.set(echTestHost, publicAddrs(t, "169.254.169.254"))
	c := mustClient(t, testPolicy(res, rec))
	baseTransport(t, c).TLSClientConfig.RootCAs = rig.Pool

	_, _, err := get(c, rig.URL("/agent"))
	var pe *PolicyError
	if !errors.As(err, &pe) || pe.Reason != ReasonForbiddenAddress {
		t.Fatalf("err = %v, want PolicyError %s", err, ReasonForbiddenAddress)
	}
	if len(rec.dialed()) != 0 {
		t.Fatalf("dialed %v; an unsafe answer must never be connected", rec.dialed())
	}
}

// Managed-software downloads target vendor and customer origins, never the
// control plane, and keep the plain TLS dial.
func TestManagedSoftwareDownloadKeepsPlainTLSDial(t *testing.T) {
	echtest.Start(t, echTestHost, okHandler())
	res, rec := newStubResolver(), &dialRecorder{}
	p := testPolicy(res, rec)
	p.Purpose = ManagedSoftwareDownload
	if baseTransport(t, mustClient(t, p)).DialTLSContext != nil {
		t.Fatal("managed-software client must not use the ECH dialer")
	}
}
