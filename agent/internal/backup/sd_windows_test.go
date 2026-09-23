//go:build windows

package backup

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// TestFileSecurityReturnsSelfRelativeSD proves fileSecurity's output is a
// real self-relative security descriptor (not, say, an empty/zeroed buffer
// that happens to satisfy len(sd)>0): decode it back to SDDL and confirm it
// carries an owner (O:) and a DACL (D:) component, which every NTFS file
// has, and that securityInfoForSD accepts it as self-relative.
func TestFileSecurityReturnsSelfRelativeSD(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "probe.txt")
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	sd, err := fileSecurity(path)
	if err != nil {
		t.Fatalf("fileSecurity: %v", err)
	}
	if len(sd) == 0 {
		t.Fatal("fileSecurity returned an empty security descriptor")
	}
	if _, err := securityInfoForSD(sd, false); err != nil {
		t.Fatalf("captured descriptor rejected by securityInfoForSD: %v", err)
	}
	sddl := sdBytesToSDDLForTest(t, sd)
	if !strings.Contains(sddl, "O:") {
		t.Errorf("SDDL %q has no owner component", sddl)
	}
	if !strings.Contains(sddl, "D:") {
		t.Errorf("SDDL %q has no DACL component", sddl)
	}
}

// TestFileSecurityRoundTrip proves capture→apply is lossless for
// owner/group/DACL AND that applySecurity actually does something: the
// source is seeded with an explicit, protected, non-inherited DACL that no
// freshly created file would ever carry, captured, applied to a fresh file,
// and the fresh file's full O/G/D SDDL must then equal the source's — while
// a third, untouched file's SDDL must differ (proving the equality assertion
// can fail, i.e. a no-op applySecurity would be caught).
func TestFileSecurityRoundTrip(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src.txt")
	dst := filepath.Join(dir, "dst.txt")
	untouched := filepath.Join(dir, "untouched.txt")
	for _, p := range []string{src, dst, untouched} {
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// Protected (P), auto-inherited (AI), two explicit ACEs: BUILTIN\Administrators
	// full control, Authenticated Users read.
	setFileSDDLForTest(t, src, "D:PAI(A;;FA;;;BA)(A;;FR;;;S-1-5-11)")

	sd, err := fileSecurity(src)
	if err != nil {
		t.Fatalf("fileSecurity(src): %v", err)
	}
	if err := applySecurity(dst, sd); err != nil {
		t.Fatalf("applySecurity(dst): %v", err)
	}
	sd2, err := fileSecurity(dst)
	if err != nil {
		t.Fatalf("fileSecurity(dst) after apply: %v", err)
	}
	sd3, err := fileSecurity(untouched)
	if err != nil {
		t.Fatalf("fileSecurity(untouched): %v", err)
	}

	want := sdBytesToSDDLForTest(t, sd)
	got := sdBytesToSDDLForTest(t, sd2)
	control := sdBytesToSDDLForTest(t, sd3)
	if !strings.Contains(want, "D:PAI(A;;FA;;;BA)") {
		t.Fatalf("source seed did not take: captured SDDL %q", want)
	}
	if got != want {
		t.Errorf("round-trip mismatch:\n want %q\n  got %q", want, got)
	}
	if control == want {
		t.Errorf("untouched file's SDDL %q equals the seeded source's — the round-trip assertion cannot discriminate", control)
	}
}

// TestApplySecurityRefusesMalformedDescriptor proves a descriptor whose
// internal offsets point past its own buffer is refused before it reaches
// the kernel, and leaves the target's descriptor unchanged.
func TestApplySecurityRefusesMalformedDescriptor(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "target.txt")
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	before, err := fileSecurity(path)
	if err != nil {
		t.Fatal(err)
	}
	// Self-relative header claiming owner/group/DACL at offsets beyond its 20 bytes.
	bad := sdHeader(seSelfRelative|seDACLPresent, 20, 40, 0, 60)
	if err := applySecurity(path, bad); err == nil {
		t.Fatal("applySecurity accepted a descriptor whose offsets exceed its length")
	}
	after, err := fileSecurity(path)
	if err != nil {
		t.Fatal(err)
	}
	if sdBytesToSDDLForTest(t, before) != sdBytesToSDDLForTest(t, after) {
		t.Error("a refused descriptor still changed the target's security")
	}
}

// TestSDPrivilegeScopesRelease proves the capture/restore privilege scopes
// actually enable what they claim and are scoped: INSIDE the scope every
// privilege the token holds is enabled (and hasSecurityPrivilege is true
// when the token holds SeSecurityPrivilege); after release each is back to
// its prior state and hasSecurityPrivilege is false again. A do-nothing
// implementation fails the in-scope assertions.
//
// Skips — loudly — on a non-elevated token that lacks SeBackupPrivilege: the
// in-scope assertions would be vacuous there. The Windows CI gate lists this
// test as must-not-skip, so a non-elevated runner is caught, not passed.
func TestSDPrivilegeScopesRelease(t *testing.T) {
	if !privilegeHeldForTest(t, "SeBackupPrivilege") {
		t.Skip("process token does not hold SeBackupPrivilege (non-elevated runner): privilege-scope assertions would be vacuous — run elevated")
	}
	for _, tc := range []struct {
		name   string
		enable func() func()
		privs  []string
	}{
		{"capture", enableCaptureSDPrivileges, []string{"SeBackupPrivilege", securityPrivName}},
		{"restore", enableRestoreSDPrivileges, []string{"SeRestorePrivilege", "SeTakeOwnershipPrivilege", securityPrivName}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := map[string]bool{}
			for _, p := range tc.privs {
				before[p] = privilegeEnabledForTest(t, p)
			}
			release := tc.enable()
			for _, p := range tc.privs {
				if !privilegeHeldForTest(t, p) {
					continue
				}
				if !privilegeEnabledForTest(t, p) {
					t.Errorf("%s held by the token but not enabled inside the %s scope", p, tc.name)
				}
			}
			if privilegeHeldForTest(t, securityPrivName) && !hasSecurityPrivilege.Load() {
				t.Errorf("hasSecurityPrivilege false inside the %s scope although the token holds %s", tc.name, securityPrivName)
			}
			release()
			release() // idempotent
			if hasSecurityPrivilege.Load() {
				t.Error("hasSecurityPrivilege still true after the last scope released")
			}
			for _, p := range tc.privs {
				if got := privilegeEnabledForTest(t, p); got != before[p] {
					t.Errorf("%s enabled=%v after release, want %v (pre-scope state)", p, got, before[p])
				}
			}
		})
	}
}

// sdBytesToSDDLForTest renders a self-relative descriptor's owner, group and
// DACL (never the SACL, which is only captured under SeSecurityPrivilege) as
// SDDL, for equality comparisons in tests.
func sdBytesToSDDLForTest(t *testing.T, sd []byte) string {
	t.Helper()
	if len(sd) == 0 {
		t.Fatal("sdBytesToSDDLForTest: empty security descriptor")
	}
	proc := modadvapi32.NewProc("ConvertSecurityDescriptorToStringSecurityDescriptorW")
	var out *uint16
	const info = ownerSecurityInformation | groupSecurityInformation | daclSecurityInformation
	r1, _, callErr := proc.Call(uintptr(unsafe.Pointer(alignedSD(sd))), 1, info, uintptr(unsafe.Pointer(&out)), 0)
	if r1 == 0 {
		t.Fatalf("ConvertSecurityDescriptorToStringSecurityDescriptorW: %v", callErr)
	}
	defer func() { _, _ = windows.LocalFree(windows.Handle(unsafe.Pointer(out))) }()
	return windows.UTF16PtrToString(out)
}

// setFileSDDLForTest sets path's DACL from sddl via
// ConvertStringSecurityDescriptorToSecurityDescriptorW + SetFileSecurityW.
func setFileSDDLForTest(t *testing.T, path, sddl string) {
	t.Helper()
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		t.Fatalf("SecurityDescriptorFromString(%q): %v", sddl, err)
	}
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	proc := modadvapi32.NewProc("SetFileSecurityW")
	r1, _, callErr := proc.Call(uintptr(unsafe.Pointer(p)), daclSecurityInformation, uintptr(unsafe.Pointer(sd)))
	if r1 == 0 {
		t.Fatalf("SetFileSecurityW(%q): %v", path, callErr)
	}
}

// privilegeEnabledForTest reports whether name is currently ENABLED on the
// process token (false when the token does not hold it at all).
func privilegeEnabledForTest(t *testing.T, name string) bool {
	t.Helper()
	attrs, held := tokenPrivilegeForTest(t, name)
	return held && attrs&windows.SE_PRIVILEGE_ENABLED != 0
}

// privilegeHeldForTest reports whether the process token holds name at all
// (enabled or not).
func privilegeHeldForTest(t *testing.T, name string) bool {
	t.Helper()
	_, held := tokenPrivilegeForTest(t, name)
	return held
}

// tokenPrivilegeForTest returns name's attributes on the process token, via
// GetTokenInformation(TokenPrivileges), and whether the token holds it.
func tokenPrivilegeForTest(t *testing.T, name string) (attrs uint32, held bool) {
	t.Helper()
	tok := windows.GetCurrentProcessToken()
	namePtr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		t.Fatal(err)
	}
	var luid windows.LUID
	if err := windows.LookupPrivilegeValue(nil, namePtr, &luid); err != nil {
		t.Fatalf("LookupPrivilegeValue(%s): %v", name, err)
	}
	var n uint32
	_ = windows.GetTokenInformation(tok, windows.TokenPrivileges, nil, 0, &n)
	if n == 0 {
		t.Fatal("GetTokenInformation size probe returned 0")
	}
	buf := make([]uintptr, (int(n)+int(unsafe.Sizeof(uintptr(0)))-1)/int(unsafe.Sizeof(uintptr(0))))
	if err := windows.GetTokenInformation(tok, windows.TokenPrivileges, (*byte)(unsafe.Pointer(&buf[0])), n, &n); err != nil {
		t.Fatalf("GetTokenInformation: %v", err)
	}
	tp := (*windows.Tokenprivileges)(unsafe.Pointer(&buf[0]))
	for _, la := range unsafe.Slice(&tp.Privileges[0], tp.PrivilegeCount) {
		if la.Luid == luid {
			return la.Attributes, true
		}
	}
	return 0, false
}
