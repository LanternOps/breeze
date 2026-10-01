package backup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"

	"github.com/breeze-rmm/agent/internal/backup/layout"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backup/systemstate"
)

// Result warning codes for snapshot attestation. Each is the first token of
// the warning text so the server-side job log can be searched for it.
const (
	// warnAttestationUnavailable: the run published a snapshot but could not
	// vouch for all of its control objects, so it reports no attestation.
	warnAttestationUnavailable = "attestation_unavailable"
	// warnAttestationUnavailableResumedPublish: a resumed run found its
	// snapshot's manifest already published and could not prove the stored
	// control objects are the ones its own earlier attempt uploaded.
	warnAttestationUnavailableResumedPublish = "attestation_unavailable_resumed_publish"
	// warnJournalDiscardedOldFormat: an interrupted run's checkpoint written
	// by an older helper was discarded instead of resumed.
	warnJournalDiscardedOldFormat = "journal_discarded_old_format"
	// warnJournalDiscardedOtherRun: an interrupted run's checkpoint was
	// written for a different job, dispatched base or destination and was
	// discarded instead of resumed.
	warnJournalDiscardedOtherRun = "journal_discarded_other_run"
)

// NewAttestationEnvelope builds and encodes a format-1 statement for
// snapshotID over objects (keyed by role). dispatchedBase and parent follow
// the statement's rules: nil for none, and parent is nil or equal to
// dispatchedBase.
func NewAttestationEnvelope(snapshotID, jobID, agentID string, dispatchedBase, parent *string, objects map[string]PublishedObject) (*AttestationEnvelope, error) {
	list := make([]PublishedObject, 0, len(objects))
	for role, o := range objects {
		if o.Role != role {
			return nil, fmt.Errorf("control object recorded under role %q names role %q", role, o.Role)
		}
		list = append(list, o)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Role < list[j].Role })
	statement, err := EncodeAttestationStatement(AttestationStatement{
		V:                        AttestationFormatVersion,
		SnapshotID:               snapshotID,
		JobID:                    jobID,
		AgentID:                  agentID,
		DispatchedBaseSnapshotID: dispatchedBase,
		ParentSnapshotID:         parent,
		KeyLayout:                AttestationKeyLayoutLegacyFlat,
		Objects:                  list,
	})
	if err != nil {
		return nil, err
	}
	return &AttestationEnvelope{Statement: statement}, nil
}

// PublishControlObject uploads the control object at localPath (a file the
// caller wrote and nothing else modifies) as role's key under snapshotID and
// returns it with the digest of the uploaded bytes. For callers outside this
// package; a cancelled ctx surfaces as ctx.Err().
func PublishControlObject(ctx context.Context, provider providers.BackupProvider, stagingDir, role, snapshotID, localPath string) (PublishedObject, error) {
	obj, err := publishControlObject(ctx, provider, stagingDir, nil, role, snapshotID, localPath)
	if errors.Is(err, errBackupStopped) {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return obj, ctxErr
		}
		return obj, fmt.Errorf("upload of %s control object stopped", role)
	}
	return obj, err
}

// dispatchedBase returns the server-pinned base as the statement carries it:
// nil for a full dispatch ("") and for a legacy run (no pin at all).
func (m *BackupManager) dispatchedBase() *string {
	if m.config.BaseSnapshotID == nil || *m.config.BaseSnapshotID == "" {
		return nil
	}
	id := *m.config.BaseSnapshotID
	return &id
}

// canAttest reports whether this run is one the server can bind an
// attestation to: a server-owned dispatch (a base pin, possibly empty) with a
// job id, from an enrolled agent.
func (m *BackupManager) canAttest() bool {
	return m.config.BaseSnapshotID != nil && m.config.JobID != "" && m.config.AgentID != ""
}

// attestPublishedSnapshot attaches an attestation over the control objects
// this run published for snapshot. parent is the base the run actually used
// (nil for a full run). The statement must match what the result reports:
// a layout object exactly when the result carries a layout manifest, a
// system-state object exactly when it carries a system-state manifest, and
// no inherited entries on a full run.
func (m *BackupManager) attestPublishedSnapshot(job *BackupJob, snapshot *Snapshot, parent *string) {
	if snapshot == nil || !m.canAttest() {
		return
	}
	objects := snapshot.PublishedObjects
	reason := ""
	switch {
	case snapshot.attestationWithheld != "":
		reason = snapshot.attestationWithheld
	case len(objects) == 0 || objects[AttestationRoleManifest].Key == "":
		reason = "the manifest was not published by this run"
	case (job.LayoutManifest != nil) != (objects[AttestationRoleLayout].Key != ""):
		reason = "the layout manifest reported does not match the one published"
	case (job.SystemStateManifest != nil) != (objects[AttestationRoleSystemStateManifest].Key != ""):
		reason = "the system state manifest reported does not match the one published"
	case parent == nil && job.ReferencedFiles > 0:
		reason = "a full run reported inherited files"
	}
	if reason == "" {
		env, err := NewAttestationEnvelope(snapshot.ID, m.config.JobID, m.config.AgentID, m.dispatchedBase(), parent, objects)
		if err == nil {
			job.Attestation = env
			return
		}
		reason = err.Error()
	}
	log.Warn("snapshot published without an attestation", "snapshotId", snapshot.ID, "reason", reason)
	appendWarning(job, warnAttestationUnavailable+": "+reason)
}

// attestAdoptedSnapshot handles a resumed run that found its journaled
// snapshot's manifest already published (the earlier attempt finished the
// upload but not its bookkeeping). The run did not upload those objects in
// this attempt, so it attests them only when every control object in storage
// is byte-for-byte one its journal recorded for THIS job and dispatch, and no
// control object exists that the journal never recorded. The layout and
// system-state manifests are then reported in the result as well, as a
// normal run would.
func (m *BackupManager) attestAdoptedSnapshot(ctx context.Context, job *BackupJob, journal *snapshotJournal, existing *Snapshot, manifest providers.UploadDigest) {
	if existing == nil || !m.canAttest() {
		return
	}
	lm, ssm, objects, parent, reason := m.verifyAdoptedControlObjects(ctx, journal, existing, manifest)
	if reason == "" {
		job.LayoutManifest = lm
		if lm != nil && job.BareMetal == nil {
			verdict := layout.Assess(lm)
			job.BareMetal = &verdict
		}
		job.SystemStateManifest = ssm
		if parent == nil && job.ReferencedFiles > 0 {
			reason = "a full run reported inherited files"
		} else {
			env, err := NewAttestationEnvelope(existing.ID, m.config.JobID, m.config.AgentID, m.dispatchedBase(), parent, objects)
			if err == nil {
				job.Attestation = env
				return
			}
			reason = err.Error()
		}
	}
	log.Warn("resumed snapshot adopted without an attestation", "snapshotId", existing.ID, "reason", reason)
	appendWarning(job, warnAttestationUnavailableResumedPublish+": "+reason)
}

func (m *BackupManager) verifyAdoptedControlObjects(ctx context.Context, journal *snapshotJournal, existing *Snapshot, manifest providers.UploadDigest) (*layout.Manifest, *systemstate.SystemStateManifest, map[string]PublishedObject, *string, string) {
	h := journal.Header()
	dispatched := ""
	if m.config.BaseSnapshotID != nil {
		dispatched = *m.config.BaseSnapshotID
	}
	switch {
	case h.FormatVersion < journalFormatVersion:
		return nil, nil, nil, nil, "the checkpoint predates attestation"
	case h.JobID == "" || h.JobID != m.config.JobID:
		return nil, nil, nil, nil, "the manifest was published by a different job"
	case h.DispatchedBaseSnapshotID != dispatched:
		return nil, nil, nil, nil, "the manifest was published for a different dispatched base"
	case !h.BaseDecided:
		return nil, nil, nil, nil, "the checkpoint does not record the base the run used"
	case h.ParentSnapshotID != existing.BaseSnapshotID:
		return nil, nil, nil, nil, "the published manifest names a different base than the checkpoint"
	}
	recorded := make(map[string]PublishedObject, len(h.PublishedObjects))
	for _, o := range h.PublishedObjects {
		recorded[o.Role] = o
	}
	objects := map[string]PublishedObject{}
	var lm *layout.Manifest
	var ssm *systemstate.SystemStateManifest
	for _, role := range []string{AttestationRoleLayout, AttestationRoleManifest, AttestationRoleSystemStateManifest} {
		key, _ := ControlObjectKey(existing.ID, role)
		var data []byte
		var got providers.UploadDigest
		present := true
		if role == AttestationRoleManifest {
			got = manifest
		} else {
			var err error
			data, got, present, err = downloadControlObject(ctx, m.config.Provider, key)
			if err != nil {
				return nil, nil, nil, nil, fmt.Sprintf("could not read %s back from storage", key)
			}
		}
		rec, wasRecorded := recorded[role]
		switch {
		case !present && !wasRecorded:
			continue
		case !present:
			return nil, nil, nil, nil, fmt.Sprintf("%s recorded in the checkpoint is missing from storage", key)
		case !wasRecorded:
			return nil, nil, nil, nil, fmt.Sprintf("%s is in storage but was not recorded in the checkpoint", key)
		case rec.Key != key || rec.SHA256 != got.SHA256 || rec.Size != got.Size:
			return nil, nil, nil, nil, fmt.Sprintf("%s in storage differs from the one recorded in the checkpoint", key)
		}
		objects[role] = rec
		switch role {
		case AttestationRoleLayout:
			lm = &layout.Manifest{}
			if err := json.Unmarshal(data, lm); err != nil {
				return nil, nil, nil, nil, fmt.Sprintf("could not decode %s", key)
			}
		case AttestationRoleSystemStateManifest:
			ssm = &systemstate.SystemStateManifest{}
			if err := json.Unmarshal(data, ssm); err != nil {
				return nil, nil, nil, nil, fmt.Sprintf("could not decode %s", key)
			}
		}
	}
	var parent *string
	if h.ParentSnapshotID != "" {
		p := h.ParentSnapshotID
		parent = &p
	}
	return lm, ssm, objects, parent, ""
}

// downloadControlObject reads key back from storage. present is false only
// when the provider positively confirms the object does not exist.
func downloadControlObject(ctx context.Context, provider providers.BackupProvider, key string) (data []byte, digest providers.UploadDigest, present bool, err error) {
	if err := ctx.Err(); err != nil {
		return nil, providers.UploadDigest{}, false, err
	}
	tmp, err := os.CreateTemp("", "control-object-*.json")
	if err != nil {
		return nil, providers.UploadDigest{}, false, err
	}
	tmpPath := tmp.Name()
	_ = tmp.Close()
	defer func() { _ = os.Remove(tmpPath) }()
	if err := provider.Download(key, tmpPath); err != nil {
		if errors.Is(err, providers.ErrObjectNotFound) {
			return nil, providers.UploadDigest{}, false, nil
		}
		return nil, providers.UploadDigest{}, false, err
	}
	data, err = os.ReadFile(tmpPath)
	if err != nil {
		return nil, providers.UploadDigest{}, false, err
	}
	return data, digestBytes(data), true, nil
}
