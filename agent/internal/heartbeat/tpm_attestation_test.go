package heartbeat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/go-tpm/tpm2/transport"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/tpmattest"
)

// #8318 T1: the TPM part of the hardware send. The TPM flow itself is
// tested in internal/tpmattest (simulator: -tags tpmsim; a real TPM: -tags tpmreal).

func noTPM() (transport.TPMCloser, error) { return nil, tpmattest.ErrNoTPM }

func TestHardwareReportSaysThereIsNoTPM(t *testing.T) {
	server, received := captureHardwarePUT(t)
	h := newMemoryHWTestHeartbeat(server.URL)
	h.tpmEnabled.Store(true)
	h.tpmOpen = noTPM
	h.sendHardwareInventory()
	got := awaitHardware(t, received)
	if string(got["tpmAvailable"]) != "false" {
		t.Fatalf("tpmAvailable = %s, want false", got["tpmAvailable"])
	}
}

func TestHardwareReportOmitsTPMAvailableWhenTheProbeCannotTell(t *testing.T) {
	server, received := captureHardwarePUT(t)
	h := newMemoryHWTestHeartbeat(server.URL)
	h.tpmEnabled.Store(true)
	h.tpmOpen = func() (transport.TPMCloser, error) { return nil, errors.New("permission denied") }
	h.sendHardwareInventory()
	got := awaitHardware(t, received)
	if _, present := got["tpmAvailable"]; present {
		t.Fatalf("tpmAvailable sent although unknown: %s", got["tpmAvailable"])
	}
}

func TestMaybeAttestTPMRunsOnlyForAUsableTPMNotAttestedLately(t *testing.T) {
	h := NewWithVersion(&config.Config{AgentID: "agent-1", AuthToken: "token", ServerURL: "http://127.0.0.1:1"}, "1.2.3", nil, nil)
	h.tpmEnabled.Store(true)
	var opens atomic.Int32
	h.tpmOpen = func() (transport.TPMCloser, error) { opens.Add(1); return nil, tpmattest.ErrNoTPM }
	no, yes := false, true

	h.maybeAttestTPM(nil)
	h.maybeAttestTPM(&no)
	h.tpmAttestedAt.Store(time.Now().Unix())
	h.maybeAttestTPM(&yes)
	waitIdle(t, h)
	if n := opens.Load(); n != 0 {
		t.Fatalf("attested %d times; none expected", n)
	}

	h.tpmAttestedAt.Store(time.Now().Add(-tpmReattestAfter - time.Hour).Unix())
	h.maybeAttestTPM(&yes)
	waitIdle(t, h)
	if n := opens.Load(); n != 1 {
		t.Fatalf("attested %d times; one expected after the re-attest interval", n)
	}
}

func waitIdle(t *testing.T, h *Heartbeat) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for h.tpmAttestInFlight.Load() {
		if time.Now().After(deadline) {
			t.Fatal("attestation still in flight")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestTPMAttestationAPISpeaksTheRouteContract(t *testing.T) {
	var completeBody map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer token" {
			t.Errorf("Authorization = %q", r.Header.Get("Authorization"))
		}
		body, _ := io.ReadAll(r.Body)
		switch r.URL.Path {
		case "/api/v1/agents/agent-1/attestation/challenge":
			var req map[string]string
			if err := json.Unmarshal(body, &req); err != nil || req["ekPublic"] != "AQI=" || req["akPublic"] != "AwQ=" {
				t.Errorf("challenge body = %s", body)
			}
			_, _ = w.Write([]byte(`{"challengeId":"11111111-1111-4111-8111-111111111111","credentialBlob":"BQY=","encryptedSecret":"Bwg=","expiresInSeconds":300}`))
		case "/api/v1/agents/agent-1/attestation/complete":
			_ = json.Unmarshal(body, &completeBody)
			_, _ = w.Write([]byte(`{"attested":true,"baseline":"recorded"}`))
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	h := NewWithVersion(&config.Config{AgentID: "agent-1", AuthToken: "token", ServerURL: server.URL}, "1.2.3", nil, nil)
	api := tpmAttestationAPI{h: h}

	challenge, err := api.Challenge(context.Background(), []byte{1, 2}, []byte{3, 4})
	if err != nil {
		t.Fatal(err)
	}
	if challenge.ID != "11111111-1111-4111-8111-111111111111" || !bytes.Equal(challenge.CredentialBlob, []byte{5, 6}) || !bytes.Equal(challenge.EncryptedSecret, []byte{7, 8}) {
		t.Fatalf("challenge = %+v", challenge)
	}
	if err := api.Complete(context.Background(), challenge.ID, []byte{9}); err != nil {
		t.Fatal(err)
	}
	if completeBody["challengeId"] != challenge.ID || completeBody["secret"] != "CQ==" {
		t.Fatalf("complete body = %v", completeBody)
	}
}

func TestTPMAttestationAPIReportsARefusalByCode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"The EK is not the RSA-2048 default template","code":"TPM_EK_REFUSED","reason":"ek_policy"}`))
	}))
	t.Cleanup(server.Close)
	h := NewWithVersion(&config.Config{AgentID: "agent-1", AuthToken: "token", ServerURL: server.URL}, "1.2.3", nil, nil)
	_, err := tpmAttestationAPI{h: h}.Challenge(context.Background(), []byte{1}, []byte{2})
	if err == nil || !strings.Contains(err.Error(), "TPM_EK_REFUSED ek_policy") {
		t.Fatalf("err = %v", err)
	}
}

func TestTheSwitchOffMeansNoTPMIsTouched(t *testing.T) {
	server, received := captureHardwarePUT(t)
	h := newMemoryHWTestHeartbeat(server.URL)
	var opens atomic.Int32
	h.tpmOpen = func() (transport.TPMCloser, error) { opens.Add(1); return nil, tpmattest.ErrNoTPM }
	h.sendHardwareInventory()
	got := awaitHardware(t, received)
	if _, present := got["tpmAvailable"]; present {
		t.Fatalf("tpmAvailable sent while the switch is off: %s", got["tpmAvailable"])
	}
	yes := true
	h.tpmAttestedAt.Store(0)
	h.maybeAttestTPM(&yes)
	waitIdle(t, h)
	if n := opens.Load(); n != 0 {
		t.Fatalf("the TPM was opened %d times while the switch is off", n)
	}
}

func TestTheServerSwitchTurnsAttestationOnAndOff(t *testing.T) {
	h := NewWithVersion(&config.Config{AgentID: "agent-1", AuthToken: "token", ServerURL: "http://127.0.0.1:1"}, "1.2.3", nil, nil)
	opened := make(chan struct{}, 4)
	h.tpmOpen = func() (transport.TPMCloser, error) { opened <- struct{}{}; return nil, tpmattest.ErrNoTPM }

	h.applyTPMAttestationConfig("maybe")
	if h.tpmEnabled.Load() {
		t.Fatal("an unrecognized payload turned the switch on")
	}
	h.applyTPMAttestationConfig(true)
	if !h.tpmEnabled.Load() {
		t.Fatal("true did not turn the switch on")
	}
	// Turning it on probes right away instead of waiting for the next hardware send.
	select {
	case <-opened:
	case <-time.After(5 * time.Second):
		t.Fatal("turning the switch on did not probe the TPM")
	}
	h.applyTPMAttestationConfig("false")
	if h.tpmEnabled.Load() {
		t.Fatal(`"false" did not turn the switch off`)
	}
}

func TestAHungTPMIsAbandonedAndNotCalledAgainUntilItReturns(t *testing.T) {
	restore := tpmProbeTimeout
	tpmProbeTimeout = 50 * time.Millisecond
	t.Cleanup(func() { tpmProbeTimeout = restore })

	h := NewWithVersion(&config.Config{AgentID: "agent-1", AuthToken: "token", ServerURL: "http://127.0.0.1:1"}, "1.2.3", nil, nil)
	h.tpmEnabled.Store(true)
	release := make(chan struct{})
	var opens atomic.Int32
	h.tpmOpen = func() (transport.TPMCloser, error) {
		opens.Add(1)
		<-release
		return nil, tpmattest.ErrNoTPM
	}

	start := time.Now()
	if got := h.tpmAvailability(); got != nil {
		t.Fatalf("a hung probe reported %v", *got)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("the probe waited %s for a hung TPM", elapsed)
	}
	// The stuck call still holds the TPM: nothing new starts.
	if got := h.tpmAvailability(); got != nil {
		t.Fatalf("a second probe reported %v", *got)
	}
	if n := opens.Load(); n != 1 {
		t.Fatalf("the TPM was opened %d times while a call was stuck; want 1", n)
	}

	close(release)
	deadline := time.Now().Add(5 * time.Second)
	for h.tpmBusy.Load() {
		if time.Now().After(deadline) {
			t.Fatal("the abandoned call never released the TPM")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if got := h.tpmAvailability(); got == nil || *got {
		t.Fatalf("after the stuck call returned, the probe = %v; want false", got)
	}
}

func TestADeferredRouteCreatesNoKeys(t *testing.T) {
	h := NewWithVersion(&config.Config{AgentID: "agent-1", AuthToken: "token", ServerURL: "http://127.0.0.1:1"}, "1.2.3", nil, nil)
	h.tpmEnabled.Store(true)
	var opens atomic.Int32
	h.tpmOpen = func() (transport.TPMCloser, error) { opens.Add(1); return nil, tpmattest.ErrNoTPM }
	h.loopDefer.Record(loopKey("POST", h.attestationURL("challenge")), retryAtErr(time.Now().Add(time.Minute)))

	yes := true
	h.maybeAttestTPM(&yes)
	waitIdle(t, h)
	if n := opens.Load(); n != 0 {
		t.Fatalf("the TPM was opened %d times for a route the server is deferring", n)
	}
}
