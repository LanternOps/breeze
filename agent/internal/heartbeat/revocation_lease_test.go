package heartbeat

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
)

// testRevocationLeasePayload is the `revocationLease` block a current API ships
// inside start_desktop. Shared by every handler test that drives a start.
func testRevocationLeasePayload() map[string]any {
	return map[string]any{
		"token":         "lease-token",
		"expiresAt":     float64(time.Now().Add(time.Minute).UnixMilli()),
		"hardDeadline":  float64(time.Now().Add(8 * time.Hour).UnixMilli()),
		"renewEverySec": float64(25),
		"graceSec":      float64(90),
	}
}

func TestParseRevocationLease(t *testing.T) {
	now := time.Now()

	tests := []struct {
		name    string
		payload map[string]any
		wantNil bool
		check   func(t *testing.T, lease *desktop.RevocationLease)
	}{
		{
			name:    "absent block yields no lease so the caller can refuse the start",
			payload: map[string]any{},
			wantNil: true,
		},
		{
			name: "block with no expiry cannot be kept alive, so it is no lease at all",
			payload: map[string]any{"revocationLease": map[string]any{
				"token": "t", "renewEverySec": float64(25),
			}},
			wantNil: true,
		},
		{
			name: "block with no renew cadence is refused",
			payload: map[string]any{"revocationLease": map[string]any{
				"token":     "t",
				"expiresAt": float64(now.Add(time.Minute).UnixMilli()),
			}},
			wantNil: true,
		},
		{
			name: "full block decodes verbatim",
			payload: map[string]any{"revocationLease": map[string]any{
				"token":         "tok",
				"expiresAt":     float64(now.Add(time.Minute).UnixMilli()),
				"hardDeadline":  float64(now.Add(4 * time.Hour).UnixMilli()),
				"renewEverySec": float64(25),
				"graceSec":      float64(90),
			}},
			check: func(t *testing.T, lease *desktop.RevocationLease) {
				if lease.Token != "tok" {
					t.Fatalf("token = %q", lease.Token)
				}
				if lease.RenewEvery != 25*time.Second {
					t.Fatalf("renewEvery = %v", lease.RenewEvery)
				}
				if lease.Grace != 90*time.Second {
					t.Fatalf("grace = %v", lease.Grace)
				}
				if got := lease.HardDeadline.Sub(now).Round(time.Minute); got != 4*time.Hour {
					t.Fatalf("hardDeadline = %v from now", got)
				}
			},
		},
		{
			name: "missing hard deadline falls back to the local 12h cap, never to none",
			payload: map[string]any{"revocationLease": map[string]any{
				"expiresAt":     float64(now.Add(time.Minute).UnixMilli()),
				"renewEverySec": float64(25),
			}},
			check: func(t *testing.T, lease *desktop.RevocationLease) {
				if lease.HardDeadline.IsZero() {
					t.Fatal("hardDeadline must never be zero")
				}
				if got := lease.HardDeadline.Sub(now).Round(time.Minute); got != desktop.MaxSessionDurationCap {
					t.Fatalf("hardDeadline = %v from now, want the 12h cap", got)
				}
			},
		},
		{
			name: "missing grace falls back to the 90s default",
			payload: map[string]any{"revocationLease": map[string]any{
				"expiresAt":     float64(now.Add(time.Minute).UnixMilli()),
				"renewEverySec": float64(25),
			}},
			check: func(t *testing.T, lease *desktop.RevocationLease) {
				if lease.Grace != defaultRevocationLeaseGrace {
					t.Fatalf("grace = %v", lease.Grace)
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			lease := parseRevocationLease(tt.payload)
			if tt.wantNil {
				if lease != nil {
					t.Fatalf("expected no lease, got %+v", lease)
				}
				return
			}
			if lease == nil {
				t.Fatal("expected a lease, got nil")
			}
			if tt.check != nil {
				tt.check(t, lease)
			}
		})
	}
}

// The two decoders must agree on the 12h cap. This is the parity test the
// "0 = unlimited" split cost us: the map decoder treated 0 as "no limit" while
// the IPC decoder left the default in place, so the same policy produced two
// different session ceilings depending on which path a host took.
func TestDecoderParityOnMaxDuration(t *testing.T) {
	tests := []struct {
		name  string
		hours int
		want  time.Duration
	}{
		{"zero is the cap, not unlimited", 0, desktop.MaxSessionDurationCap},
		{"over-cap clamps down", 168, desktop.MaxSessionDurationCap},
		{"exactly the cap is kept", 12, desktop.MaxSessionDurationCap},
		{"policy may shorten", 4, 4 * time.Hour},
		{"negative is the cap", -5, desktop.MaxSessionDurationCap},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mapPolicy := parseDesktopSessionPolicy(map[string]any{
				"maxSessionDurationHours": float64(tt.hours),
				"revocationLease":         testRevocationLeasePayload(),
			})
			ipcPolicy := desktop.ResolveSessionPolicyFromIPC(ipc.DesktopStartRequest{
				MaxSessionDurationHours: tt.hours,
			})
			if mapPolicy.MaxDuration != tt.want {
				t.Errorf("map decoder MaxDuration = %v, want %v", mapPolicy.MaxDuration, tt.want)
			}
			if ipcPolicy.MaxDuration != tt.want {
				t.Errorf("IPC decoder MaxDuration = %v, want %v", ipcPolicy.MaxDuration, tt.want)
			}
			if mapPolicy.MaxDuration != ipcPolicy.MaxDuration {
				t.Errorf("decoders disagree: map=%v ipc=%v", mapPolicy.MaxDuration, ipcPolicy.MaxDuration)
			}
		})
	}
}

func TestStartDesktopRefusesWithoutRevocationLease(t *testing.T) {
	h := &Heartbeat{desktopMgr: desktop.NewSessionManager()}

	result := handleStartDesktop(h, Command{
		ID:   "cmd-nolease",
		Type: "start_desktop",
		Payload: map[string]any{
			"sessionId": "sess-nolease",
			"offer":     "test-offer",
		},
	})

	if result.Status != "failed" {
		t.Fatalf("status = %q, want failed", result.Status)
	}
	if result.Error != desktop.ErrRevocationLeaseRequired.Error() {
		t.Fatalf("error = %q, want %q", result.Error, desktop.ErrRevocationLeaseRequired.Error())
	}
}

// The API refuses to start a remote desktop session against an agent reporting
// revocationLeaseProtocolVersion 0, so a build that renews leases MUST declare
// the capability on every beat — and under the exact JSON key the server's
// heartbeat schema reads.
func TestHeartbeatDeclaresRevocationLeaseCapability(t *testing.T) {
	caps := compiledSecurityCapabilities()
	if caps.RevocationLeaseProtocolVersion != 1 {
		t.Fatalf("RevocationLeaseProtocolVersion = %d, want 1", caps.RevocationLeaseProtocolVersion)
	}

	body, err := json.Marshal(HeartbeatPayload{SecurityCapabilities: caps})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded struct {
		SecurityCapabilities map[string]any `json:"securityCapabilities"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	got, ok := decoded.SecurityCapabilities["revocationLeaseProtocolVersion"]
	if !ok {
		t.Fatalf("revocationLeaseProtocolVersion key missing: %v", decoded.SecurityCapabilities)
	}
	if got != float64(1) {
		t.Fatalf("revocationLeaseProtocolVersion = %v, want 1", got)
	}
}

// The two lease decoders must agree on EVERY field, not just max duration.
// They did not: the map decoder refused a lease with no expiry or no renew
// cadence and back-filled the hard deadline and grace, while the IPC decoder
// accepted an all-zero block verbatim — which produces a lease whose expiry,
// deadline and grace are all zero, i.e. one the watchdog can never enforce and
// never renew. A helper start carrying that block was an unrevokable session.
func TestRevocationLeaseDecoderParity(t *testing.T) {
	now := time.Now()
	expiresAt := now.Add(time.Minute).UnixMilli()
	hardDeadline := now.Add(4 * time.Hour).UnixMilli()

	tests := []struct {
		name     string
		wire     ipc.RevocationLease
		wantNil  bool
		validate func(t *testing.T, lease *desktop.RevocationLease)
	}{
		{
			name:    "all-zero block is not a lease",
			wire:    ipc.RevocationLease{},
			wantNil: true,
		},
		{
			name:    "no expiry is not a lease",
			wire:    ipc.RevocationLease{Token: "t", RenewEverySec: 25},
			wantNil: true,
		},
		{
			name:    "no renew cadence is not a lease",
			wire:    ipc.RevocationLease{Token: "t", ExpiresAtUnixMs: expiresAt},
			wantNil: true,
		},
		{
			name:    "negative renew cadence is not a lease",
			wire:    ipc.RevocationLease{Token: "t", ExpiresAtUnixMs: expiresAt, RenewEverySec: -25},
			wantNil: true,
		},
		{
			name: "missing hard deadline back-fills the 12h cap",
			wire: ipc.RevocationLease{Token: "t", ExpiresAtUnixMs: expiresAt, RenewEverySec: 25},
			validate: func(t *testing.T, lease *desktop.RevocationLease) {
				if lease.HardDeadline.IsZero() {
					t.Fatal("hardDeadline must never be zero")
				}
				if got := lease.HardDeadline.Sub(now).Round(time.Minute); got != desktop.MaxSessionDurationCap {
					t.Fatalf("hardDeadline = %v from now, want the 12h cap", got)
				}
			},
		},
		{
			name: "missing grace back-fills 90s",
			wire: ipc.RevocationLease{Token: "t", ExpiresAtUnixMs: expiresAt, RenewEverySec: 25},
			validate: func(t *testing.T, lease *desktop.RevocationLease) {
				if lease.Grace != defaultRevocationLeaseGrace {
					t.Fatalf("grace = %v, want %v", lease.Grace, defaultRevocationLeaseGrace)
				}
			},
		},
		{
			name: "full block decodes verbatim",
			wire: ipc.RevocationLease{
				Token:              "tok",
				ExpiresAtUnixMs:    expiresAt,
				HardDeadlineUnixMs: hardDeadline,
				RenewEverySec:      25,
				GraceSec:           90,
			},
			validate: func(t *testing.T, lease *desktop.RevocationLease) {
				if lease.Token != "tok" {
					t.Fatalf("token = %q", lease.Token)
				}
				if lease.RenewEvery != 25*time.Second || lease.Grace != 90*time.Second {
					t.Fatalf("renewEvery = %v, grace = %v", lease.RenewEvery, lease.Grace)
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Map-payload decoder (direct-mode start_desktop from the API).
			raw := map[string]any{}
			if tt.wire.Token != "" {
				raw["token"] = tt.wire.Token
			}
			if tt.wire.ExpiresAtUnixMs != 0 {
				raw["expiresAt"] = float64(tt.wire.ExpiresAtUnixMs)
			}
			if tt.wire.HardDeadlineUnixMs != 0 {
				raw["hardDeadline"] = float64(tt.wire.HardDeadlineUnixMs)
			}
			if tt.wire.RenewEverySec != 0 {
				raw["renewEverySec"] = float64(tt.wire.RenewEverySec)
			}
			if tt.wire.GraceSec != 0 {
				raw["graceSec"] = float64(tt.wire.GraceSec)
			}
			fromMap := parseRevocationLease(map[string]any{"revocationLease": raw})

			// IPC decoder (helper-hosted start).
			wire := tt.wire
			fromIPC := desktop.ResolveSessionPolicyFromIPC(ipc.DesktopStartRequest{
				RevocationLease: &wire,
			}).RevocationLease

			if tt.wantNil {
				if fromMap != nil {
					t.Errorf("map decoder accepted an unusable lease: %+v", fromMap)
				}
				if fromIPC != nil {
					t.Errorf("IPC decoder accepted an unusable lease: %+v", fromIPC)
				}
				return
			}
			if fromMap == nil || fromIPC == nil {
				t.Fatalf("decoders disagree on acceptance: map=%v ipc=%v", fromMap != nil, fromIPC != nil)
			}
			if fromMap.Token != fromIPC.Token ||
				fromMap.RenewEvery != fromIPC.RenewEvery ||
				fromMap.Grace != fromIPC.Grace {
				t.Errorf("decoders disagree: map=%+v ipc=%+v", fromMap, fromIPC)
			}
			if d := fromMap.ExpiresAt.Sub(fromIPC.ExpiresAt); d > time.Second || d < -time.Second {
				t.Errorf("decoders disagree on expiry by %v", d)
			}
			if d := fromMap.HardDeadline.Sub(fromIPC.HardDeadline); d > time.Second || d < -time.Second {
				t.Errorf("decoders disagree on hard deadline by %v", d)
			}
			tt.validate(t, fromMap)
			tt.validate(t, fromIPC)
		})
	}
}
