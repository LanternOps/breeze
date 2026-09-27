package backup

import (
	"crypto/sha256"
	"encoding/hex"
	"path"

	"golang.org/x/text/cases"
	"golang.org/x/text/unicode/norm"
)

// Case-insensitive object stores (#5582).
//
// A file's natural object key is derived from its path
// (prefix/files/<snapshotPath>.gz — see ensureGzipExtension). That key is
// injective on a case-sensitive store (S3, B2, Azure, GCS), but NOT on a
// store backed by a case- or normalization-insensitive filesystem: MinIO
// bind-mounted on APFS/NTFS, or the local provider writing a vault on macOS
// or Windows. There, Linux's case-only twins (xt_CONNMARK.h / xt_connmark.h
// and ~25 others on a stock Ubuntu) address ONE object, the second upload
// silently replaces the first one's bytes, and the backup reports success.
//
// The fix leaves every existing key alone. The manifest already records the
// exact key per entry (SnapshotFile.BackupPath) and restore, verify, GC and
// the API's file index all read that field instead of re-deriving it, so
// only the key CHOICE for a NEW colliding entry has to change: the first
// entry to claim a folded key keeps its natural key; any later entry whose
// natural key folds onto an already-claimed one is stored under
// caseTwinBackupPath instead. Old snapshots stay readable as-is, and a run
// with no twins produces byte-identical keys to before.

// caseTwinDir is the directory under files/ holding disambiguated case-twin
// objects. Every natural key's first segment under files/ is a walk root
// label ("path_<n>", see collectBackupFilesFromPaths), so a key under caseTwinDir can
// never equal — or fold onto — a natural key.
const caseTwinDir = "case-twins"

// foldObjectKey maps k to the form under which a case- and
// normalization-insensitive store would consider two keys the same object.
// It over-approximates on purpose: full Unicode case folding (ß ≡ ss) plus
// NFC (APFS treats NFC and NFD spellings as one name). A false positive
// costs only a disambiguated key; a false negative is silent data loss.
func foldObjectKey(k string) string {
	return norm.NFC.String(cases.Fold().String(norm.NFC.String(k)))
}

// caseTwinBackupPath is the object key for a file whose natural key folds
// onto one already claimed in this snapshot. It reuses the staging-file
// pattern (#5385/#5387, stagingFileName): a lowercase hex SHA-256 of the
// snapshot path is injective across distinct paths — including across
// paths that differ only by case — and immune to folding. The ".gz" suffix
// is load-bearing: the local provider compresses/decompresses on it.
func caseTwinBackupPath(prefix, snapshotPath string) string {
	sum := sha256.Sum256([]byte(snapshotPath))
	return ensureGzipExtension(path.Join(prefix, snapshotFilesDir, caseTwinDir, hex.EncodeToString(sum[:])))
}

// objectKeyClaims tracks which folded object keys a snapshot has already
// assigned, so a later file never lands on an object an earlier one owns.
type objectKeyClaims map[string]struct{}

// claim records key and reports whether its folded form was free.
func (c objectKeyClaims) claim(key string) bool {
	folded := foldObjectKey(key)
	if _, taken := c[folded]; taken {
		return false
	}
	c[folded] = struct{}{}
	return true
}

// assign returns the key a newly uploaded file must use: its natural key
// when that is free, else its case-twin key. The chosen key is claimed.
func (c objectKeyClaims) assign(prefix, snapshotPath, naturalKey string) string {
	if c.claim(naturalKey) {
		return naturalKey
	}
	twin := caseTwinBackupPath(prefix, snapshotPath)
	c.claim(twin)
	return twin
}

// foldCollidingBackupPaths returns the BackupPaths in files that share a
// folded form with at least one OTHER distinct BackupPath. On a
// case-insensitive store those entries all name one object that holds only
// the last writer's bytes, so none of them can be trusted.
func foldCollidingBackupPaths(files []SnapshotFile) map[string]bool {
	byFold := make(map[string]map[string]struct{})
	for _, f := range files {
		if f.BackupPath == "" {
			continue
		}
		folded := foldObjectKey(f.BackupPath)
		if byFold[folded] == nil {
			byFold[folded] = make(map[string]struct{})
		}
		byFold[folded][f.BackupPath] = struct{}{}
	}
	var out map[string]bool
	for _, keys := range byFold {
		if len(keys) < 2 {
			continue
		}
		if out == nil {
			out = make(map[string]bool)
		}
		for k := range keys {
			out[k] = true
		}
	}
	return out
}
