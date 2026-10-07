package tools

// Platform-neutral decisions used by the Windows final-path checks. They take
// plain values so they can be unit-tested on any host.

// reparseTagNameSurrogate is the bit Windows sets on reparse tags that stand
// for another named object (IsReparseTagNameSurrogate): symbolic links,
// junctions and volume mount points.
const reparseTagNameSurrogate = 0x20000000

// isLinkReparseTag reports whether a reparse point with this tag is a link to
// another name, which a recursive delete must remove as a link and never
// descend into. Other reparse points (OneDrive / cloud-files placeholders,
// deduplicated files, app execution aliases, ...) are ordinary files and
// directories with extra storage behaviour; a placeholder folder holds its
// own children and is deleted like any other directory.
func isLinkReparseTag(tag uint32) bool {
	return tag&reparseTagNameSurrogate != 0
}

// allowOnUnnamedVolume decides an open handle whose path Windows could only
// name by volume GUID (GetFinalPathNameByHandle with VOLUME_NAME_DOS failed,
// as it does on some RAM-disk, encrypted-container and shared-folder
// drivers). Such a path cannot be compared with the agent's directory by
// name, but the agent's directory cannot be on a different volume: allow only
// when both volume identities are known and the handle's volume is none of
// the protected ones.
func allowOnUnnamedVolume(volume uint32, volumeKnown bool, protected []uint32, protectedKnown bool) bool {
	if !volumeKnown || !protectedKnown || len(protected) == 0 {
		return false
	}
	for _, p := range protected {
		if p == volume {
			return false
		}
	}
	return true
}
