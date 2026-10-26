package heartbeat

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

func canonical(t *testing.T, raw []byte) string {
	t.Helper()
	var v any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&v); err != nil {
		t.Fatal(err)
	}
	out, _ := json.Marshal(v)
	return string(out)
}

// The heartbeat halves of the prompt-host golden fixtures round-trip through
// the agent's types (packages/shared/src/fixtures/prompt-host).
func TestHeartbeatPromptHostFixturesRoundTrip(t *testing.T) {
	for _, name := range []string{"heartbeat.prompt_host.json", "heartbeat.prompt_host.empty.json"} {
		raw, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "shared", "src", "fixtures", "prompt-host", name))
		if err != nil {
			t.Fatal(err)
		}
		var fx struct {
			Telemetry json.RawMessage `json:"telemetry"`
			Settings  json.RawMessage `json:"settings"`
		}
		if err := json.Unmarshal(raw, &fx); err != nil {
			t.Fatal(err)
		}
		var tel promptHostTelemetry
		var set PromptHostSettings
		if err := json.Unmarshal(fx.Telemetry, &tel); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(fx.Settings, &set); err != nil {
			t.Fatal(err)
		}
		telOut, _ := json.Marshal(tel)
		setOut, _ := json.Marshal(set)
		if canonical(t, telOut) != canonical(t, fx.Telemetry) || canonical(t, setOut) != canonical(t, fx.Settings) {
			t.Fatalf("%s: round trip changed\n tel %s vs %s\n set %s vs %s", name, telOut, fx.Telemetry, setOut, fx.Settings)
		}
	}
	// A telemetry block built in code always carries kinds, even when empty.
	out, _ := json.Marshal(promptTelemetryFrom(fakeRendererInfo{protocol: 1, version: "0.2.0"}))
	if !bytes.Contains(out, []byte(`"kinds":[]`)) {
		t.Fatalf("telemetry = %s; kinds must be [] not null", out)
	}
}

func TestHeartbeatAbsentPromptHostMeansEmpty(t *testing.T) {
	var resp HeartbeatResponse
	if err := json.Unmarshal([]byte(`{"commands":[]}`), &resp); err != nil {
		t.Fatal(err)
	}
	if got := enabledPromptKinds(&resp); got == nil || len(got) != 0 {
		t.Fatalf("absent block = %#v, want an empty (non-nil) list: fail to legacy", got)
	}
	if err := json.Unmarshal([]byte(`{"commands":[],"promptHost":{"enabledKinds":["notice.info","restart.prompt@1"]}}`), &resp); err != nil {
		t.Fatal(err)
	}
	if got := enabledPromptKinds(&resp); len(got) != 2 || got[0] != "notice.info" || got[1] != "restart.prompt@1" {
		t.Fatalf("enabledKinds = %v", got)
	}
	if got := enabledPromptKinds(nil); len(got) != 0 {
		t.Fatalf("no response = %v", got)
	}
}

type fakeRendererInfo struct {
	protocol int
	kinds    []string
	version  string
}

func (f fakeRendererInfo) PromptProtocol() int     { return f.protocol }
func (f fakeRendererInfo) PromptKindAds() []string { return f.kinds }
func (f fakeRendererInfo) RendererVersion() string { return f.version }

func TestHeartbeatTelemetryReportsConsoleAssistAdvertisement(t *testing.T) {
	// The off-console Assist connects last (the broker's "best" session), so
	// only the console filter picks the right one.
	console := newHelperProbe(t, ipc.HelperRoleAssist, "bob", "1", []string{ipc.ScopeAssist})
	time.Sleep(5 * time.Millisecond)
	offConsole := newHelperProbe(t, ipc.HelperRoleAssist, "alice", "2", []string{ipc.ScopeAssist})
	offConsole.session.ApplyPromptAuthForTest(ipc.HelperRoleAssist, ipc.AuthRequest{PromptProtocolVersion: 1, PromptKinds: []string{"notice.info@1"}, RendererVersion: "0.1.9"})
	console.session.ApplyPromptAuthForTest(ipc.HelperRoleAssist, ipc.AuthRequest{PromptProtocolVersion: 1, PromptKinds: []string{"restart.prompt@1"}, RendererVersion: "0.2.0"})
	h, _ := newMessagingHeartbeat(t, offConsole.session, console.session) // console = session 1

	got := h.promptHostTelemetry()
	if got == nil || got.ProtocolVersion != 1 || got.RendererVersion != "0.2.0" || len(got.Kinds) != 1 || got.Kinds[0] != "restart.prompt@1" {
		t.Fatalf("telemetry = %+v, want the console session's Assist", got)
	}

	// A pre-contract Assist in the console session is reported as protocol 0.
	old := newHelperProbe(t, ipc.HelperRoleAssist, "carol", "1", []string{ipc.ScopeAssist})
	ho, _ := newMessagingHeartbeat(t, old.session)
	if got := ho.promptHostTelemetry(); got == nil || got.ProtocolVersion != 0 || got.Kinds == nil || len(got.Kinds) != 0 {
		t.Fatalf("old Assist telemetry = %+v", got)
	}

	// No Assist in the console session: nothing.
	native := newHelperProbe(t, ipc.HelperRoleUser, "dave", "1", []string{"notify"})
	hn, _ := newMessagingHeartbeat(t, native.session)
	if got := hn.promptHostTelemetry(); got != nil {
		t.Fatalf("telemetry without a console Assist = %+v, want nil", got)
	}
	empty := &Heartbeat{}
	if empty.promptHostTelemetry() != nil {
		t.Fatal("no broker: want nil")
	}
	_ = sessionbroker.ErrPromptScopeMissing
}
