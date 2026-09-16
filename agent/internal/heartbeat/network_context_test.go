package heartbeat

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNetworkContextOldServerDoesNotGetField(t *testing.T) {
	h := &Heartbeat{}
	p := HeartbeatPayload{}
	h.attachNetworkContext(&p)
	b, e := json.Marshal(p)
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(string(b), "networkContext") {
		t.Fatal("unnegotiated telemetry")
	}
}
func TestNetworkContextLostStateRequiresDifferentEpoch(t *testing.T) {
	m, e := newNetworkContextManager(filepath.Join(t.TempDir(), "state"))
	if e != nil {
		t.Fatal(e)
	}
	c := networkContextConfig{AcceptedVersions: []int{1}, ProducerEpoch: "old", SourceIdentity: "p", ExpectedIntervalSeconds: 300}
	if e = m.configure(c); e != nil {
		t.Fatal(e)
	}
	report, reset := m.attach(time.Now(), nil)
	if report != nil || reset == nil || reset.PreviousEpoch != "old" {
		t.Fatal(report, reset)
	}
	if e = m.configure(c); e != nil || m.enabled {
		t.Fatal("reused old epoch")
	}
	c.ProducerEpoch = "new"
	if e = m.configure(c); e != nil || !m.enabled || m.state.Snapshot().Sequence != 0 {
		t.Fatal(e)
	}
}
func TestNetworkContextFreshlyIssuedEpochStartsWithoutReset(t *testing.T) {
	m, e := newNetworkContextManager(filepath.Join(t.TempDir(), "state"))
	if e != nil {
		t.Fatal(e)
	}
	c := networkContextConfig{AcceptedVersions: []int{1}, ProducerEpoch: "fresh", SourceIdentity: "p", ExpectedIntervalSeconds: 300, EpochFreshlyIssued: true}
	if e = m.configure(c); e != nil || !m.enabled || m.pendingReset != "" {
		t.Fatal(e)
	}
	c.AcceptedVersions = nil
	if e = m.configure(c); e != nil {
		t.Fatal(e)
	}
	r, reset := m.attach(time.Now(), nil)
	if r != nil || reset != nil {
		t.Fatal("disabled collector transmitted")
	}
}
