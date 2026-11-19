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
	chain[0].GID = 100 // an ordinary group, not root or the IPC group
	err := CheckUnixServerIdentity(UnixServerEvidence{PeerUID: 0, DirChain: chain})
	if !errors.Is(err, ErrUnixSocketDirUnsafe) {
		t.Fatalf("err = %v, want ErrUnixSocketDirUnsafe", err)
	}
}

// The shipped install creates /run/breeze as 0770 root:breeze (systemd
// RuntimeDirectoryMode, tmpfiles.d, the installer); the agent narrows it to
// 0755 when it starts listening. Either shape of the real install must verify.
func TestCheckUnixServerIdentity_AcceptsShippedSocketDirModes(t *testing.T) {
	const breezeGID = 987
	for _, tc := range []struct {
		name string
		gid  uint32
		mode fs.FileMode
	}{
		{"0770 root:breeze", breezeGID, 0o770},
		{"0770 root:root (systemd RuntimeDirectory)", 0, 0o770},
		{"0755 root:breeze", breezeGID, 0o755},
	} {
		t.Run(tc.name, func(t *testing.T) {
			chain := rootChain()
			chain[0].GID, chain[0].Mode = tc.gid, fs.ModeDir|tc.mode
			ev := UnixServerEvidence{PeerUID: 0, DirChain: chain, TrustedGroupIDs: []uint32{breezeGID}}
			if err := CheckUnixServerIdentity(ev); err != nil {
				t.Fatalf("shipped socket dir rejected: %v", err)
			}
		})
	}
}

// Group write is tolerated on the socket's own directory only: every
// ancestor must still be writable by root alone.
func TestCheckUnixServerIdentity_RejectsGroupWritableAncestor(t *testing.T) {
	chain := rootChain()
	chain[1].Mode = fs.ModeDir | 0o775
	err := CheckUnixServerIdentity(UnixServerEvidence{PeerUID: 0, DirChain: chain, TrustedGroupIDs: []uint32{0}})
	if !errors.Is(err, ErrUnixSocketDirUnsafe) {
		t.Fatalf("err = %v, want ErrUnixSocketDirUnsafe", err)
	}
}

func TestCheckUnixServerIdentity_RejectsSocketDirWritableByUntrustedGroup(t *testing.T) {
	chain := rootChain()
	chain[0].GID, chain[0].Mode = 100, fs.ModeDir|0o770
	err := CheckUnixServerIdentity(UnixServerEvidence{PeerUID: 0, DirChain: chain, TrustedGroupIDs: []uint32{987}})
	if !errors.Is(err, ErrUnixSocketDirUnsafe) {
		t.Fatalf("err = %v, want ErrUnixSocketDirUnsafe", err)
	}
}

func TestCheckUnixServerIdentity_RejectsWorldWritableSocketDir(t *testing.T) {
	chain := rootChain()
	chain[0].Mode = fs.ModeDir | 0o777
	err := CheckUnixServerIdentity(UnixServerEvidence{PeerUID: 0, DirChain: chain, TrustedGroupIDs: []uint32{0}})
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
