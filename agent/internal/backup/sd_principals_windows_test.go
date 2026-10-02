//go:build windows

package backup

import (
	"encoding/base64"
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// An account SID from a domain no test machine belongs to.
const unrelatedDomainUser = "S-1-5-21-1111111111-2222222222-3333333333-1001"

// sdFromSDDLForTest returns the self-relative bytes of an SDDL descriptor.
func sdFromSDDLForTest(t *testing.T, sddl string) []byte {
	t.Helper()
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		t.Fatalf("SecurityDescriptorFromString(%q): %v", sddl, err)
	}
	return append([]byte(nil), unsafe.Slice((*byte)(unsafe.Pointer(sd)), sd.Length())...)
}

// currentUserSIDForTest is the SID the test process runs as (a local or
// domain account, or SYSTEM) — always a principal this machine recognises.
func currentUserSIDForTest(t *testing.T) string {
	t.Helper()
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatalf("GetTokenUser: %v", err)
	}
	return user.User.Sid.String()
}

// TestSecurityDescriptorPrincipalsFromRealDescriptor reads owner, group and
// every DACL trustee (including an object ACE) out of real descriptors.
func TestSecurityDescriptorPrincipalsFromRealDescriptor(t *testing.T) {
	sd := sdFromSDDLForTest(t, "O:SYG:BAD:P(A;;FA;;;BA)(D;;FW;;;"+unrelatedDomainUser+")(OA;;RP;bf967a86-0de6-11d0-a285-00aa003049e2;;WD)")
	p, err := descriptorPrincipals(sd)
	if err != nil {
		t.Fatalf("descriptorPrincipals: %v", err)
	}
	if p.owner != "S-1-5-18" || p.group != "S-1-5-32-544" {
		t.Fatalf("owner/group = %q/%q", p.owner, p.group)
	}
	var sids []string
	for _, e := range p.dacl {
		if e.unreadable {
			t.Fatalf("unreadable DACL entry in %+v", p.dacl)
		}
		sids = append(sids, e.sid)
	}
	if want := []string{"S-1-5-32-544", unrelatedDomainUser, "S-1-1-0"}; !slices.Equal(sids, want) {
		t.Fatalf("DACL trustees = %v, want %v", sids, want)
	}
}

// TestSecurityDescriptorLocalKnownDomains: every Windows machine has a local
// account domain, and it is a well-formed SID the unrelated one is not in.
func TestSecurityDescriptorLocalKnownDomains(t *testing.T) {
	k, notes := localKnownDomains()
	t.Logf("account=%q primary=%q trusted=%v notes=%v", k.account, k.primary, k.trusted, notes)
	if !validSIDString(k.account) || !strings.HasPrefix(k.account, "S-1-5-21-") {
		t.Fatalf("account domain %q is not a machine domain SID (notes %v)", k.account, notes)
	}
	if sidAllowed(unrelatedDomainUser, k) {
		t.Fatalf("%s is recognised on this machine; pick another SID for these tests", unrelatedDomainUser)
	}
	if user := currentUserSIDForTest(t); !sidAllowed(user, k) {
		t.Errorf("the account this test runs as (%s) is not recognised", user)
	}
}

// quarantineDACLPattern is the DACL component a quarantined entry reads back
// as: protected (no inherited entries), exactly SYSTEM and Administrators
// full control.
var quarantineDACLPattern = regexp.MustCompile(`D:P(AI)?\(A;(OICI)?;FA;;;SY\)\(A;(OICI)?;FA;;;BA\)$`)

func assertQuarantinedForTest(t *testing.T, path string) {
	t.Helper()
	sd, err := fileSecurity(path)
	if err != nil {
		t.Fatalf("fileSecurity(%s): %v", path, err)
	}
	sddl := sdBytesToSDDLForTest(t, sd)
	if !strings.HasPrefix(sddl, "O:BA") || !quarantineDACLPattern.MatchString(sddl) {
		t.Errorf("%s reads back %q, want owner BA and a protected SYSTEM+Administrators-only DACL", path, sddl)
	}
}

// TestSecurityDescriptorQuarantineOnRealRestore: descriptors built from SDDL
// with recognised principals (SYSTEM, Administrators, the running account)
// are applied as captured; a descriptor naming an unrelated-domain or
// other-machine account as a DACL trustee, owner or group is not applied —
// the file (or directory) reads back with the restrictive quarantine ACL and
// is listed in the result.
func TestSecurityDescriptorQuarantineOnRealRestore(t *testing.T) {
	user := currentUserSIDForTest(t)
	otherMachineUser := "S-1-5-21-1234567891-1234567892-1234567893-1001"
	known := "O:" + user + "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;" + user + ")"
	sds := []string{
		known,
		"O:" + user + "D:P(A;;FA;;;SY)(A;;FR;;;" + unrelatedDomainUser + ")",
		"O:" + unrelatedDomainUser + "D:P(A;;FA;;;SY)",
		"O:" + user + "G:" + unrelatedDomainUser + "D:P(A;;FA;;;SY)",
		"O:" + user + "D:P(A;;FA;;;" + otherMachineUser + ")",
		"O:" + user + "D:P(A;OICI;FA;;;" + unrelatedDomainUser + ")",
	}
	encoded := make([]string, len(sds))
	for i, s := range sds {
		encoded[i] = base64.StdEncoding.EncodeToString(sdFromSDDLForTest(t, s))
	}
	provider, snapshotID := setupRestoreTestSnapshotWithSDEntries(t,
		[]sdTestFile{
			{name: "known.txt", content: "k", sourcePath: `C:\q\known.txt`, sdIndex: 1},
			{name: "dacl.txt", content: "d", sourcePath: `C:\q\dacl.txt`, sdIndex: 2},
			{name: "owner.txt", content: "o", sourcePath: `C:\q\owner.txt`, sdIndex: 3},
			{name: "group.txt", content: "g", sourcePath: `C:\q\group.txt`, sdIndex: 4},
			{name: "othermachine.txt", content: "m", sourcePath: `C:\q\othermachine.txt`, sdIndex: 5},
			{name: "inner.txt", content: "i", sourcePath: `C:\q\qdir\inner.txt`, sdIndex: 1},
		},
		[]SnapshotFile{{SourcePath: `C:\q\qdir`, Kind: KindDir, SDIndex: 6}},
		encoded,
	)
	target := t.TempDir()
	result, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snapshotID, TargetPath: target}, nil)
	if err != nil {
		t.Fatalf("RestoreFromSnapshot: %v", err)
	}
	if result.FilesRestored != 7 || result.FilesFailed != 0 {
		t.Fatalf("result = %+v, want 7 restored, 0 failed", result)
	}

	knownSD, err := fileSecurity(restoredPathForTest(t, target, `C:\q\known.txt`))
	if err != nil {
		t.Fatal(err)
	}
	got := sdBytesToSDDLForTest(t, knownSD)
	want := sdBytesToSDDLForTest(t, sdFromSDDLForTest(t, known))
	wantDACL := want[strings.Index(want, "D:"):]
	if !strings.HasPrefix(got, "O:"+sidSDDLForTest(t, user)) || !strings.HasSuffix(got, wantDACL) {
		t.Errorf("recognised descriptor not applied as captured:\n want owner and %q\n  got %q", wantDACL, got)
	}

	quarantined := []string{`C:\q\dacl.txt`, `C:\q\owner.txt`, `C:\q\group.txt`, `C:\q\othermachine.txt`, `C:\q\qdir`}
	for _, p := range quarantined {
		assertQuarantinedForTest(t, restoredPathForTest(t, target, p))
		if !slices.Contains(result.SecurityDescriptorQuarantinedPaths, p) {
			t.Errorf("SecurityDescriptorQuarantinedPaths %v missing %q", result.SecurityDescriptorQuarantinedPaths, p)
		}
	}
	if result.SecurityDescriptorQuarantined != len(quarantined) {
		t.Errorf("SecurityDescriptorQuarantined = %d, want %d", result.SecurityDescriptorQuarantined, len(quarantined))
	}
	if b, err := os.ReadFile(restoredPathForTest(t, target, `C:\q\othermachine.txt`)); err != nil || string(b) != "m" {
		t.Errorf("quarantined file content not restored: %q, %v", b, err)
	}
}

// sidSDDLForTest is how SDDL renders sid: a well-known alias ("SY", "BA")
// or the SID string itself.
func sidSDDLForTest(t *testing.T, sid string) string {
	t.Helper()
	sd := sdFromSDDLForTest(t, "O:"+sid)
	s := sdBytesToSDDLForTest(t, sd)
	return strings.TrimPrefix(s, "O:")
}

// TestSecurityDescriptorSACLOnlyUnknownDropsTheSACL: with SeSecurityPrivilege
// held, a descriptor whose only unrecognised principal is a SACL trustee is
// applied without its SACL (the DACL lands), never quarantined.
func TestSecurityDescriptorSACLOnlyUnknownDropsTheSACL(t *testing.T) {
	release := enableRestoreSDPrivileges()
	defer release()
	if !hasSecurityPrivilege.Load() {
		t.Skip("SeSecurityPrivilege not held (non-elevated runner): the SACL is never applied, so this decision cannot be exercised")
	}
	user := currentUserSIDForTest(t)
	sd := sdFromSDDLForTest(t, "O:"+user+"D:P(A;;FA;;;SY)(A;;FA;;;BA)S:(AU;SA;FA;;;"+unrelatedDomainUser+")")
	rs := &restoreSecurity{hasTable: true}
	plan, err := rs.plan(sd)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if plan.verdict != sdApplyWithoutSACL || plan.applier == nil || plan.applier.Access&windows.ACCESS_SYSTEM_SECURITY != 0 {
		t.Fatalf("plan = %+v, want the descriptor applied without its SACL", plan)
	}
}
