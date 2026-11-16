//go:build windows

package providers

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/securefs"
	"golang.org/x/sys/windows"
)

func TestLocalStorePrivateACLs(t *testing.T) {
	root := filepath.Join(t.TempDir(), "store")
	parent := filepath.Join(root, "objects")
	if err := os.MkdirAll(parent, 0o755); err != nil {
		t.Fatal(err)
	}
	permissive, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;WD)")
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := permissive.DACL()
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{root, parent} {
		if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
			t.Fatal(err)
		}
	}
	object := filepath.Join(parent, "data")
	if err := os.WriteFile(object, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(t.TempDir(), "source")
	if err := os.WriteFile(source, []byte("content"), 0o600); err != nil {
		t.Fatal(err)
	}
	p := NewLocalProvider(root)
	before, err := windows.GetNamedSecurityInfo(root, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Upload(source, "objects/data"); err == nil {
		t.Fatal("expected migration diagnostic")
	}
	after, err := windows.GetNamedSecurityInfo(root, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	if before.String() != after.String() {
		t.Fatal("existing root ACL was changed")
	}
	// The operator migration is performed only on this synthetic fixture.
	if err := securefs.EnsurePrivateDir(root); err != nil {
		t.Fatal(err)
	}
	if err := p.Upload(source, "objects/data"); err != nil {
		t.Fatal(err)
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	own := user.User.Sid
	// Trustees are resolved to SIDs, not compared as text: SDDL renders the
	// test account as an alias when it is a well-known one (for example "LA"
	// for the built-in Administrator account).
	isAllowed := func(trustee string) bool {
		sid, err := windows.StringToSid(trustee)
		if err != nil {
			return false
		}
		return sid.IsWellKnown(windows.WinLocalSystemSid) || sid.IsWellKnown(windows.WinBuiltinAdministratorsSid) || sid.Equals(own)
	}

	// Controls on descriptors rendered by this machine: the test account is
	// accepted whatever form SDDL gives it, another trustee is not.
	for _, control := range []struct {
		sddl string
		ok   bool
	}{
		{"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;" + own.String() + ")", true},
		{"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + own.String() + ")(A;OICI;FA;;;WD)", false},
		{"D:P(A;OICI;FA;;;SY)(A;OICI;0x1200a9;;;BU)", false},
	} {
		sd, err := windows.SecurityDescriptorFromString(control.sddl)
		if err != nil {
			t.Fatal(err)
		}
		if violation := privateACLEntryViolation(sd.String(), isAllowed); (violation == "") != control.ok {
			t.Fatalf("entry check on %s: violation %q, want accepted=%v", sd.String(), violation, control.ok)
		}
	}

	for _, path := range []string{root, parent, object} {
		sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
		if err != nil {
			t.Fatal(err)
		}
		dacl, _, err := sd.DACL()
		if err != nil || dacl == nil {
			t.Fatalf("missing DACL: %v", err)
		}
		if violation := privateACLEntryViolation(sd.String(), isAllowed); violation != "" {
			t.Fatalf("unexpected access entry on %s: %s", filepath.Base(path), violation)
		}
	}
}
