package ipc

import (
	"errors"
	"io/fs"
	"testing"
)

func rootChain() []DirEvidence {
	return []DirEvidence{
		{Path: "/run/breeze", UID: 0, Mode: fs.ModeDir | 0o755},
		{Path: "/run", UID: 0, Mode: fs.ModeDir | 0o755},
		{Path: "/", UID: 0, Mode: fs.ModeDir | 0o755},
	}
}

func TestCheckUnixServerIdentity_AcceptsRootServerInRootDirs(t *testing.T) {
	if err := CheckUnixServerIdentity(UnixServerEvidence{PeerUID: 0, DirChain: rootChain()}); err != nil {
		t.Fatalf("root server in root-owned dirs rejected: %v", err)
	}
}

func TestCheckUnixServerIdentity_RejectsNonRootPeer(t *testing.T) {
	err := CheckUnixServerIdentity(UnixServerEvidence{PeerUID: 1000, DirChain: rootChain()})
	if !errors.Is(err, ErrUnixServerNotRoot) {
		t.Fatalf("err = %v, want ErrUnixServerNotRoot", err)
	}
}

func TestCheckUnixServerIdentity_RejectsGroupWritableDir(t *testing.T) {
	chain := rootChain()
	chain[0].Mode = fs.ModeDir | 0o775
	err := CheckUnixServerIdentity(UnixServerEvidence{PeerUID: 0, DirChain: chain})
	if !errors.Is(err, ErrUnixSocketDirUnsafe) {
		t.Fatalf("err = %v, want ErrUnixSocketDirUnsafe", err)
	}
}

func TestCheckUnixServerIdentity_RejectsWorldWritableDir(t *testing.T) {
	chain := rootChain()
	chain[1].Mode = fs.ModeDir | 0o757
	err := CheckUnixServerIdentity(UnixServerEvidence{PeerUID: 0, DirChain: chain})
	if !errors.Is(err, ErrUnixSocketDirUnsafe) {
		t.Fatalf("err = %v, want ErrUnixSocketDirUnsafe", err)
	}
}

func TestCheckUnixServerIdentity_RejectsUserOwnedAncestor(t *testing.T) {
	chain := rootChain()
	chain[1].UID = 1000
	err := CheckUnixServerIdentity(UnixServerEvidence{PeerUID: 0, DirChain: chain})
	if !errors.Is(err, ErrUnixSocketDirUnsafe) {
		t.Fatalf("err = %v, want ErrUnixSocketDirUnsafe", err)
	}
}

func TestCheckUnixServerIdentity_RejectsEmptyChain(t *testing.T) {
	err := CheckUnixServerIdentity(UnixServerEvidence{PeerUID: 0})
	if !errors.Is(err, ErrUnixSocketDirUnsafe) {
		t.Fatalf("err = %v, want ErrUnixSocketDirUnsafe", err)
	}
}

// The chain must end at the filesystem root: a chain that stops partway up
// has not proven that every ancestor is root-owned.
func TestCheckUnixServerIdentity_RejectsChainNotEndingAtRoot(t *testing.T) {
	chain := rootChain()[:2]
	err := CheckUnixServerIdentity(UnixServerEvidence{PeerUID: 0, DirChain: chain})
	if !errors.Is(err, ErrUnixSocketDirUnsafe) {
		t.Fatalf("err = %v, want ErrUnixSocketDirUnsafe", err)
	}
}

// A chain entry that is not a directory (a symlink left unresolved, or a
// file) is unsafe: the chain is meant to be the canonical directory path.
func TestCheckUnixServerIdentity_RejectsNonDirectoryEntry(t *testing.T) {
	chain := rootChain()
	chain[0].Mode = fs.ModeSymlink | 0o755
	err := CheckUnixServerIdentity(UnixServerEvidence{PeerUID: 0, DirChain: chain})
	if !errors.Is(err, ErrUnixSocketDirUnsafe) {
		t.Fatalf("err = %v, want ErrUnixSocketDirUnsafe", err)
	}
}
