//go:build !windows

package recoveryinstall

import "os"

// Link is an atomic create-exclusive publication of the verified inode. Unlike
// Rename on Unix it cannot replace an existing executable. The caller unlinks
// the temporary name after publication.
func publishExclusive(source, target string) error { return os.Link(source, target) }
