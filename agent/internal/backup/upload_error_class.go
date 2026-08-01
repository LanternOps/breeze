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
// hydrate a user's placeholder, so ERROR_CLOUD_FILE_ACCESS_DENIED is
// deterministic there by construction.
//
// The codes are declared here, platform-independently, so the table stays
// unit-testable on macOS/Linux; only the syscall.Errno -> table lookup is
// Windows-gated (permanentUploadErrno, in the _windows/_other files).
// upload_error_class_codes_windows_test.go asserts each value against its
// golang.org/x/sys/windows constant, and CI runs that file on Windows.
const (
	winErrFileNotFound     uintptr = 2  // ERROR_FILE_NOT_FOUND
	winErrPathNotFound     uintptr = 3  // ERROR_PATH_NOT_FOUND
	winErrSharingViolation uintptr = 32 // ERROR_SHARING_VIOLATION
	winErrLockViolation    uintptr = 33 // ERROR_LOCK_VIOLATION
	// ERROR_CLOUD_FILE_ACCESS_DENIED, HRESULT 0x8007018B. NOTE: #2997 quotes
	// the HRESULT as 0x8007017C, whose Win32 code (380) is actually
	// ERROR_CLOUD_FILE_INVALID_REQUEST. The message logged in that repro —
	// "Access to the cloud file is denied." — is emitted only by 395, and Go
	// renders the message from the errno it holds, so 395 is the code that
	// actually occurred and 0x8007017C is a transcription slip in the report.
	winErrCloudFileAccessDenied uintptr = 0x18B // 395
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
// returns a short reason for the log line. sourcePath is the file being backed
// up, and is required: see the source-attribution step below.
//
// Callers use this ONLY to decide whether to spend uploadRetryDelay before the
// single retry. It never changes what happens to the file: a permanent failure
// takes the same skip-and-continue path as any other per-file failure, is
// appended to Snapshot.UploadFailures (and so to job.ErrorCount), and never
// aborts the job. Only the sleep goes away.
//
// Conservative by design: anything unrecognised is treated as transient and
// keeps its retry, so a misclassification costs 30s rather than a lost file.
func classifyPermanentUploadError(err error, sourcePath string) (string, bool) {
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
	// Only a failure attributable to the SOURCE file can be permanent, so the
	// chain must contain an *fs.PathError naming it. Every provider opens the
	// source with os.Open(localPath) and wraps the result with %w
	// (providers/{s3,azure,gcs,b2}.go, providers/local.go), so a real
	// source-read failure always carries one.
	//
	// This guard is load-bearing, not defensive: LocalProvider also creates the
	// DESTINATION per file (os.MkdirAll/os.Create, providers/local.go), and a
	// destination on a UNC path or mapped drive that drops mid-run returns
	// ERROR_PATH_NOT_FOUND / ENOENT. Without the check, a 20-second share blip
	// would classify every remaining file permanent and drain the rest of the
	// backup at memory speed with zero retries — turning the 30s backoff, which
	// is the only thing absorbing short destination outages, into mass data
	// loss. An unrecognised error shape simply keeps its retry.
	var pathErr *fs.PathError
	if !errors.As(err, &pathErr) || pathErr.Path != sourcePath {
		return "", false
	}
	// Windows-only: the Win32 codes above, matched numerically off the
	// syscall.Errno the *fs.PathError carries.
	if name, ok := permanentUploadErrno(pathErr.Err); ok {
		return name, true
	}
	// Portable: a source file that no longer exists. Covers ENOENT on Unix and
	// (redundantly with the table above) ERROR_FILE_NOT_FOUND /
	// ERROR_PATH_NOT_FOUND on Windows, since syscall.Errno.Is maps both to
	// fs.ErrNotExist. This is the branch that makes the fix meaningful on the
	// agent's Unix builds too — a temp/cache file that vanishes between scan
	// and upload is just as unretryable there.
	if errors.Is(pathErr, fs.ErrNotExist) {
		return "file not found", true
	}
	return "", false
}
