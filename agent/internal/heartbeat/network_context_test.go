package heartbeat

import (
	"encoding/json"

	"github.com/breeze-rmm/agent/internal/collectors/networkcontext"
	"os"
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

func TestNetworkContextInvalidIdentityRecovers(t *testing.T) {
	for _, raw := range []string{`{}`, `{"producerEpoch":"old"}`} {
		t.Run(raw, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "state")
			if err := os.WriteFile(path, []byte(raw), 0600); err != nil {
				t.Fatal(err)
			}
			m, err := newNetworkContextManager(path)
			if err != nil {
				t.Fatal(err)
			}
			err = m.configure(networkContextConfig{AcceptedVersions: []int{1}, ProducerEpoch: "fresh", SourceIdentity: "source", ExpectedIntervalSeconds: 300, EpochFreshlyIssued: true})
			if err != nil || !m.enabled {
				t.Fatal(err)
			}
		})
	}
}

func TestNetworkContextStaleSequenceRequestsEpochReset(t *testing.T) {
	m, e := newNetworkContextManager(filepath.Join(t.TempDir(), "state"))
	if e != nil {
		t.Fatal(e)
	}
	c := networkContextConfig{AcceptedVersions: []int{1}, ProducerEpoch: "rolled-back", SourceIdentity: "p", ExpectedIntervalSeconds: 300, EpochFreshlyIssued: true}
	if e = m.configure(c); e != nil {
		t.Fatal(e)
	}
	if _, e = m.state.AllocateSequence(); e != nil {
		t.Fatal(e)
	}
	if e = m.state.StoreReport(networkcontext.Report{Version: 1, ProducerEpoch: "rolled-back", Sequence: "1", ReportKind: "unchanged", BaseSnapshotID: "base", ContentDigest: "digest"}); e != nil {
		t.Fatal(e)
	}
	if e = m.ack(networkcontext.Receipt{ProducerEpoch: "rolled-back", ReportSequence: "1", Reason: "stale_sequence"}); e == nil {
		t.Fatal("stale rejection reported as accepted")
	}
	// The server keeps returning the same epoch until it grants the reset.
	c.EpochFreshlyIssued = false
	if e = m.configure(c); e != nil || m.enabled {
		t.Fatal("kept collecting under a sequence the server already passed", e)
	}
	report, reset := m.attach(time.Now(), nil)
	if report != nil || reset == nil || reset.PreviousEpoch != "rolled-back" {
		t.Fatal(report, reset)
	}
	c.ProducerEpoch, c.EpochFreshlyIssued = "granted", true
	if e = m.configure(c); e != nil || !m.enabled || m.state.Snapshot().Sequence != 0 {
		t.Fatal(e)
	}
}

func TestNetworkContextHonorsRetryAfter(t *testing.T) {
	m, e := newNetworkContextManager(filepath.Join(t.TempDir(), "state"))
	if e != nil {
		t.Fatal(e)
	}
	c := networkContextConfig{AcceptedVersions: []int{1}, ProducerEpoch: "e", SourceIdentity: "p", ExpectedIntervalSeconds: 300, EpochFreshlyIssued: true}
	if e = m.configure(c); e != nil {
		t.Fatal(e)
	}
	if _, e = m.state.AllocateSequence(); e != nil {
		t.Fatal(e)
	}
	if e = m.state.StoreReport(networkcontext.Report{Version: 1, ProducerEpoch: "e", Sequence: "1", ReportKind: "unchanged", BaseSnapshotID: "base", ContentDigest: "digest"}); e != nil {
		t.Fatal(e)
	}
	now := time.Now()
	if e = m.ackAt(networkcontext.Receipt{ProducerEpoch: "e", ReportSequence: "1", Reason: "scope_not_admitted", RetryAfterSeconds: 300}, now); e == nil {
		t.Fatal("deferral reported as accepted")
	}
	if report, _ := m.attach(now.Add(299*time.Second), nil); report != nil {
		t.Fatal("resent before the server's retry window")
	}
	if report, _ := m.attach(now.Add(300*time.Second), nil); report == nil || report.Sequence != "1" {
		t.Fatal("deferred capture was not retried", report)
	}
}
