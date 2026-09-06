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

// TestCredentialFromIDs drives the privilege decision directly, so both
// refusals are asserted without needing an exotic account to exist on the test
// machine.
func TestCredentialFromIDs(t *testing.T) {
	cases := []struct {
		name       string
		uid, gid   string
		groups     []string
		wantErr    error
		wantUID    uint32
		wantGID    uint32
		wantGroups []uint32
	}{
		{
			name: "an ordinary user keeps their own groups",
			uid:  "1000", gid: "1000", groups: []string{"1000", "27", "44"},
			wantUID: 1000, wantGID: 1000, wantGroups: []uint32{1000, 27, 44},
		},
		{
			name: "uid 0 is refused",
			uid:  "0", gid: "0", wantErr: ErrRefusedRootSession,
		},
		{
			// The gate the supplementary filter cannot reach. Without it the
			// child runs with real and effective gid 0.
			name: "a primary group of root is refused",
			uid:  "1000", gid: "0", groups: []string{"1000"},
			wantErr: ErrRefusedRootSession,
		},
		{
			name: "gid 0 is stripped from supplementary groups",
			uid:  "1000", gid: "1000", groups: []string{"0", "1000", "0", "27"},
			wantUID: 1000, wantGID: 1000, wantGroups: []uint32{1000, 27},
		},
		{
			// setgroups(0, NULL) then drops root's supplementary groups, which
			// is the safe outcome — never an inherited one.
			name: "no supplementary groups is valid and drops root's",
			uid:  "1000", gid: "1000", groups: nil,
			wantUID: 1000, wantGID: 1000, wantGroups: nil,
		},
		{
			name: "an unparseable supplementary group is skipped, not fatal",
			uid:  "1000", gid: "1000", groups: []string{"1000", "not-a-number", "27"},
			wantUID: 1000, wantGID: 1000, wantGroups: []uint32{1000, 27},
		},
		{name: "an unparseable uid is an error", uid: "x", gid: "1000"},
		{name: "an unparseable gid is an error", uid: "1000", gid: "x"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cred, err := credentialFromIDs(tc.uid, tc.gid, tc.groups)
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("err = %v, want %v", err, tc.wantErr)
				}
				return
			}
			if tc.wantUID == 0 {
				if err == nil {
					t.Fatalf("expected an error, got %+v", cred)
				}
				return
			}
			if err != nil {
				t.Fatalf("credentialFromIDs: %v", err)
			}
			if cred.Uid != tc.wantUID || cred.Gid != tc.wantGID {
				t.Errorf("uid/gid = %d/%d, want %d/%d", cred.Uid, cred.Gid, tc.wantUID, tc.wantGID)
			}
			if !slices.Equal(cred.Groups, tc.wantGroups) {
				t.Errorf("Groups = %v, want %v", cred.Groups, tc.wantGroups)
			}
			for _, g := range cred.Groups {
				if g == 0 {
					t.Errorf("Groups %v keeps gid 0; the dialog would retain root group access", cred.Groups)
				}
			}
		})
	}
}

// TestMaxEnumeratedSessionsExceedsTheGraphicalCap pins the separation the
// enumeration cap exists for: if the raw list were capped at maxSessions, a
// local user could hide every real desktop behind cheap tty or ssh logins and
// silently suppress the reboot dialog for everyone else on the box.
func TestMaxEnumeratedSessionsExceedsTheGraphicalCap(t *testing.T) {
	if maxEnumeratedSessions <= maxSessions {
		t.Fatalf("maxEnumeratedSessions (%d) must exceed maxSessions (%d); "+
			"otherwise non-graphical logins crowd out the real desktops",
			maxEnumeratedSessions, maxSessions)
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
