package backup

import "strings"

// Object stores that limit key length (#12692).
//
// A file's natural key is prefix/files/<snapshotPath>.gz. ".gz" adds three
// bytes to the leaf, so a file name of 253 to 255 bytes becomes a key
// segment of 256 to 258 bytes. A store backed by a filesystem (MinIO on a
// disk, the local provider) keeps each segment as a file or directory name
// and refuses a segment over 255 bytes; MinIO answers
// XMinioInvalidObjectName. Those files were never backed up on such a
// store. The same holds for a directory name over 255 bytes, which Windows
// allows (255 UTF-16 units can be up to 765 bytes of UTF-8), and for a
// whole key over 1024 bytes, the limit S3, MinIO, Azure Blob and GCS share.
//
// Such a file is stored under longNameBackupPath instead: a fixed-length
// hashed key, the same scheme as case twins (objectkey_casefold.go). The
// manifest records each entry's exact key (SnapshotFile.BackupPath), and
// restore, verify, GC and the API read that field rather than re-deriving
// it; restore takes the file's name from SourcePath, never from the key.
// So a snapshot written before this change restores exactly as before, and
// every file whose natural key fits keeps that same key.

const (
	// maxObjectKeySegmentBytes is the longest key segment a filesystem-
	// backed store accepts: NAME_MAX on ext4, XFS and APFS.
	maxObjectKeySegmentBytes = 255
	// maxObjectKeyBytes is the longest whole key S3-compatible stores,
	// Azure Blob and GCS accept.
	maxObjectKeyBytes = 1024

	// longNameDir is the directory under files/ holding objects whose
	// natural key exceeds those limits. Like caseTwinDir it does not start
	// with "path_", so its keys never equal or fold onto a natural key, and
	// it differs from caseTwinDir so the two schemes never share a key.
	longNameDir = "long-names"
)

// objectKeyFitsStore reports whether key is within the limits every
// supported store accepts: no '/'-separated segment over 255 bytes and no
// more than 1024 bytes in all.
func objectKeyFitsStore(key string) bool {
	if len(key) > maxObjectKeyBytes {
		return false
	}
	for seg := range strings.SplitSeq(key, "/") {
		if len(seg) > maxObjectKeySegmentBytes {
			return false
		}
	}
	return true
}

// longNameBackupPath is the object key for a file whose natural key does
// not fit (objectKeyFitsStore). Its longest segment is 67 bytes.
func longNameBackupPath(prefix, snapshotPath string) string {
	return hashedBackupPath(prefix, longNameDir, snapshotPath)
}
