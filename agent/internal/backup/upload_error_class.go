package backup

import (
	"context"
	"errors"
	"io/fs"
)

// uploadRetryPolicy is the verdict classifyUploadFailure returns for a per-file
// upload failure: how much wall-clock the caller should spend before the single
// retry, or whether to skip the file outright.
//
// It NEVER changes what happens to a file that ultimately fails: every failed
// file takes the same skip-and-continue path, is appended to
// Snapshot.UploadFailures (and so to job.ErrorCount), and never aborts the job.
// Only the sleep changes.
//
// The one thing in the upload loop that CAN end a run early is the separate
// sourceLiveness probe (see source_liveness.go) — but that is a verdict on the
// source snapshot as a whole, not on any file, and nothing here influences it.
type uploadRetryPolicy int

const (
	// retryAfterDefaultDelay waits the full uploadRetryDelay before retrying
	// once. The conservative default for anything unrecognised: a
	// misclassification costs 30s of wall-clock, never a lost file.
	retryAfterDefaultDelay uploadRetryPolicy = iota

	// retryAfterShortDelay waits only shortUploadRetryDelay before retrying
	// once. For a permission denial on the SOURCE file: overwhelmingly an NTFS
	// ACL that will never clear, but occasionally a transient AV/indexer/filter
	// -driver hold, which clears in well under a second. Keeping the retry
	// preserves the safety net; shortening it removes the 30s-per-file stall
	// (#3259).
	retryAfterShortDelay

	// skipWithoutRetry retries not at all. For a source that is locked by a
	// live process, already gone, or an unhydratable cloud placeholder: a retry
	// cannot change the outcome, so the backoff is pure waste (#2997/#3002).
	skipWithoutRetry
)

// Win32 system error codes (winerror.h) that let a per-file upload failure be
// classified more precisely than "unknown, wait 30s and retry".
//
// Field evidence from a 123,600-file C:\Users run on 0.103.0: 316 files were
// skipped after retry, 2h38m of a 2h41m run was spent asleep in the backoff,
// and every one of those errors was in the permanent set — 254
// ERROR_SHARING_VIOLATION and 54 ERROR_LOCK_VIOLATION on live browser caches
// (Chrome/Edge Cache_Data, GPUCache, WebView2 leveldb), 16 not-found on cache
// files that vanished between scan and upload. A separate OneDrive repro burned
// 630s of backoff on 21 cloud-only placeholders: the backup helper runs as
// SYSTEM and cannot hydrate a user's placeholder, so
// ERROR_CLOUD_FILE_ACCESS_DENIED is deterministic there by construction. A
// third repro (v0.104.0, Windows Server 2022, 2026-08-07) measured +27-29s per
// plain-ACL-denied file across 40-file runs — the ERROR_ACCESS_DENIED case
// below.
//
// The codes are declared here, platform-independently, so the table stays
// unit-testable on macOS/Linux; only the syscall.Errno -> table lookup is
// Windows-gated (windowsUploadErrnoPolicy, in the _windows/_other files).
// upload_error_class_codes_windows_test.go asserts each value against its
// golang.org/x/sys/windows constant, and CI runs that file on Windows.
const (
	winErrFileNotFound     uintptr = 2  // ERROR_FILE_NOT_FOUND
	winErrPathNotFound     uintptr = 3  // ERROR_PATH_NOT_FOUND
	winErrAccessDenied     uintptr = 5  // ERROR_ACCESS_DENIED
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

// windowsUploadErrno pairs a Win32 code's retry policy with its symbolic name,
// which is logged as the `reason` so a support reader can tell a locked browser
// cache from an unhydratable OneDrive placeholder from an ACL denial without
// decoding a localized message string. Deliberately NOT keyed on error text:
// the Windows messages in the field logs are localized, so string matching
// would silently stop classifying anything on a non-English host.
type windowsUploadErrno struct {
	name   string
	policy uploadRetryPolicy
}

// windowsUploadErrnos is the Win32 code -> policy table.
//
// ERROR_ACCESS_DENIED (5) is retryAfterShortDelay rather than skipWithoutRetry
// on purpose. The denial is almost always a structural NTFS ACL, but an AV/EDR
// filter driver or the search indexer can also deny a CreateFile transiently —
// and, critically, such a driver denies for ANY requested access mask, so
// re-probing the file with FILE_READ_ATTRIBUTES cannot distinguish the two
// cases. There is no reliable discriminator, and a false "permanent" verdict
// would silently drop a healthy file from a backup. Keeping one retry and
// shortening the wait gets ~97% of the time back with none of that risk.
//
// Still deliberately excluded (full retry): the rest of the ERROR_CLOUD_FILE_*
// family, which includes genuinely retryable states (e.g.
// ERROR_CLOUD_FILE_NETWORK_UNAVAILABLE). Widening the set is a separate,
// evidence-led change.
var windowsUploadErrnos = map[uintptr]windowsUploadErrno{
	winErrFileNotFound:          {"ERROR_FILE_NOT_FOUND", skipWithoutRetry},
	winErrPathNotFound:          {"ERROR_PATH_NOT_FOUND", skipWithoutRetry},
	winErrSharingViolation:      {"ERROR_SHARING_VIOLATION", skipWithoutRetry},
	winErrLockViolation:         {"ERROR_LOCK_VIOLATION", skipWithoutRetry},
	winErrCloudFileAccessDenied: {"ERROR_CLOUD_FILE_ACCESS_DENIED", skipWithoutRetry},
	winErrAccessDenied:          {"ERROR_ACCESS_DENIED", retryAfterShortDelay},
}

// lookupWindowsUploadErrno reports the retry policy for a Win32 error code,
// along with its symbolic name. ok is false for any code not in the table,
// which keeps its full retry.
func lookupWindowsUploadErrno(code uintptr) (string, uploadRetryPolicy, bool) {
	entry, ok := windowsUploadErrnos[code]
	if !ok {
		return "", retryAfterDefaultDelay, false
	}
	return entry.name, entry.policy, true
}

// classifyUploadFailure decides how a per-file upload failure should be
// retried, and returns a short reason for the log line. sourcePath is the file
// being backed up, and is required: see the source-attribution step below.
//
// Conservative by design: anything unrecognised gets retryAfterDefaultDelay and
// keeps its full backoff, so a misclassification costs wall-clock rather than a
// lost file.
func classifyUploadFailure(err error, sourcePath string) (uploadRetryPolicy, string) {
	if err == nil {
		return retryAfterDefaultDelay, ""
	}
	// Cancellation and deadline expiry are lifecycle signals, not source-file
	// verdicts. They are handled by the caller's own errBackupStopped branch;
	// classifying them here would be wrong even though they never recur.
	if errors.Is(err, errBackupStopped) ||
		errors.Is(err, context.Canceled) ||
		errors.Is(err, context.DeadlineExceeded) {
		return retryAfterDefaultDelay, ""
	}
	// Only a failure attributable to the SOURCE file can be classified, so the
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
		return retryAfterDefaultDelay, ""
	}
	// Windows-only: the Win32 codes above, matched numerically off the
	// syscall.Errno the *fs.PathError carries. Checked before the portable
	// branches so the log line carries the precise symbolic name.
	if name, policy, ok := windowsUploadErrnoPolicy(pathErr.Err); ok {
		return policy, name
	}
	// Portable: a source file that no longer exists. Covers ENOENT on Unix and
	// (redundantly with the table above) ERROR_FILE_NOT_FOUND /
	// ERROR_PATH_NOT_FOUND on Windows, since syscall.Errno.Is maps both to
	// fs.ErrNotExist. This is the branch that makes the fix meaningful on the
	// agent's Unix builds too — a temp/cache file that vanishes between scan
	// and upload is just as unretryable there.
	if errors.Is(pathErr, fs.ErrNotExist) {
		return skipWithoutRetry, "file not found"
	}
	// Portable: a source file the agent is not permitted to read. Covers
	// EACCES/EPERM on Unix and (redundantly with the table above)
	// ERROR_ACCESS_DENIED on Windows — syscall.Errno.Is maps exactly those
	// three to fs.ErrPermission, and notably NOT ERROR_SHARING_VIOLATION,
	// which reaches skipWithoutRetry only via the Win32 table. Same reasoning
	// as the table entry: a permission denial on the source is overwhelmingly
	// structural, so it keeps exactly one retry but not the 30s wait.
	//
	// Reached only for codes the table did not resolve, so on Windows the
	// table's more specific verdict and reason string always win. That
	// ordering is asserted by TestClassifyUploadFailure_RealWindowsErrno.
	if errors.Is(pathErr, fs.ErrPermission) {
		return retryAfterShortDelay, "permission denied"
	}
	return retryAfterDefaultDelay, ""
}
