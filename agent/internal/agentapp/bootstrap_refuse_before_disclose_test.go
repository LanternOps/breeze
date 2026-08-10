package agentapp

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/breeze-rmm/agent/internal/hostpolicy"
)

// TestRunBootstrapNeverDisclosesTokenToNonAllowlistedHost is the end-to-end
// guard for the "refuse before disclosing" constraint: a hosted build must
// reject a non-allowlisted control-plane host BEFORE the single-use bootstrap
// token is transmitted to it.
//
// The unit tests around gateBootstrapServer prove the gate function returns an
// error. They do NOT prove the gate runs first. Reordering the gate to sit
// after redeemBootstrapToken, or dropping the osExit(1)/return, would leave
// every one of those tests green while the token is handed to an attacker's
// server — which is precisely the primitive this whole build mode exists to
// remove. So assert on the wire: zero requests reach the host.
//
// Mirrors the hit-counter pattern in TestRunBootstrapSkipsRedeemWhenAlreadyEnrolled.
func TestRunBootstrapNeverDisclosesTokenToNonAllowlistedHost(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")
	// Deliberately NOT enrolled (no agent_id): an already-enrolled config
	// short-circuits before the gate, which would pass this test vacuously.
	if err := os.WriteFile(cfgPath, []byte(
		"log_file: "+filepath.ToSlash(filepath.Join(dir, "agent.log"))+"\n",
	), 0o600); err != nil {
		t.Fatal(err)
	}

	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1) // any request here means the token left the process
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	// Hosted build. The httptest server listens on 127.0.0.1, which is not on
	// this allowlist, so it stands in for the attacker-run control plane.
	restore := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restore()

	origCfg, origData, origQuiet := cfgFile, bootstrapInstallData, quietEnroll
	t.Cleanup(func() { cfgFile, bootstrapInstallData, quietEnroll = origCfg, origData, origQuiet })
	cfgFile, quietEnroll = cfgPath, true
	bootstrapInstallData = `C:\dl\breeze-agent.msi|TESTTOKEN1|` + srv.URL

	var exitCode atomic.Int32
	exitCode.Store(-1)
	origExit := osExit
	osExit = func(code int) { exitCode.Store(int32(code)) }
	t.Cleanup(func() { osExit = origExit })

	runBootstrap()

	if n := hits.Load(); n != 0 {
		t.Errorf("bootstrap token was sent to a non-allowlisted host: %d request(s) reached it", n)
	}
	if c := exitCode.Load(); c != 1 {
		t.Errorf("hosted bootstrap against a non-allowlisted host: osExit = %d, want 1 (hard refuse)", c)
	}
}

// TestRunBootstrapSelfHostStillReachesTheServer is the companion regression
// guard: the repo-default self-host build must be completely unrestricted, so
// the SAME setup that is refused above must still reach the server. Without
// this, the test above would keep passing if the gate started refusing every
// host in every build — breaking every self-hosted install on the planet.
func TestRunBootstrapSelfHostStillReachesTheServer(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")
	if err := os.WriteFile(cfgPath, []byte(
		"log_file: "+filepath.ToSlash(filepath.Join(dir, "agent.log"))+"\n",
	), 0o600); err != nil {
		t.Fatal(err)
	}

	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusForbidden) // fail the redeem; we only care that it was attempted
	}))
	defer srv.Close()

	// No SetAllowedHostsForTest call: this is the repo default (self-host).
	if hostpolicy.Enforced() {
		t.Fatal("repo default must be self-host (empty allowlist); hostpolicy.Enforced() is true")
	}

	origCfg, origData, origQuiet := cfgFile, bootstrapInstallData, quietEnroll
	t.Cleanup(func() { cfgFile, bootstrapInstallData, quietEnroll = origCfg, origData, origQuiet })
	cfgFile, quietEnroll = cfgPath, true
	bootstrapInstallData = `C:\dl\breeze-agent.msi|TESTTOKEN1|` + srv.URL

	origExit := osExit
	osExit = func(code int) {} // redeem will fail against the 403; swallow the exit
	t.Cleanup(func() { osExit = origExit })

	runBootstrap()

	if n := hits.Load(); n == 0 {
		t.Error("self-host build did not contact the configured server: the host gate is not inert by default")
	}
}
