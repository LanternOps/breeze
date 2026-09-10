package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/rebuild"
)

func TestParseTargetFlag(t *testing.T) {
	for _, tt := range []struct {
		in, size string
		want     rebuild.Target
		wantErr  bool
	}{
		{"disk:/dev/sdb", "", rebuild.Target{Kind: rebuild.TargetDisk, Path: "/dev/sdb"}, false},
		{"image:/tmp/x.img", "40G", rebuild.Target{Kind: rebuild.TargetImage, Path: "/tmp/x.img", ImageSizeBytes: 40 << 30}, false},
		{"image:/tmp/x.img", "512M", rebuild.Target{Kind: rebuild.TargetImage, Path: "/tmp/x.img", ImageSizeBytes: 512 << 20}, false},
		{"/dev/sdb", "", rebuild.Target{}, true},
		{"vhdx:/x", "", rebuild.Target{}, true},
		{"image:/tmp/x.img", "lots", rebuild.Target{}, true},
	} {
		got, err := parseTargetFlag(tt.in, tt.size)
		if (err != nil) != tt.wantErr || got != tt.want {
			t.Errorf("%s/%s = %+v err=%v", tt.in, tt.size, got, err)
		}
	}
}

func TestParseSize(t *testing.T) {
	for _, tt := range []struct {
		in      string
		want    int64
		wantErr bool
	}{
		{"40G", 40 << 30, false},
		{"512M", 512 << 20, false},
		{"1T", 1 << 40, false},
		{"1024", 1024, false},
		{"", 0, true},
		{"lots", 0, true},
		{"-5G", 0, true},
	} {
		got, err := parseSize(tt.in)
		if (err != nil) != tt.wantErr || got != tt.want {
			t.Errorf("%q = %d err=%v", tt.in, got, err)
		}
	}
}

func TestRebuildCommand_DryRunWritesResultJSON(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("rebuild engine host is Linux-only")
	}
	dir := t.TempDir()
	provFile := filepath.Join(dir, "prov.json")
	if err := os.WriteFile(provFile, []byte(`{"provider":"local","providerConfig":{"path":"`+filepath.Join(dir, "store")+`"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	// No snapshot seeded — this only asserts the wiring: an unknown snapshot
	// yields a refused result written to --result-json, and a non-nil error.
	out := filepath.Join(dir, "result.json")
	cmd := newRebuildCommand()
	cmd.SetArgs([]string{"--snapshot", "nope", "--target", "image:" + filepath.Join(dir, "t.img"), "--image-size", "1G", "--provider-config", provFile, "--identity", "new", "--dry-run", "--result-json", out, "--state-dir", dir})
	err := cmd.Execute()
	if err == nil {
		t.Fatal("expected error for missing snapshot")
	}
	b, rerr := os.ReadFile(out)
	if rerr != nil {
		t.Fatalf("result file missing: %v", rerr)
	}
	var res rebuild.Result
	if json.Unmarshal(b, &res) != nil || res.Status != "refused" || !strings.Contains(res.Refusal, "no disk layout was captured") {
		t.Fatalf("result = %s", b)
	}
}

func TestRebuildCommand_RequiresFlags(t *testing.T) {
	cmd := newRebuildCommand()
	cmd.SetArgs([]string{})
	if err := cmd.Execute(); err == nil {
		t.Fatal("expected an error for missing required flags")
	}
}
