package main

import (
	"os"
	"path/filepath"
	"testing"
)

type fakeWinPEProbe struct {
	inWinPE bool
	media   []int
}

func (f fakeWinPEProbe) InWinPE() bool                    { return f.inWinPE }
func (f fakeWinPEProbe) MediaDiskNumbers() ([]int, error) { return f.media, nil }

// writeMediaPayload drops a full WinPE media payload (cmdline.txt and the
// three baked files) into dir, as if it were a stray copy next to an
// installed breeze-backup.exe.
func writeMediaPayload(t *testing.T, dir string) {
	t.Helper()
	for name, body := range map[string]string{
		"cmdline.txt":        "breeze.media=1",
		"recovery-server":    "https://evil.example.com",
		"recovery-trust-pin": "sha256/AAAA",
		"roots.pem":          "not a pem",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

// Outside WinPE (or with no WinSystem at all) files next to the executable
// are not media content: no cmdline and no baked server/pin/roots, so roots
// stay the system store and --allow-host runs on flags/env alone.
func TestWinPEConsoleHost_NotWinPEIgnoresExeDirPayload(t *testing.T) {
	for name, ws := range map[string]winPEProbe{
		"nil WinSystem": nil,
		"live Windows":  fakeWinPEProbe{inWinPE: false},
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			writeMediaPayload(t, dir)
			h := newWinPEConsoleHost(ws, dir)
			if h.BakedServer != "" || h.BakedTrustPin != "" || h.BakedRoots != "" {
				t.Fatalf("baked paths = %q %q %q, want all empty", h.BakedServer, h.BakedTrustPin, h.BakedRoots)
			}
			raw, err := h.Cmdline()
			if err != nil || raw != "" {
				t.Fatalf("Cmdline = %q, %v; want empty", raw, err)
			}
			if err := loadRecoveryMediaRoots(h, os.Stderr); err != nil {
				t.Fatalf("a stray roots.pem must not be loaded off WinPE: %v", err)
			}
		})
	}
}

func TestWinPEConsoleHost_InWinPEUsesExeDirPayload(t *testing.T) {
	dir := t.TempDir()
	writeMediaPayload(t, dir)
	h := newWinPEConsoleHost(fakeWinPEProbe{inWinPE: true}, dir)
	if h.BakedServer != filepath.Join(dir, "recovery-server") ||
		h.BakedTrustPin != filepath.Join(dir, "recovery-trust-pin") ||
		h.BakedRoots != filepath.Join(dir, "roots.pem") {
		t.Fatalf("baked paths = %q %q %q", h.BakedServer, h.BakedTrustPin, h.BakedRoots)
	}
	raw, err := h.Cmdline()
	if err != nil || raw != "breeze.media=1" {
		t.Fatalf("Cmdline = %q, %v", raw, err)
	}
}

// In WinPE but with no resolvable executable directory, nothing is read from
// the working directory.
func TestWinPEConsoleHost_InWinPENoExeDir(t *testing.T) {
	h := newWinPEConsoleHost(fakeWinPEProbe{inWinPE: true}, "")
	if h.BakedServer != "" || h.BakedTrustPin != "" || h.BakedRoots != "" {
		t.Fatalf("baked paths = %q %q %q, want all empty", h.BakedServer, h.BakedTrustPin, h.BakedRoots)
	}
	if raw, err := h.Cmdline(); err != nil || raw != "" {
		t.Fatalf("Cmdline = %q, %v; want empty", raw, err)
	}
}

func TestWinPEConsoleHost_MediaSourcesAndHostCheck(t *testing.T) {
	h := newWinPEConsoleHost(fakeWinPEProbe{inWinPE: true, media: []int{10}}, "")
	got, err := h.MediaSources()
	if err != nil || len(got) != 1 || got[0] != `\\.\PhysicalDrive10` {
		t.Fatalf("MediaSources = %v, %v", got, err)
	}
	if err := h.HostCheck(); err != nil {
		t.Fatalf("HostCheck = %v", err)
	}
	nilHost := newWinPEConsoleHost(nil, "")
	if _, err := nilHost.MediaSources(); err == nil {
		t.Fatal("nil WinSystem MediaSources must fail")
	}
	if err := nilHost.HostCheck(); err == nil {
		t.Fatal("nil WinSystem HostCheck must refuse")
	}
}
