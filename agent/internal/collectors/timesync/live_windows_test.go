//go:build windows

package timesync

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/mgmtdetect"
)

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

func TestLiveTimeSyncFacts(t *testing.T) {
	if os.Getenv("TIMESYNC_LIVE") != "1" {
		t.Skip("explicit lab-only opt-in required")
	}
	wantRole := os.Getenv("TIMESYNC_EXPECT_ROLE")
	if wantRole == "" {
		t.Fatal("TIMESYNC_EXPECT_ROLE must describe this lab scenario")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	sys := NewSystem()
	if sys == nil {
		t.Fatal("Windows constructor returned nil")
	}
	c := New(t.TempDir(), sys)
	s, err := c.Collect(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if s.Domain.Role != wantRole {
		t.Fatalf("role=%s want=%s", s.Domain.Role, wantRole)
	}
	if s.Config.ServiceState == "unknown" || s.Timezone.WindowsID == nil {
		t.Fatal("native service/timezone read unavailable")
	}
	if want := os.Getenv("TIMESYNC_EXPECT_KIND"); want != "" && s.Status.SourceKind != want {
		t.Fatalf("source kind=%s want=%s", s.Status.SourceKind, want)
	}
	if want := os.Getenv("TIMESYNC_EXPECT_VMIC"); want != "" {
		if s.Config.HostTimeProviderEnabled == nil || (*s.Config.HostTimeProviderEnabled) != (want == "1") {
			t.Fatal("VMIC provider fact mismatch")
		}
	}
	// Full output is private diagnostic evidence; redact source/domain strings
	// before copying anything to a public PR.
	if os.Getenv("TIMESYNC_PRINT_PRIVATE") == "1" {
		b, _ := json.MarshalIndent(s, "", "  ")
		t.Log(string(b))
	}
	// No API response exists in this read-only test, so do not Commit.
	second, err := New(c.dir, sys).Collect(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if second.Sequence <= s.Sequence {
		t.Fatal("restart reused sequence")
	}
	t.Logf("schema=%d role=%s method=%s sourceKind=%s events=%d sequence advanced", s.SchemaVersion, s.Domain.Role, s.Status.Method, s.Status.SourceKind, len(s.Events))
}
