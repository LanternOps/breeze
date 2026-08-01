package backup

import (
	"context"
	"errors"
	"io/fs"
)

// Win32 system error codes (winerror.h) that make a per-file upload failure
// PERMANENT: the source cannot be read on this attempt or any subsequent one,
// so the single 30s retry in createSnapshotWithProgress is pure wasted
// wall-clock (#2997).
//
// Field evidence from a 123,600-file C:\Users run on 0.103.0: 316 files were
// skipped after retry, 2h38m of a 2h41m run was spent asleep in the backoff,
// and every one of those errors was in this set — 254 ERROR_SHARING_VIOLATION
// and 54 ERROR_LOCK_VIOLATION on live browser caches (Chrome/Edge Cache_Data,
// GPUCache, WebView2 leveldb), 16 not-found on cache files that vanished
// between scan and upload. A separate OneDrive repro burned 630s of backoff on
// 21 cloud-only placeholders: the backup helper runs as SYSTEM and cannot
// hydrate a user's placeholder, so ERROR_CLOUD_FILE_ACCESS_DENIED (0x8007017C,
// Win32 code 0x17C) is deterministic there by construction.
//
// The codes are declared here, platform-independently, so the table stays
// unit-testable on macOS/Linux; only the syscall.Errno -> table lookup is
// Windows-gated (permanentUploadErrno, in the _windows/_other files).
// upload_error_class_codes_windows_test.go asserts each value against its
// golang.org/x/sys/windows constant when the suite runs on Windows.
const (
	winErrFileNotFound          uintptr = 2     // ERROR_FILE_NOT_FOUND
	winErrPathNotFound          uintptr = 3     // ERROR_PATH_NOT_FOUND
	winErrSharingViolation      uintptr = 32    // ERROR_SHARING_VIOLATION
	winErrLockViolation         uintptr = 33    // ERROR_LOCK_VIOLATION
	winErrCloudFileAccessDenied uintptr = 0x17C // ERROR_CLOUD_FILE_ACCESS_DENIED
)

// permanentWindowsErrnos maps each permanent Win32 code to its symbolic name,
// which is logged as the skip `reason` so a support reader can tell a locked
// browser cache from an unhydratable OneDrive placeholder without decoding a
// localized message string. Deliberately NOT keyed on error text: the Windows
// messages in the field logs are localized, so string matching would silently
// stop classifying anything on a non-English host.
//
// Deliberately excluded (still retried): ERROR_ACCESS_DENIED (5), which can be
// a transient AV/indexer hold rather than a structural denial, and the rest of
// the ERROR_CLOUD_FILE_* family, which includes genuinely retryable states
// (e.g. ERROR_CLOUD_FILE_NETWORK_UNAVAILABLE). Widening the set is a separate,
// evidence-led change.
var permanentWindowsErrnos = map[uintptr]string{
	winErrFileNotFound:          "ERROR_FILE_NOT_FOUND",
	winErrPathNotFound:          "ERROR_PATH_NOT_FOUND",
	winErrSharingViolation:      "ERROR_SHARING_VIOLATION",
	winErrLockViolation:         "ERROR_LOCK_VIOLATION",
	winErrCloudFileAccessDenied: "ERROR_CLOUD_FILE_ACCESS_DENIED",
}

// lookupPermanentWindowsErrno reports whether a Win32 error code is one that a
// per-file upload retry cannot recover from, along with its symbolic name.
func lookupPermanentWindowsErrno(code uintptr) (string, bool) {
	name, ok := permanentWindowsErrnos[code]
	return name, ok
}

// classifyPermanentUploadError reports whether a per-file upload failure is
// permanent — i.e. re-attempting the same file cannot change the outcome — and
// returns a short reason for the log line.
//
// Callers use this ONLY to decide whether to spend uploadRetryDelay before the
// single retry. It never changes what happens to the file: a permanent failure
// takes the same skip-and-continue path as any other per-file failure, is
// appended to Snapshot.UploadFailures (and so to job.ErrorCount), and never
// aborts the job. Only the sleep goes away.
//
// Conservative by design: anything unrecognised is treated as transient and
// keeps its retry, so a misclassification costs 30s rather than a lost file.
func classifyPermanentUploadError(err error) (string, bool) {
	if err == nil {
		return "", false
	}
	// Cancellation and deadline expiry are lifecycle signals, not source-file
	// verdicts. They are handled by the caller's own errBackupStopped branch;
	// classifying them here would be wrong even though they never recur.
	if errors.Is(err, errBackupStopped) ||
		errors.Is(err, context.Canceled) ||
		errors.Is(err, context.DeadlineExceeded) {
		return "", false
	}
	// Windows-only: the Win32 codes above, matched numerically off the
	// syscall.Errno in the chain (os.File read/open failures surface as
	// *fs.PathError, which CompressFile wraps with %w, so errors.As reaches it).
	if name, ok := permanentUploadErrno(err); ok {
		return name, true
	}
	// Portable: a source file that no longer exists. Covers ENOENT on Unix and
	// (redundantly with the table above) ERROR_FILE_NOT_FOUND /
	// ERROR_PATH_NOT_FOUND on Windows, since syscall.Errno.Is maps both to
	// fs.ErrNotExist. This is the branch that makes the fix meaningful on the
	// agent's Unix builds too — a temp/cache file that vanishes between scan
	// and upload is just as unretryable there.
	if errors.Is(err, fs.ErrNotExist) {
		return "file not found", true
	}
	return "", false
}
