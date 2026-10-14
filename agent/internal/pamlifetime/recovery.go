package pamlifetime

import (
	"context"
)

// Missing-account recovery needs independent evidence: a deleted account can
// leave a running token behind, including after a crash before BindProcess.
// Platforms without these probes must retain the normal fail-closed path.
type absentAccountRecoveryPrimitives interface {
	VerifyElevationAccountAbsent(context.Context) (bool, error)
	VerifyJobAbsent(context.Context, string) (bool, error)
	VerifyNoOrphanedAccountToken(context.Context) (bool, error)
}

func (m *lifecycleManager) recoverAbsentAccountEntry(ctx context.Context, entry LedgerEntry) (Result, bool) {
	probes, supported := m.windows.(absentAccountRecoveryPrimitives)
	if !supported || m.store.LoadError() != nil {
		return Result{}, false
	}
	// Account lookup alone selects the recovery path; it does not prove token
	// absence. Existing accounts take the normal path without first performing
	// an extra full-process scan just to discover that recovery is unnecessary.
	accountAbsent, err := probes.VerifyElevationAccountAbsent(ctx)
	if err != nil || !accountAbsent {
		return Result{}, false
	}
	bootID, err := m.currentBootID(ctx)
	if err != nil {
		return Result{}, false
	}
	hasAnyIdentity := entry.PID != 0 || entry.ProcessCreationTime != nil || entry.JobName != "" || entry.BootID != ""
	complete := entry.PID > 0 && entry.ProcessCreationTime != nil && entry.JobName != "" && entry.BootID != ""
	if hasAnyIdentity && !complete {
		return Result{}, false
	}
	jobName := entry.JobName
	if jobName == "" {
		jobName = JobName(entry.ActuationID, entry.Generation)
	}
	absent, err := probes.VerifyJobAbsent(ctx, jobName)
	if err != nil || !absent {
		return Result{}, false
	}
	if complete && entry.BootID == bootID {
		gone, err := m.windows.VerifyProcessIdentityGone(ctx, ProcessIdentity{PID: entry.PID, ProcessCreationTime: *entry.ProcessCreationTime, JobName: entry.JobName, BootID: entry.BootID})
		if err != nil || !gone {
			return Result{}, false
		}
	}
	// Even a vanished recorded process cannot exclude an escaped child holding
	// the deleted SID. Scan tokens independently; any unresolvable identity is
	// unknown and prevents recovery.
	orphan, err := probes.VerifyNoOrphanedAccountToken(ctx)
	if err != nil || orphan {
		return Result{}, false
	}
	deprovisioned, err := m.account.Deprovision(ctx)
	if err != nil || deprovisioned.Enabled || deprovisioned.InAdministrators {
		return Result{}, false
	}
	clean, err := m.account.VerifyClean(ctx)
	if err != nil || clean.Enabled || clean.InAdministrators {
		return Result{}, false
	}
	// Recheck the SID after the probes so concurrent account provisioning cannot
	// turn missing-account evidence into a claim about a newly created account.
	if absent, err := probes.VerifyElevationAccountAbsent(ctx); err != nil || !absent {
		return Result{}, false
	}
	if err := m.store.MarkReconciledClean(entry.ActuationID, entry.Generation); err != nil {
		return m.failed(entry.ActuationID, entry.Generation, bootID, "persist_cleanup_evidence_failed"), true
	}
	m.setAccountAbsent(true)
	evidence := evidenceFromEntry(entry)
	evidence.BootID = bootID
	evidence.JobMemberCount = intPtr(0)
	evidence.JobObjectAbsent = boolPtr(true)
	evidence.AccountEnabled = boolPtr(false)
	evidence.AccountInAdministrators = boolPtr(false)
	evidence.PrivilegedTokenPresent = boolPtr(false)
	result := m.result(entry.ActuationID, entry.Generation, ResultCleaned, evidence)
	if entry.DesiredState == DesiredActive || entry.RecoveredFromActive {
		// The server has not requested cleanup at this generation. Report the
		// failed grant with verified clean evidence instead of claiming a
		// server cleanup transition that never happened.
		result.State = ResultFailed
		result.FailureCode = "reconciled_account_absent"
	}
	return result, true
}

// verifiedCleanupOutcome distinguishes fresh clean endpoint evidence from a
// successful server cleanup transition. A recovered active generation remains
// a failed grant until the server requests its next cleanup generation.
func verifiedCleanupOutcome(result Result) bool {
	if result.State == ResultCleaned {
		return true
	}
	e := result.Evidence
	return result.State == ResultFailed && result.FailureCode == "reconciled_account_absent" &&
		e.JobMemberCount != nil && *e.JobMemberCount == 0 &&
		e.AccountEnabled != nil && !*e.AccountEnabled &&
		e.AccountInAdministrators != nil && !*e.AccountInAdministrators &&
		e.PrivilegedTokenPresent != nil && !*e.PrivilegedTokenPresent
}

func (m *lifecycleManager) reconcileRecoveredCleanEntry(ctx context.Context, entry LedgerEntry) Result {
	if recovered, ok := m.recoverAbsentAccountEntry(ctx, entry); ok {
		return recovered
	}
	bootID, err := m.currentBootID(ctx)
	if err != nil {
		return m.failed(entry.ActuationID, entry.Generation, bootID, "boot_id_unavailable")
	}
	probes, supported := m.windows.(absentAccountRecoveryPrimitives)
	if !supported || m.store.LoadError() != nil || entry.PID != 0 || entry.JobName != "" || entry.ProcessCreationTime != nil || entry.BootID != "" {
		return m.failed(entry.ActuationID, entry.Generation, bootID, "reconcile_identity_unavailable")
	}
	absent, err := probes.VerifyJobAbsent(ctx, JobName(entry.ActuationID, entry.Generation))
	if err != nil || !absent {
		return m.failed(entry.ActuationID, entry.Generation, bootID, "active_job_unavailable")
	}
	orphan, err := probes.VerifyNoOrphanedAccountToken(ctx)
	if err != nil || orphan {
		return m.failed(entry.ActuationID, entry.Generation, bootID, "privileged_token_verification_failed")
	}
	evidence := ResultEvidence{BootID: bootID, JobMemberCount: intPtr(0), JobObjectAbsent: boolPtr(true)}
	evidence, code, verified := m.verifyAccountClean(ctx, evidence)
	if !verified {
		return m.failed(entry.ActuationID, entry.Generation, bootID, code)
	}
	result := m.result(entry.ActuationID, entry.Generation, ResultFailed, evidence)
	result.FailureCode = "reconciled_account_absent"
	return result
}
