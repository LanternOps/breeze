//go:build linux

package securefs

import (
	"encoding/binary"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

// posixACLXattr encodes a POSIX ACL in the kernel's extended attribute format.
func posixACLXattr(entries ...[3]uint32) []byte {
	buf := make([]byte, 4+8*len(entries))
	binary.LittleEndian.PutUint32(buf, 2)
	for i, e := range entries {
		off := 4 + 8*i
		binary.LittleEndian.PutUint16(buf[off:], uint16(e[0]))
		binary.LittleEndian.PutUint16(buf[off+2:], uint16(e[1]))
		binary.LittleEndian.PutUint32(buf[off+4:], e[2])
	}
	return buf
}

// A private directory must not carry a default or extended access ACL: one
// can grant another account access to what is created inside it while the
// directory's own mode bits still read 0700.
func TestPrivateDirInfoRefusesPOSIXACLs(t *testing.T) {
	const undefined = 0xffffffff
	for name, attr := range map[string]struct {
		key   string
		value []byte
	}{
		"default": {"system.posix_acl_default", posixACLXattr([3]uint32{0x01, 7, undefined}, [3]uint32{0x04, 0, undefined}, [3]uint32{0x20, 0, undefined})},
		"access":  {"system.posix_acl_access", posixACLXattr([3]uint32{0x01, 7, undefined}, [3]uint32{0x02, 7, 65534}, [3]uint32{0x04, 0, undefined}, [3]uint32{0x10, 0, undefined}, [3]uint32{0x20, 0, undefined})},
	} {
		t.Run(name, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "store")
			if err := EnsurePrivateDir(dir); err != nil {
				t.Fatal(err)
			}
			if _, err := PrivateDirInfo(dir); err != nil {
				t.Fatalf("plain private directory refused: %v", err)
			}
			if err := unix.Setxattr(dir, attr.key, attr.value, 0); err != nil {
				if errors.Is(err, unix.ENOTSUP) || errors.Is(err, unix.EOPNOTSUPP) {
					t.Skipf("filesystem has no POSIX ACL support: %v", err)
				}
				t.Fatalf("set %s: %v", attr.key, err)
			}
			_, err := PrivateDirInfo(dir)
			if err == nil || !strings.Contains(err.Error(), "access control list") {
				t.Fatalf("expected the ACL to be refused, got %v", err)
			}
		})
	}
}
