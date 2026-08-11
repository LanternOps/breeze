package sessionbroker

import (
	"errors"
	"os"
	"strings"
	"testing"
)

// These tests deliberately live in an untagged file. The bug they cover
// (#3133/#3134/#3137) is macOS-only, and every CI job that GATES a merge runs on
// a platform where a //go:build darwin file is not even compiled: `test-agent` is
// ubuntu-latest and `test-agent-windows` is windows-latest. There IS a macOS job
// — `test-agent-race` on macos-latest — but it is absent from `ci-success`'s
// needs list, so it cannot block a merge. Putting the coverage for a
// darwin-triggered bug there alone would repeat the #3019/#3046 lesson in a
// subtler form: it would run, and a failure would be advisory.
//
// So the socket-ownership decision, the dscl argv builders/parsers and the dscl
// orchestration are all pure and platform-independent, and are exercised by a
// required job. Only the exec.Command calls stay behind the darwin tag.

func TestIPCSocketModeIsNotWorldAccessible(t *testing.T) {
	if ipcSocketMode != 0o660 {
		t.Fatalf("ipcSocketMode = %#o, want 0660", ipcSocketMode)
	}
	// The reporter's workaround was `chmod 666`. Pin the mode so a future
	// "simpler fix" cannot land that as the shipped behaviour: the socket must
	// never be reachable by every local UID.
	if ipcSocketMode&0o007 != 0 {
		t.Fatalf("ipcSocketMode = %#o grants access to others; the IPC socket must not be world-accessible", ipcSocketMode)
	}
	if ipcSocketMode&0o600 != 0o600 {
		t.Fatalf("ipcSocketMode = %#o does not grant the owner read+write", ipcSocketMode)
	}
	if ipcSocketMode&0o060 != 0o060 {
		t.Fatalf("ipcSocketMode = %#o does not grant the breeze group read+write; user helpers could not connect", ipcSocketMode)
	}
}

func TestIPCGroupNameIsBreeze(t *testing.T) {
	// The installers (installer/macos/postinstall,
	// scripts/install/install-darwin.sh, scripts/install/install-linux.sh) create
	// a group by this literal name. A rename here without renaming it there
	// silently reintroduces the bug.
	if IPCGroupName != "breeze" {
		t.Fatalf("IPCGroupName = %q, want \"breeze\"", IPCGroupName)
	}
}

func TestResolveSocketOwnerUsesLookedUpGID(t *testing.T) {
	var asked string
	owner, err := resolveSocketOwner(func(name string) (int, error) {
		asked = name
		return 350, nil
	})
	if err != nil {
		t.Fatalf("resolveSocketOwner: %v", err)
	}
	if asked != IPCGroupName {
		t.Errorf("looked up group %q, want %q", asked, IPCGroupName)
	}
	if owner.GID != 350 {
		t.Errorf("owner.GID = %d, want 350", owner.GID)
	}
	if owner.Mode != ipcSocketMode {
		t.Errorf("owner.Mode = %#o, want %#o", owner.Mode, ipcSocketMode)
	}
}

func TestResolveSocketOwnerLookupFailureStillTightensMode(t *testing.T) {
	sentinel := errors.New("no such group")
	owner, err := resolveSocketOwner(func(string) (int, error) { return 0, sentinel })
	if err == nil {
		t.Fatal("expected an error when the group cannot be resolved")
	}
	if !errors.Is(err, sentinel) {
		t.Errorf("error %v does not wrap the lookup failure", err)
	}
	// A missing group must never widen the socket: GID -1 means "leave the group
	// alone" and the mode must still be the restrictive 0660.
	if owner.GID != -1 {
		t.Errorf("owner.GID = %d, want -1 (no group change)", owner.GID)
	}
	if owner.Mode != ipcSocketMode {
		t.Errorf("owner.Mode = %#o, want %#o even on lookup failure", owner.Mode, ipcSocketMode)
	}
}

func TestResolveSocketOwnerRejectsNegativeGID(t *testing.T) {
	// A -1 from a lookup would otherwise be indistinguishable from "no change",
	// masking a broken resolver.
	owner, err := resolveSocketOwner(func(string) (int, error) { return -1, nil })
	if err == nil {
		t.Fatal("expected an error for a negative gid")
	}
	if owner.GID != -1 || owner.Mode != ipcSocketMode {
		t.Errorf("owner = %+v, want {GID:-1 Mode:%#o}", owner, ipcSocketMode)
	}
}

func TestApplySocketOwnerChownsThenChmods(t *testing.T) {
	var calls []string
	var gotUID, gotGID int
	var gotMode os.FileMode
	res := applySocketOwner("/tmp/agent.sock", socketOwner{GID: 350, Mode: ipcSocketMode},
		func(name string, uid, gid int) error {
			calls = append(calls, "chown "+name)
			gotUID, gotGID = uid, gid
			return nil
		},
		func(name string, mode os.FileMode) error {
			calls = append(calls, "chmod "+name)
			gotMode = mode
			return nil
		})
	if res.ChownErr != nil || res.ChmodErr != nil {
		t.Fatalf("applySocketOwner: chown=%v chmod=%v", res.ChownErr, res.ChmodErr)
	}
	// Order matters: chown can clear mode bits on some platforms, so the chmod
	// has to be the last word.
	want := []string{"chown /tmp/agent.sock", "chmod /tmp/agent.sock"}
	if len(calls) != len(want) || calls[0] != want[0] || calls[1] != want[1] {
		t.Errorf("calls = %v, want %v", calls, want)
	}
	if gotUID != -1 {
		t.Errorf("chown uid = %d, want -1 (keep the existing owner, root)", gotUID)
	}
	if gotGID != 350 {
		t.Errorf("chown gid = %d, want 350", gotGID)
	}
	if gotMode != ipcSocketMode {
		t.Errorf("chmod mode = %#o, want %#o", gotMode, ipcSocketMode)
	}
}

func TestApplySocketOwnerSkipsChownWhenGroupUnknown(t *testing.T) {
	chownCalled := false
	chmodCalled := false
	res := applySocketOwner("/tmp/agent.sock", socketOwner{GID: -1, Mode: ipcSocketMode},
		func(string, int, int) error { chownCalled = true; return nil },
		func(string, os.FileMode) error { chmodCalled = true; return nil })
	if res.ChownErr != nil || res.ChmodErr != nil {
		t.Fatalf("applySocketOwner: chown=%v chmod=%v", res.ChownErr, res.ChmodErr)
	}
	if chownCalled {
		t.Error("chown was called with an unknown group; it would clear the existing group")
	}
	if !chmodCalled {
		t.Error("chmod was skipped; the socket would keep whatever mode it was created with")
	}
}

func TestApplySocketOwnerSurfacesChownAndChmodErrorsSeparately(t *testing.T) {
	chownErr := errors.New("chown boom")
	chmodErr := errors.New("chmod boom")

	t.Run("a failed chown still applies the mode", func(t *testing.T) {
		// The two errors are reported separately because they differ in severity:
		// a lost group is survivable, an unapplied mode is not. Skipping the chmod
		// here would leave the socket at net.Listen's umask-derived mode, the one
		// outcome that could be MORE permissive than intended.
		chmodCalled := false
		res := applySocketOwner("/tmp/agent.sock", socketOwner{GID: 350, Mode: ipcSocketMode},
			func(string, int, int) error { return chownErr },
			func(string, os.FileMode) error { chmodCalled = true; return nil })
		if !errors.Is(res.ChownErr, chownErr) {
			t.Errorf("ChownErr = %v, want it to wrap %v", res.ChownErr, chownErr)
		}
		if res.ChmodErr != nil {
			t.Errorf("ChmodErr = %v, want nil", res.ChmodErr)
		}
		if !chmodCalled {
			t.Error("chmod was skipped after a failed chown, leaving the socket at the listener's default mode")
		}
	})

	t.Run("a failed chmod is reported on its own channel", func(t *testing.T) {
		res := applySocketOwner("/tmp/agent.sock", socketOwner{GID: 350, Mode: ipcSocketMode},
			func(string, int, int) error { return nil },
			func(string, os.FileMode) error { return chmodErr })
		if res.ChownErr != nil {
			t.Errorf("ChownErr = %v, want nil", res.ChownErr)
		}
		if !errors.Is(res.ChmodErr, chmodErr) {
			t.Errorf("ChmodErr = %v, want it to wrap %v", res.ChmodErr, chmodErr)
		}
	})
}

func TestDsclArgvBuilders(t *testing.T) {
	tests := []struct {
		name string
		got  []string
		want []string
	}{
		{
			name: "read primary gid",
			got:  dsclGroupReadArgs("breeze"),
			want: []string{".", "-read", "/Groups/breeze", "PrimaryGroupID"},
		},
		{
			name: "read membership",
			got:  dsclGroupMembershipReadArgs("breeze"),
			want: []string{".", "-read", "/Groups/breeze", "GroupMembership"},
		},
		{
			name: "append member",
			got:  dsclGroupAppendMemberArgs("breeze", "jingxie"),
			want: []string{".", "-append", "/Groups/breeze", "GroupMembership", "jingxie"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if len(tc.got) != len(tc.want) {
				t.Fatalf("argv = %q, want %q", tc.got, tc.want)
			}
			for i := range tc.want {
				if tc.got[i] != tc.want[i] {
					t.Fatalf("argv = %q, want %q", tc.got, tc.want)
				}
			}
		})
	}
}

func TestParseDsclPrimaryGroupID(t *testing.T) {
	tests := []struct {
		name    string
		out     string
		want    int
		wantErr bool
	}{
		{name: "inline", out: "PrimaryGroupID: 350\n", want: 350},
		{name: "folded onto the next line", out: "PrimaryGroupID:\n 350\n", want: 350},
		{name: "no trailing newline", out: "PrimaryGroupID: 501", want: 501},
		{name: "group missing", out: "<dscl_cmd> DS Error: -14136 (eDSRecordNotFound)\n", wantErr: true},
		{name: "key missing", out: "No such key: PrimaryGroupID\n", wantErr: true},
		{name: "empty", out: "", wantErr: true},
		{name: "negative", out: "PrimaryGroupID: -5\n", wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseDsclPrimaryGroupID(tc.out)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("parseDsclPrimaryGroupID(%q) = %d, want an error", tc.out, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseDsclPrimaryGroupID(%q): %v", tc.out, err)
			}
			if got != tc.want {
				t.Errorf("parseDsclPrimaryGroupID(%q) = %d, want %d", tc.out, got, tc.want)
			}
		})
	}
}

func TestUserInDsclGroupMembership(t *testing.T) {
	const membership = "GroupMembership: alice jingxie bob\n"
	tests := []struct {
		name string
		out  string
		user string
		want bool
	}{
		{name: "first member", out: membership, user: "alice", want: true},
		{name: "middle member", out: membership, user: "jingxie", want: true},
		{name: "last member", out: membership, user: "bob", want: true},
		{name: "prefix is not a member", out: membership, user: "jing", want: false},
		{name: "suffix is not a member", out: membership, user: "xie", want: false},
		{name: "absent", out: membership, user: "carol", want: false},
		{name: "empty username never matches", out: membership, user: "", want: false},
		{name: "folded output", out: "GroupMembership:\n alice\n jingxie\n", user: "jingxie", want: true},
		{name: "no members yet", out: "No such key: GroupMembership\n", user: "alice", want: false},
		{name: "empty output", out: "", user: "alice", want: false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := userInDsclGroupMembership(tc.out, tc.user); got != tc.want {
				t.Errorf("userInDsclGroupMembership(%q, %q) = %v, want %v", tc.out, tc.user, got, tc.want)
			}
		})
	}
}

func TestValidIPCGroupMember(t *testing.T) {
	tests := []struct {
		name    string
		user    string
		wantErr bool
	}{
		{name: "ordinary username", user: "jingxie"},
		{name: "with dot and digits", user: "j.xie2"},
		{name: "empty", user: "", wantErr: true},
		{name: "leading dash would be read as a dscl flag", user: "-delete", wantErr: true},
		{name: "space would split the argv", user: "alice bob", wantErr: true},
		{name: "newline", user: "alice\nbob", wantErr: true},
		{name: "tab", user: "alice\tbob", wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := validIPCGroupMember(tc.user)
			if tc.wantErr != (err != nil) {
				t.Fatalf("validIPCGroupMember(%q) error = %v, wantErr = %v", tc.user, err, tc.wantErr)
			}
		})
	}
}

func TestLookupIPCGroupIDUsesTheInstalledLookup(t *testing.T) {
	orig := ipcGroupIDLookup
	t.Cleanup(func() { ipcGroupIDLookup = orig })

	ipcGroupIDLookup = func(name string) (int, error) {
		if name != IPCGroupName {
			t.Errorf("looked up %q, want %q", name, IPCGroupName)
		}
		return 412, nil
	}
	gid, err := LookupIPCGroupID()
	if err != nil {
		t.Fatalf("LookupIPCGroupID: %v", err)
	}
	if gid != 412 {
		t.Errorf("LookupIPCGroupID = %d, want 412", gid)
	}
}

// --- dscl orchestration (the branches that used to live behind //go:build darwin) ---

// fakeDscl replays canned responses keyed by the dscl verb+key, and records the
// argv of every call so ordering can be asserted.
type fakeDscl struct {
	readMembership []struct {
		out string
		err error
	}
	appendErr  error
	readGID    string
	readGIDErr error
	calls      [][]string
}

func (f *fakeDscl) run(args []string) (string, error) {
	f.calls = append(f.calls, args)
	switch {
	case len(args) >= 4 && args[1] == "-read" && args[3] == "PrimaryGroupID":
		return f.readGID, f.readGIDErr
	case len(args) >= 4 && args[1] == "-read" && args[3] == "GroupMembership":
		if len(f.readMembership) == 0 {
			return "", errors.New("fakeDscl: unexpected extra membership read")
		}
		next := f.readMembership[0]
		f.readMembership = f.readMembership[1:]
		return next.out, next.err
	case len(args) >= 2 && args[1] == "-append":
		return "", f.appendErr
	}
	return "", errors.New("fakeDscl: unexpected argv")
}

func membershipReads(entries ...struct {
	out string
	err error
}) []struct {
	out string
	err error
} {
	return entries
}

func read(out string) struct {
	out string
	err error
} {
	return struct {
		out string
		err error
	}{out: out}
}

func readErr(err error) struct {
	out string
	err error
} {
	return struct {
		out string
		err error
	}{err: err}
}

func TestEnsureGroupMemberViaDsclAlreadyAMemberDoesNotAppend(t *testing.T) {
	f := &fakeDscl{readMembership: membershipReads(read("GroupMembership: alice jingxie\n"))}
	outcome, err := ensureGroupMemberViaDscl(f.run, "breeze", "jingxie")
	if err != nil {
		t.Fatalf("ensureGroupMemberViaDscl: %v", err)
	}
	if outcome.Added {
		t.Error("Added = true for a user that was already a member")
	}
	if outcome.ReadErr != nil {
		t.Errorf("ReadErr = %v, want nil", outcome.ReadErr)
	}
	if len(f.calls) != 1 {
		t.Fatalf("made %d dscl calls, want 1 (the membership read only): %v", len(f.calls), f.calls)
	}
	for _, c := range f.calls {
		if len(c) > 1 && c[1] == "-append" {
			t.Error("appended a membership that already existed")
		}
	}
}

func TestEnsureGroupMemberViaDsclAppendsAndVerifies(t *testing.T) {
	f := &fakeDscl{readMembership: membershipReads(
		read("GroupMembership: alice\n"),         // pre-append: not a member
		read("GroupMembership: alice jingxie\n"), // post-append verification
	)}
	outcome, err := ensureGroupMemberViaDscl(f.run, "breeze", "jingxie")
	if err != nil {
		t.Fatalf("ensureGroupMemberViaDscl: %v", err)
	}
	if !outcome.Added {
		t.Error("Added = false after a successful append")
	}
	// read, append, read — the trailing read is the verification that makes a nil
	// error mean the user really is a member.
	if len(f.calls) != 3 {
		t.Fatalf("made %d dscl calls, want 3: %v", len(f.calls), f.calls)
	}
	if f.calls[1][1] != "-append" {
		t.Errorf("second call = %v, want the append", f.calls[1])
	}
	if f.calls[2][3] != "GroupMembership" {
		t.Errorf("third call = %v, want the verification membership read", f.calls[2])
	}
}

func TestEnsureGroupMemberViaDsclSurfacesTheToleratedReadFailure(t *testing.T) {
	// A group created moments ago has no GroupMembership key, so dscl exits
	// non-zero. That is benign and must not block the append — but it must be
	// reported so a read that keeps failing for a real reason is diagnosable.
	sentinel := errors.New("eDSRecordNotFound")
	f := &fakeDscl{readMembership: membershipReads(
		readErr(sentinel),
		read("GroupMembership: jingxie\n"),
	)}
	outcome, err := ensureGroupMemberViaDscl(f.run, "breeze", "jingxie")
	if err != nil {
		t.Fatalf("a failed pre-append read must not be fatal: %v", err)
	}
	if !outcome.Added {
		t.Error("Added = false; the append should have proceeded")
	}
	if !errors.Is(outcome.ReadErr, sentinel) {
		t.Errorf("ReadErr = %v, want it to carry %v so the caller can log it", outcome.ReadErr, sentinel)
	}
}

func TestEnsureGroupMemberViaDsclAppendFailureIsReported(t *testing.T) {
	appendErr := errors.New("append denied")
	f := &fakeDscl{
		readMembership: membershipReads(read("GroupMembership: alice\n")),
		appendErr:      appendErr,
	}
	outcome, err := ensureGroupMemberViaDscl(f.run, "breeze", "jingxie")
	if !errors.Is(err, appendErr) {
		t.Fatalf("error = %v, want it to wrap %v", err, appendErr)
	}
	if outcome.Added {
		t.Error("Added = true despite a failed append")
	}
}

func TestEnsureGroupMemberViaDsclVerificationFailuresAreNotReportedAsSuccess(t *testing.T) {
	verifyErr := errors.New("verify read failed")
	t.Run("verification read errors", func(t *testing.T) {
		f := &fakeDscl{readMembership: membershipReads(
			read("GroupMembership: alice\n"),
			readErr(verifyErr),
		)}
		outcome, err := ensureGroupMemberViaDscl(f.run, "breeze", "jingxie")
		if !errors.Is(err, verifyErr) {
			t.Fatalf("error = %v, want it to wrap %v", err, verifyErr)
		}
		if outcome.Added {
			t.Error("Added = true although the membership could not be verified")
		}
	})
	t.Run("dscl exits 0 but the user is still absent", func(t *testing.T) {
		// The reason verification exists at all: a zero exit status is not proof.
		f := &fakeDscl{readMembership: membershipReads(
			read("GroupMembership: alice\n"),
			read("GroupMembership: alice\n"),
		)}
		outcome, err := ensureGroupMemberViaDscl(f.run, "breeze", "jingxie")
		if err == nil {
			t.Fatal("expected an error when the verification read does not show the user")
		}
		if outcome.Added {
			t.Error("Added = true although the user is not in the group")
		}
	})
}

func TestEnsureGroupMemberViaDsclRejectsAnUnsafeUsernameBeforeRunningAnything(t *testing.T) {
	f := &fakeDscl{}
	if _, err := ensureGroupMemberViaDscl(f.run, "breeze", "-delete"); err == nil {
		t.Fatal("expected an error for a username that dscl would read as a flag")
	}
	if len(f.calls) != 0 {
		t.Errorf("ran %v; an unsafe username must never reach a privileged argv", f.calls)
	}
}

func TestLookupGroupIDViaDsclPrefersDscl(t *testing.T) {
	f := &fakeDscl{readGID: "PrimaryGroupID: 350\n"}
	gid, err := lookupGroupIDViaDscl(f.run, "breeze", func(string) (int, error) {
		t.Error("fallback was used even though dscl succeeded")
		return 0, nil
	})
	if err != nil {
		t.Fatalf("lookupGroupIDViaDscl: %v", err)
	}
	if gid != 350 {
		t.Errorf("gid = %d, want 350", gid)
	}
}

func TestLookupGroupIDViaDsclFallsBackToOsUser(t *testing.T) {
	tests := []struct {
		name string
		f    *fakeDscl
	}{
		// Release darwin binaries are cgo-less, so os/user reads /etc/group and
		// cannot see a dscl-created group. The fallback covers the reverse: a host
		// where dscl is unavailable or unparseable but /etc/group has the answer.
		{name: "dscl errors", f: &fakeDscl{readGIDErr: errors.New("dscl unavailable")}},
		{name: "dscl output unparseable", f: &fakeDscl{readGID: "No such key: PrimaryGroupID\n"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			gid, err := lookupGroupIDViaDscl(tc.f.run, "breeze", func(string) (int, error) { return 412, nil })
			if err != nil {
				t.Fatalf("lookupGroupIDViaDscl: %v", err)
			}
			if gid != 412 {
				t.Errorf("gid = %d, want 412 from the fallback", gid)
			}
		})
	}
}

func TestLookupGroupIDViaDsclReportsBothFailures(t *testing.T) {
	f := &fakeDscl{readGIDErr: errors.New("dscl exploded")}
	fallbackErr := errors.New("no such group in /etc/group")
	gid, err := lookupGroupIDViaDscl(f.run, "breeze", func(string) (int, error) { return 0, fallbackErr })
	if err == nil {
		t.Fatal("expected an error when both lookups fail")
	}
	if gid != -1 {
		t.Errorf("gid = %d, want -1", gid)
	}
	// Both causes must appear: knowing only one of them makes this undiagnosable.
	if !errors.Is(err, fallbackErr) {
		t.Errorf("error %v does not wrap the fallback failure", err)
	}
	if !strings.Contains(err.Error(), "dscl exploded") {
		t.Errorf("error %v does not mention the dscl failure", err)
	}
}
