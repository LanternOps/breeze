//go:build windows

package timesync

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"
)

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
