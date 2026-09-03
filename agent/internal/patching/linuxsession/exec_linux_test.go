//go:build linux

package linuxsession

import (
	"context"
	"errors"
	"os"
	"os/user"
	"slices"
	"strconv"
	"testing"
)

func TestCommandRefusesARootSession(t *testing.T) {
	s := GraphicalSession{ID: "1", Username: "root", UID: "0", Type: TypeX11, Display: ":0"}
	if _, err := s.Command(context.Background(), "env"); !errors.Is(err, ErrRefusedRootSession) {
		t.Fatalf("Command for uid 0 returned %v, want ErrRefusedRootSession", err)
	}
}

func TestCommandRefusesAnUnparseableUID(t *testing.T) {
	s := GraphicalSession{ID: "1", Username: "alice", UID: "not-a-number", Type: TypeX11, Display: ":0"}
	if _, err := s.Command(context.Background(), "env"); err == nil {
		t.Fatal("Command with a non-numeric uid succeeded, want an error")
	}
}

func TestCommandRefusesWhenItCannotDropPrivileges(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: privilege dropping succeeds, so this branch is unreachable")
	}
	// A uid that is neither ours nor root. Without root we cannot setuid to it,
	// and escalating is never an option, so the only honest answer is a refusal.
	other := strconv.Itoa(os.Geteuid() + 4242)
	s := GraphicalSession{ID: "1", Username: "someone", UID: other, Type: TypeX11, Display: ":0"}
	if _, err := s.Command(context.Background(), "env"); !errors.Is(err, ErrCannotDropPrivileges) {
		t.Fatalf("Command for a foreign uid returned %v, want ErrCannotDropPrivileges", err)
	}
}

func TestCommandRefusesAMissingBinary(t *testing.T) {
	// A non-root uid so this exercises the binary check rather than the uid-0
	// refusal, which is deliberately checked first.
	s := GraphicalSession{ID: "1", Username: "alice", UID: "1000", Type: TypeX11, Display: ":0"}
	_, err := s.Command(context.Background(), "definitely-not-installed-breeze-test")
	if !errors.Is(err, ErrBinaryNotFound) {
		t.Fatalf("Command for a missing binary returned %v, want ErrBinaryNotFound", err)
	}
}

// TestCredentialForDropsToTheUserAndNeverKeepsGroupZero is the security
// assertion of the wave: the dialog must run with the session user's identity
// and none of the daemon's.
func TestCredentialForDropsToTheUserAndNeverKeepsGroupZero(t *testing.T) {
	const nobodyUID = "65534" // conventional on Debian and Ubuntu, incl. CI runners
	u, err := user.LookupId(nobodyUID)
	if err != nil {
		t.Skipf("no uid %s on this box: %v", nobodyUID, err)
	}

	cred, err := credentialFor(nobodyUID)
	if err != nil {
		t.Fatalf("credentialFor(%s): %v", nobodyUID, err)
	}
	if cred.Uid != 65534 {
		t.Errorf("Uid = %d, want 65534", cred.Uid)
	}
	wantGid, err := strconv.ParseUint(u.Gid, 10, 32)
	if err != nil {
		t.Fatalf("parse gid %q: %v", u.Gid, err)
	}
	if uint64(cred.Gid) != wantGid {
		t.Errorf("Gid = %d, want %d", cred.Gid, wantGid)
	}
	for _, g := range cred.Groups {
		if g == 0 {
			t.Errorf("supplementary groups %v keep gid 0; the dialog would retain root group access", cred.Groups)
		}
	}
}

func TestCredentialForRefusesRoot(t *testing.T) {
	if _, err := credentialFor("0"); !errors.Is(err, ErrRefusedRootSession) {
		t.Fatalf("credentialFor(\"0\") = %v, want ErrRefusedRootSession", err)
	}
}

// TestCommandDropsPrivilegesWhenTheDaemonIsRoot proves the Credential is
// actually attached, not merely computed. Root-only, which is how the agent
// really runs and how the container-based local verification runs.
func TestCommandDropsPrivilegesWhenTheDaemonIsRoot(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("not root: the privilege-drop branch is unreachable")
	}
	const nobodyUID = "65534"
	if _, err := user.LookupId(nobodyUID); err != nil {
		t.Skipf("no uid %s on this box: %v", nobodyUID, err)
	}
	if _, err := ResolveSystemBinary("env"); err != nil {
		t.Skip("no env binary in the system path")
	}

	s := GraphicalSession{ID: "1", Username: "nobody", UID: nobodyUID, Type: TypeX11, Display: ":0"}
	cmd, err := s.Command(context.Background(), "env")
	if err != nil {
		t.Fatalf("Command: %v", err)
	}
	if cmd.SysProcAttr == nil || cmd.SysProcAttr.Credential == nil {
		t.Fatal("a root daemon built a session command with no Credential — zenity would run as root")
	}
	if cmd.SysProcAttr.Credential.Uid != 65534 {
		t.Errorf("Credential.Uid = %d, want 65534", cmd.SysProcAttr.Credential.Uid)
	}
	if cmd.SysProcAttr.Credential.NoSetGroups {
		t.Error("NoSetGroups is set; the child would inherit root's supplementary groups")
	}
}

func TestCommandForOurOwnUIDCarriesTheSessionEnvironmentAndNoCredential(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: the no-drop branch is unreachable")
	}
	if _, err := ResolveSystemBinary("env"); err != nil {
		t.Skip("no /usr/bin/env on this box")
	}
	uid := strconv.Itoa(os.Geteuid())
	s := GraphicalSession{ID: "1", Username: "alice", UID: uid, Type: TypeX11, Display: ":0"}
	cmd, err := s.Command(context.Background(), "env")
	if err != nil {
		t.Fatalf("Command errored: %v", err)
	}
	if cmd.SysProcAttr != nil && cmd.SysProcAttr.Credential != nil {
		t.Error("a command for our own uid must not set a Credential")
	}
	if cmd.Dir != "/" {
		t.Errorf("cmd.Dir = %q, want \"/\" — never the user's home", cmd.Dir)
	}
	if !slices.Equal(cmd.Env, s.CommandEnv()) {
		t.Errorf("cmd.Env = %v, want exactly CommandEnv() %v", cmd.Env, s.CommandEnv())
	}
	// The resolved path must come from the fixed search list, never from $PATH.
	if !slices.ContainsFunc(systemBinaryDirs, func(dir string) bool {
		return cmd.Path == dir+"/env"
	}) {
		t.Errorf("cmd.Path = %q, want a path under %v", cmd.Path, systemBinaryDirs)
	}
}

func TestListIsQuietOnABoxWithNoGraphicalSession(t *testing.T) {
	// CI runners have no logind session. The contract is: no error, no
	// sessions — a headless box is the ordinary case, not a failure.
	sessions, err := List(context.Background())
	if err != nil {
		t.Fatalf("List errored on a headless box: %v", err)
	}
	if len(sessions) > maxSessions {
		t.Fatalf("List returned %d sessions, above the cap of %d", len(sessions), maxSessions)
	}
}
