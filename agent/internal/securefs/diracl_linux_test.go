//go:build linux

package securefs

import (
	"testing"

	"golang.org/x/sys/unix"
)

// Any ACL the kernel exposes for the directory refuses it: POSIX access and
// default ACLs, and the NFSv4 and SMB/CIFS ACLs network filesystems expose,
// whose entries the mode bits do not describe.
func TestACLPresentDecision(t *testing.T) {
	for _, present := range []string{
		"system.posix_acl_default",
		"system.posix_acl_access",
		"system.nfs4_acl",
		"system.nfs4_dacl",
		"system.cifs_acl",
		"system.smb3_acl",
	} {
		got, err := aclPresent(func(name string) error {
			if name == present {
				return nil
			}
			return unix.ENODATA
		})
		if err != nil || !got {
			t.Fatalf("%s present: got %v, %v; want refused", present, got, err)
		}
	}
	for _, absent := range []error{unix.ENODATA, unix.ENOTSUP, unix.EOPNOTSUPP} {
		got, err := aclPresent(func(string) error { return absent })
		if err != nil || got {
			t.Fatalf("all attributes %v: got %v, %v; want none", absent, got, err)
		}
	}
	if _, err := aclPresent(func(string) error { return unix.EACCES }); err == nil {
		t.Fatal("an unreadable ACL attribute must be an error")
	}
}
