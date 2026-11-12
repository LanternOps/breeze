//go:build darwin

package tools

// canonicalExistingPath returns the spelling the filesystem itself uses for
// the existing path p. A case-insensitive APFS or HFS+ volume reaches one
// folder under many spellings ("Keychains", "KEYCHAINS", and others that
// differ only in characters the volume folds together), so a path string that
// went through filepath.EvalSymlinks can still differ from the deny-list's
// spelling. F_GETPATH on a descriptor reports the name stored on disk. The
// descriptor comes from openForInspection, so only a folder or a regular
// file is ever opened. If p cannot be inspected, p is returned unchanged.
func canonicalExistingPath(p string) string {
	f, err := openForInspection(p)
	if err != nil {
		return p
	}
	defer f.Close()
	final, err := finalPathOfFile(f)
	if err != nil || final == "" {
		return p
	}
	return final
}
