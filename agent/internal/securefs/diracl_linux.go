//go:build linux

package securefs

import (
	"errors"

	"golang.org/x/sys/unix"
)

// aclXattrNames are the extended attributes through which Linux exposes a
// directory's access control list: POSIX access and default ACLs, and the
// NFSv4 and SMB/CIFS ACLs that network filesystems expose. The mode bits do
// not describe the entries of any of them, so a directory that has one is
// refused rather than evaluated.
var aclXattrNames = []string{
	"system.posix_acl_default",
	"system.posix_acl_access",
	"system.nfs4_acl",
	"system.nfs4_dacl",
	"system.cifs_acl",
	"system.smb3_acl",
}

// dirHasExtendedACL reports whether the directory carries any ACL listed in
// aclXattrNames. A filesystem without ACL support has none.
func dirHasExtendedACL(fd int) (bool, error) {
	return aclPresent(func(name string) error {
		_, err := unix.Fgetxattr(fd, name, nil)
		return err
	})
}

// aclPresent applies the decision to the result of reading each ACL
// attribute: present means refuse; absent or unsupported means none.
func aclPresent(get func(name string) error) (bool, error) {
	for _, name := range aclXattrNames {
		err := get(name)
		switch {
		case err == nil:
			return true, nil
		case errors.Is(err, unix.ENODATA), errors.Is(err, unix.ENOTSUP), errors.Is(err, unix.EOPNOTSUPP):
			continue
		default:
			return false, err
		}
	}
	return false, nil
}
