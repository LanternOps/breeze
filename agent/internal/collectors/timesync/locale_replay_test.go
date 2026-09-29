package timesync

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/mgmtdetect"
)

// TestLocaleSnapshotReplay pins that a German-language host produces the same
// facts as an English one: only events[].message may differ. It drives the
// collector through fakeSystem, so it is deliberately untagged and runs on
// every OS rather than only in the Windows job.
func TestLocaleSnapshotReplay(t *testing.T) {
	at := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	snapshots := []*Snapshot{}
	for _, german := range []bool{false, true} {
		tokens := germanStatus
		message := "Receiving valid time data"
		if !german {
			tokens = strings.NewReplacer("Sprungindikator", "Leap Indicator", "Quelle", "Source", "Abrufintervall", "Poll Interval").Replace(tokens)
		} else {
			message = "Gültige Zeitdaten werden empfangen"
		}
		f := &fakeSystem{tokens: []byte(tokens), identity: mgmtdetect.IdentityStatus{JoinType: mgmtdetect.JoinTypeNone, Source: "dsregcmd"},
			strings: map[string]string{serviceKey + `\Parameters|Type`: "NTP"},
			events: []Event{{RecordID: 1, EventID: 37, Level: 4, OccurredAt: at.Add(-time.Minute), Message: message,
				Properties: []string{"peer.example.com,0x9 (ntp.m|0x9|transport)"}}}}
		c := New(t.TempDir(), f)
		c.now = func() time.Time { return at }
		s, err := c.Collect(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		snapshots = append(snapshots, s)
	}
	if snapshots[0].Events[0].Message == snapshots[1].Events[0].Message {
		t.Fatal("fixture does not exercise locale")
	}
	for _, s := range snapshots {
		for i := range s.Events {
			s.Events[i].Message = ""
		}
	}
	if !reflect.DeepEqual(snapshots[0], snapshots[1]) {
		a, _ := json.Marshal(snapshots[0])
		b, _ := json.Marshal(snapshots[1])
		t.Fatalf("locale affected facts:\n%s\n%s", a, b)
	}
}
