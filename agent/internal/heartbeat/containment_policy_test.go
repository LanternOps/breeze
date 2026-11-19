package heartbeat

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/isolation"
	"github.com/breeze-rmm/agent/internal/isolation/journal"
)

const containmentPolicyRevision = "c1:0123456789abcdef0123456789abcdef"

// containmentDesiredJSON is a desired block as the server sends it, with the
// policy's scope:"any" entries appended and a raw policyRevision (empty: absent).
func containmentDesiredJSON(t *testing.T, now time.Time, revision string, extras ...map[string]any) []byte {
	t.Helper()
	allow := []any{map[string]any{"kind": "host", "host": "control.example.test", "proto": "tcp", "ports": []any{443}, "scope": "breeze"}}
	for _, extra := range extras {
		allow = append(allow, extra)
	}
	b, err := json.Marshal(map[string]any{
		"isolationId": containmentID, "generation": 2, "desired": "isolated", "deadManSeconds": 0, "remoteRelay": false,
		"expiresAt": now.Add(time.Hour).Format(time.RFC3339Nano), "allow": allow,
	})
	if err != nil {
		t.Fatal(err)
	}
	if revision != "" {
		b = append(b[:len(b)-1], []byte(`,"policyRevision":`+revision+`}`)...)
	}
	return b
}

func containmentExtra(change func(map[string]any)) map[string]any {
	e := map[string]any{"kind": "cidr", "cidr": "203.0.113.0/24", "proto": "tcp", "ports": []any{8443}, "scope": "any"}
	if change != nil {
		change(e)
	}
	return e
}

func TestContainmentDesiredPolicyAcceptance(t *testing.T) {
	now := time.Now()
	valid := `"` + containmentPolicyRevision + `"`
	host := func(name string) map[string]any {
		return containmentExtra(func(e map[string]any) { delete(e, "cidr"); e["kind"] = "host"; e["host"] = name })
	}
	cidr := func(value string) map[string]any {
		return containmentExtra(func(e map[string]any) { e["cidr"] = value })
	}
	for _, tc := range []struct {
		name     string
		revision string
		extras   []map[string]any
		reason   isolation.PolicyRejectReason // empty: accepted
	}{
		{"valid revision", valid, []map[string]any{containmentExtra(nil)}, ""},
		{"valid revision, host entry", valid, []map[string]any{host("edr.example.test")}, ""},
		{"integer revision", `7`, []map[string]any{containmentExtra(nil)}, ""},
		{"valid revision, no policy entries", valid, nil, ""},
		{"no revision, no policy entries", "", nil, ""},
		{"missing revision", "", []map[string]any{containmentExtra(nil)}, isolation.PolicyRejectRevisionMissing},
		{"null revision", `null`, []map[string]any{containmentExtra(nil)}, isolation.PolicyRejectRevisionMissing},
		{"empty revision", `""`, []map[string]any{containmentExtra(nil)}, isolation.PolicyRejectRevisionMissing},
		{"blank revision", `"  "`, []map[string]any{containmentExtra(nil)}, isolation.PolicyRejectRevisionInvalid},
		{"zero revision", `0`, []map[string]any{containmentExtra(nil)}, isolation.PolicyRejectRevisionInvalid},
		{"negative revision", `-1`, []map[string]any{containmentExtra(nil)}, isolation.PolicyRejectRevisionInvalid},
		{"fractional revision", `1.5`, []map[string]any{containmentExtra(nil)}, isolation.PolicyRejectRevisionInvalid},
		{"boolean revision", `true`, []map[string]any{containmentExtra(nil)}, isolation.PolicyRejectRevisionInvalid},
		{"object revision", `{}`, []map[string]any{containmentExtra(nil)}, isolation.PolicyRejectRevisionInvalid},
		{"malformed revision, no policy entries", `true`, nil, isolation.PolicyRejectRevisionInvalid},
		{"one bad entry rejects the block: port", valid, []map[string]any{containmentExtra(nil), containmentExtra(func(e map[string]any) { e["ports"] = []any{0} })}, isolation.PolicyRejectSpecInvalid},
		{"one bad entry rejects the block: scope", valid, []map[string]any{containmentExtra(nil), containmentExtra(func(e map[string]any) { e["scope"] = "system" })}, isolation.PolicyRejectSpecInvalid},
		{"one bad entry rejects the block: proto", valid, []map[string]any{containmentExtra(nil), containmentExtra(func(e map[string]any) { e["proto"] = "icmp" })}, isolation.PolicyRejectSpecInvalid},
		{"zero prefix", valid, []map[string]any{cidr("0.0.0.0/0")}, isolation.PolicyRejectSpecInvalid},
		{"IPv6 zero prefix", valid, []map[string]any{cidr("::/0")}, isolation.PolicyRejectSpecInvalid},
		{"IPv4 wider than /8", valid, []map[string]any{cidr("198.0.0.0/7")}, isolation.PolicyRejectSpecInvalid},
		{"IPv6 wider than /32", valid, []map[string]any{cidr("2001:d00::/24")}, isolation.PolicyRejectSpecInvalid},
		{"IPv4 loopback", valid, []map[string]any{cidr("127.0.0.1/32")}, isolation.PolicyRejectSpecInvalid},
		{"this host", valid, []map[string]any{cidr("0.0.0.1/32")}, isolation.PolicyRejectSpecInvalid},
		{"IPv6 loopback", valid, []map[string]any{cidr("::1/128")}, isolation.PolicyRejectSpecInvalid},
		{"IPv4-mapped loopback", valid, []map[string]any{cidr("::ffff:127.0.0.1/128")}, isolation.PolicyRejectSpecInvalid},
		{"NAT64 loopback", valid, []map[string]any{cidr("64:ff9b::7f00:1/128")}, isolation.PolicyRejectSpecInvalid},
		{"localhost", valid, []map[string]any{host("localhost")}, isolation.PolicyRejectSpecInvalid},
		{"localhost subdomain", valid, []map[string]any{host("a.LOCALHOST")}, isolation.PolicyRejectSpecInvalid},
		{"hosts alias", valid, []map[string]any{host("ip6-loopback")}, isolation.PolicyRejectSpecInvalid},
		{"hex label", valid, []map[string]any{host("0x7f.0x1")}, isolation.PolicyRejectSpecInvalid},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var d isolation.Desired
			if err := json.Unmarshal(containmentDesiredJSON(t, now, tc.revision, tc.extras...), &d); err != nil {
				t.Fatalf("decode: %v", err)
			}
			err := validateContainmentDesired(&d, "https://control.example.test", now)
			if (err == nil) != (tc.reason == "") {
				t.Fatalf("validation error %v, want rejection %q", err, tc.reason)
			}
			if err != nil {
				if got := containmentPolicyRejection(&d); got != tc.reason {
					t.Fatalf("reason %q, want %q", got, tc.reason)
				}
			}
		})
	}
	t.Run("a block with no policy content is not a policy rejection", func(t *testing.T) {
		var d isolation.Desired
		if err := json.Unmarshal(containmentDesiredJSON(t, now, ""), &d); err != nil {
			t.Fatal(err)
		}
		d.Allow[0].Host = "relay.example.test"
		if validateContainmentDesired(&d, "https://control.example.test", now) == nil {
			t.Fatal("foreign control plane accepted")
		}
		if got := containmentPolicyRejection(&d); got != "" {
			t.Fatalf("reason %q", got)
		}
	})
	t.Run("the control plane must still be a Breeze-scoped permit", func(t *testing.T) {
		var d isolation.Desired
		if err := json.Unmarshal(containmentDesiredJSON(t, now, valid), &d); err != nil {
			t.Fatal(err)
		}
		d.Allow[0].Scope = isolation.ScopeAny
		if validateContainmentDesired(&d, "https://control.example.test", now) == nil {
			t.Fatal("a scope:any entry stood in for the control-plane permit")
		}
	})
	t.Run("a tombstone is never gated on a revision", func(t *testing.T) {
		d := isolation.Desired{Spec: isolation.Spec{IsolationID: containmentID, Generation: 2, PolicyRevision: "a b"}, Desired: isolation.DesiredReleased}
		if err := validateContainmentDesired(&d, "https://control.example.test", now); err != nil {
			t.Fatal(err)
		}
	})
}

// The isolate command holds the same line as the heartbeat: a present but
// malformed revision is refused even when no scope:"any" entry needs it.
func TestContainmentPayloadRefusesMalformedRevision(t *testing.T) {
	now := time.Now()
	for _, rev := range []any{true, 0, -1, 1.5, "a b", map[string]any{}} {
		p := containmentPayload(now)
		p["parameters"].(map[string]any)["policyRevision"] = rev
		if validateContainmentPayload(p, "https://control.example.test", now) == nil {
			t.Errorf("revision %v accepted", rev)
		}
	}
	for _, rev := range []any{nil, "", containmentPolicyRevision, 7} {
		p := containmentPayload(now)
		p["parameters"].(map[string]any)["policyRevision"] = rev
		if err := validateContainmentPayload(p, "https://control.example.test", now); err != nil {
			t.Errorf("revision %v refused: %v", rev, err)
		}
	}
}

// A malformed policyRevision must cost the containment block, never the response.
func TestContainmentMalformedRevisionKeepsHeartbeatResponse(t *testing.T) {
	block := containmentDesiredJSON(t, time.Now(), `{"nested":[1]}`, containmentExtra(nil))
	raw := `{"commands":[{"id":"c1","type":"script"}],"containment":{"networkIsolation":` + string(block) + `}}`
	var response HeartbeatResponse
	if err := json.Unmarshal([]byte(raw), &response); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(response.Commands) != 1 {
		t.Fatalf("commands %+v", response.Commands)
	}
	if err := validateContainmentDesired(response.Containment.NetworkIsolation, "https://control.example.test", time.Now()); err == nil {
		t.Fatal("malformed revision accepted")
	}
}

// reconcileContainment queues a rejection before it returns.
func takeContainmentRejection(t *testing.T, rt *containmentRuntime) containmentRejection {
	t.Helper()
	select {
	case got := <-rt.rejected:
		return got
	default:
		t.Fatal("no rejection was queued")
		return containmentRejection{}
	}
}

func TestReconcileContainmentRoutesPolicyRejection(t *testing.T) {
	now := time.Now()
	server := &config.Config{ServerURL: "https://control.example.test"}
	decode := func(t *testing.T, raw []byte) *isolation.DesiredBlock {
		t.Helper()
		var d isolation.Desired
		if err := json.Unmarshal(raw, &d); err != nil {
			t.Fatal(err)
		}
		return &isolation.DesiredBlock{NetworkIsolation: &d}
	}
	t.Run("rejected: journalled on the worker, never reconciled", func(t *testing.T) {
		f := &containmentFake{rejections: make(chan containmentRejection, 1)}
		rt := newContainmentRuntime(f)
		h := &Heartbeat{config: server, containment: rt}
		h.reconcileContainment(decode(t, containmentDesiredJSON(t, now, "", containmentExtra(nil))))
		if len(rt.desired) != 0 {
			t.Fatal("a rejected block was queued for the manager")
		}
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		go rt.run(ctx, nil)
		select {
		case got := <-f.rejections:
			if got != (containmentRejection{isolationID: containmentID, generation: 2, reason: isolation.PolicyRejectRevisionMissing}) {
				t.Fatalf("rejection %+v", got)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("the rejection never reached the manager")
		}
		if f.reconciles.Load() != 0 {
			t.Fatal("a rejected block reached Reconcile")
		}
	})
	t.Run("accepted: queued with its revision", func(t *testing.T) {
		rt := newContainmentRuntime(&containmentFake{})
		h := &Heartbeat{config: server, containment: rt}
		h.reconcileContainment(decode(t, containmentDesiredJSON(t, now, `"`+containmentPolicyRevision+`"`, containmentExtra(nil))))
		select {
		case got := <-rt.desired:
			if got.NetworkIsolation.PolicyRevision != containmentPolicyRevision || len(got.NetworkIsolation.Allow) != 2 {
				t.Fatalf("queued %+v", got.NetworkIsolation)
			}
		default:
			t.Fatal("an accepted block was not queued")
		}
		if len(rt.rejected) != 0 {
			t.Fatal("an accepted block recorded a rejection")
		}
	})
	t.Run("a rejection does not displace a pending assertion", func(t *testing.T) {
		rt := newContainmentRuntime(&containmentFake{})
		h := &Heartbeat{config: server, containment: rt}
		pending := decode(t, containmentDesiredJSON(t, now, ""))
		h.reconcileContainment(pending)
		h.reconcileContainment(decode(t, containmentDesiredJSON(t, now, "", containmentExtra(nil))))
		select {
		case got := <-rt.desired:
			if got != pending {
				t.Fatalf("pending assertion replaced by %+v", got)
			}
		default:
			t.Fatal("the pending assertion is gone")
		}
		if len(rt.rejected) != 1 {
			t.Fatal("rejection not recorded")
		}
	})
	t.Run("a block with no policy content is only logged", func(t *testing.T) {
		rt := newContainmentRuntime(&containmentFake{})
		h := &Heartbeat{config: server, containment: rt}
		block := decode(t, containmentDesiredJSON(t, now, ""))
		block.NetworkIsolation.Allow[0].Host = "relay.example.test"
		h.reconcileContainment(block)
		if len(rt.desired) != 0 || len(rt.rejected) != 0 {
			t.Fatal("an invalid non-policy block was acted on")
		}
	})
	t.Run("a capability-0 agent journals nothing", func(t *testing.T) {
		dir := t.TempDir()
		m := isolation.NewManager(isolation.ManagerDeps{DataDir: dir})
		rt := newContainmentRuntime(m)
		h := &Heartbeat{config: server, containment: rt}
		h.reconcileContainment(decode(t, containmentDesiredJSON(t, now, "", containmentExtra(nil))))
		got := takeContainmentRejection(t, rt)
		m.NotePolicyRejected(context.Background(), got.isolationID, got.generation, got.reason)
		if _, err := os.Stat(journal.Path(dir)); !os.IsNotExist(err) {
			t.Fatalf("journal written at capability 0: %v", err)
		}
		if b, _ := json.Marshal(m.Report()); string(b) != `{"journalSeq":0,"phase":"none"}` {
			t.Fatalf("report %s", b)
		}
	})
	t.Run("a held episode journals the reason and keeps its rules", func(t *testing.T) {
		dir := t.TempDir()
		j := journal.New()
		j.Phase = journal.PhaseCommitted
		j.Episode = &journal.EpisodeRecord{IsolationID: containmentID, Generation: 2, ExpiresAt: now.Add(time.Hour), State: isolation.StateVerified, PolicyRevision: containmentPolicyRevision, PolicyGeneration: 2}
		if err := journal.Save(journal.Path(dir), j); err != nil {
			t.Fatal(err)
		}
		m := isolation.NewManager(isolation.ManagerDeps{DataDir: dir})
		rt := newContainmentRuntime(m)
		h := &Heartbeat{config: server, containment: rt}
		h.reconcileContainment(decode(t, containmentDesiredJSON(t, now, `0`, containmentExtra(nil))))
		got := takeContainmentRejection(t, rt)
		m.NotePolicyRejected(context.Background(), got.isolationID, got.generation, got.reason)
		r := m.Report()
		if len(r.Events) != 1 || r.Events[0].Type != "policy_rejected" || r.Events[0].Detail != string(isolation.PolicyRejectRevisionInvalid) || r.Phase != journal.PhaseCommitted || r.State != isolation.StateVerified {
			t.Fatalf("report %+v", r)
		}
	})
}
