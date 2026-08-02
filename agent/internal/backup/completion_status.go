package backup

// partialFailureThreshold is the fraction of a run's work that may fail before
// the run stops being reported as `completed` and is reported as `partial`
// instead.
//
// Why a threshold rather than "any error downgrades the job": partial success
// is a deliberate design (see RunBackupContext's upload-failure block). A run
// that skipped 2 locked files out of 5,000 IS a good restore point, and
// promoting it out of `completed` would train operators to ignore the signal.
// What the design was missing is PROPORTIONALITY: before this, a run that
// stored 85 bytes of 3.2 MB carried exactly the same terminal status as a clean
// one (#3000).
//
// 10% is a deliberately blunt round number, chosen against the two field cases
// in #3000: 317 failures out of 123,600 files (0.26%) stays `completed`, while
// 21 of 22 files / 85 bytes of 3.2 MB (>99%) becomes `partial`. It is a
// constant rather than per-policy configuration on purpose — a tunable would
// need a policy column, a UI and a fan-out story, and there is no evidence yet
// that one threshold does not fit. Revisit if the field says otherwise.
const partialFailureThreshold = 0.10

// classifyCompletionStatus decides whether a run that produced a real snapshot
// should be reported as `completed` or `partial`.
//
// Two independent gates, either of which downgrades the run:
//
//   - BYTES (primary): the fraction of scanned bytes that did not make it into
//     the snapshot. Bytes are the better denominator than a file count because
//     one huge failed file matters more than a hundred tiny ones — a run that
//     uploaded 99 of 100 files but missed the single 90 GB database is not a
//     usable restore point.
//   - FILES (secondary): the fraction of attempted files that failed. This gate
//     exists because the byte gate is blind to COLLECTION failures: a file
//     whose os.Stat failed has no known size, so it contributes nothing to
//     scannedBytes and would otherwise be invisible no matter how many of them
//     there were.
//
// Both comparisons are strictly-greater-than, so a run sitting exactly on the
// threshold keeps the status it had before this change.
//
// The function is total and never panics: zero denominators skip their gate,
// and a protectedBytes larger than scannedBytes (defensive — it should not
// happen) clamps to zero failed bytes rather than producing a negative ratio
// that would suppress the other gate.
func classifyCompletionStatus(protectedBytes, scannedBytes int64, failedFiles, attemptedFiles int) string {
	// Nothing failed: there is no proportion to judge. Short-circuited so a
	// clean run can never be downgraded by byte arithmetic (reference/dedupe
	// accounting edge cases included).
	if failedFiles <= 0 {
		return jobStatusCompleted
	}

	if scannedBytes > 0 {
		failedBytes := scannedBytes - protectedBytes
		if failedBytes > 0 && float64(failedBytes)/float64(scannedBytes) > partialFailureThreshold {
			return jobStatusPartial
		}
	}

	if attemptedFiles > 0 && float64(failedFiles)/float64(attemptedFiles) > partialFailureThreshold {
		return jobStatusPartial
	}

	return jobStatusCompleted
}

// totalScannedBytes sums the sizes the collection pass observed, i.e. the bytes
// this run set out to protect. It is the denominator of the byte gate above.
// Files that failed COLLECTION are absent from this slice entirely (their size
// is unknown because os.Stat is what failed), which is precisely why
// classifyCompletionStatus also carries a file-count gate.
func totalScannedBytes(files []backupFile) int64 {
	var total int64
	for _, f := range files {
		if f.size > 0 {
			total += f.size
		}
	}
	return total
}
