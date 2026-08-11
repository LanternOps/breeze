package sessionbroker

import (
	"errors"
	"os"
	"testing"
)

// These tests deliberately live in an untagged file. The bug they cover
// (#3133/#3134/#3137) is macOS-only, but CI has no macOS runner — `test-agent`
// is ubuntu-latest and `test-agent-windows` is windows-latest — so anything in a
// //go:build darwin file is compiled and run nowhere (the #3019/#3046 lesson).
// The socket-ownership decision and the dscl argv/parsing helpers are therefore
// pure and platform-independent, and are exercised on every CI runner.

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
	err := applySocketOwner("/tmp/agent.sock", socketOwner{GID: 350, Mode: ipcSocketMode},
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
	if err != nil {
		t.Fatalf("applySocketOwner: %v", err)
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
	err := applySocketOwner("/tmp/agent.sock", socketOwner{GID: -1, Mode: ipcSocketMode},
		func(string, int, int) error { chownCalled = true; return nil },
		func(string, os.FileMode) error { chmodCalled = true; return nil })
	if err != nil {
		t.Fatalf("applySocketOwner: %v", err)
	}
	if chownCalled {
		t.Error("chown was called with an unknown group; it would clear the existing group")
	}
	if !chmodCalled {
		t.Error("chmod was skipped; the socket would keep whatever mode it was created with")
	}
}

func TestApplySocketOwnerSurfacesChownAndChmodErrors(t *testing.T) {
	chownErr := errors.New("chown boom")
	chmodErr := errors.New("chmod boom")

	err := applySocketOwner("/tmp/agent.sock", socketOwner{GID: 350, Mode: ipcSocketMode},
		func(string, int, int) error { return chownErr },
		func(string, os.FileMode) error { t.Fatal("chmod must not run after a failed chown"); return nil })
	if !errors.Is(err, chownErr) {
		t.Errorf("chown error = %v, want it to wrap %v", err, chownErr)
	}

	err = applySocketOwner("/tmp/agent.sock", socketOwner{GID: 350, Mode: ipcSocketMode},
		func(string, int, int) error { return nil },
		func(string, os.FileMode) error { return chmodErr })
	if !errors.Is(err, chmodErr) {
		t.Errorf("chmod error = %v, want it to wrap %v", err, chmodErr)
	}
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
