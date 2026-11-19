//go:build linux

package ipc

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"testing"
)

// A listener this (non-root, on CI) test process owns: the gathered evidence
// names this uid, the chain runs from the canonical socket dir to "/", and the
// check refuses the server end to end because it is not root.
func TestGatherUnixServerEvidence_SelfListener(t *testing.T) {
	dir, err := os.MkdirTemp("", "si")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	sock := filepath.Join(dir, "s.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		c, err := ln.Accept()
		if err == nil {
			defer func() { _ = c.Close() }()
			buf := make([]byte, 1)
			_, _ = c.Read(buf)
		}
	}()

	raw, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = raw.Close() })

	ev, err := GatherUnixServerEvidence(raw.(*net.UnixConn), sock)
	if err != nil {
		t.Fatalf("GatherUnixServerEvidence: %v", err)
	}
	if ev.PeerUID != uint32(os.Getuid()) {
		t.Fatalf("PeerUID = %d, want %d", ev.PeerUID, os.Getuid())
	}
	canonical, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatalf("EvalSymlinks: %v", err)
	}
	if len(ev.DirChain) < 2 || ev.DirChain[0].Path != canonical || ev.DirChain[len(ev.DirChain)-1].Path != "/" {
		t.Fatalf("DirChain = %+v, want %s ... /", ev.DirChain, canonical)
	}
	for _, d := range ev.DirChain {
		if !d.Mode.IsDir() {
			t.Fatalf("chain entry %s is not a directory: %v", d.Path, d.Mode)
		}
	}

	if os.Getuid() != 0 {
		if err := CheckUnixServerIdentity(ev); !errors.Is(err, ErrUnixServerNotRoot) {
			t.Fatalf("CheckUnixServerIdentity = %v, want ErrUnixServerNotRoot for a non-root server", err)
		}
	}
}

func TestGatherUnixServerEvidence_NilConn(t *testing.T) {
	if _, err := GatherUnixServerEvidence(nil, "/run/breeze/agent.sock"); err == nil {
		t.Fatal("nil conn produced evidence")
	}
}

func TestStatModeToFileMode(t *testing.T) {
	if m := statModeToFileMode(0o040755); !m.IsDir() || m.Perm() != 0o755 {
		t.Fatalf("dir mode = %v", m)
	}
	if m := statModeToFileMode(0o120777); m.IsDir() {
		t.Fatalf("symlink mapped to a directory: %v", m)
	}
}
