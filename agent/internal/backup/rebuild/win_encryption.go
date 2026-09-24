// win_encryption.go — the Windows encryption phase (W06c Part C Task 15).
// The intent file is written through r.rootVolume, never the r.rootDir
// folder mount (ruling B1/C1).
package rebuild

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/breeze-rmm/agent/internal/backup/layout"
)

// postRestoreActions is the intent file W07's agent-side executor reads at
// first boot (Global Constraint "Encryption"). Field order is the wire
// order: the file is exactly
// {"schemaVersion":1,"bitlocker":{...},"winre":{...}}.
type postRestoreActions struct {
	SchemaVersion int                   `json:"schemaVersion"`
	BitLocker     *postRestoreBitLocker `json:"bitlocker,omitempty"`
	WinRE         postRestoreWinRE      `json:"winre"`
}

type postRestoreBitLocker struct {
	Reencrypt bool   `json:"reencrypt"`
	Volume    string `json:"volume"`
}

type postRestoreWinRE struct {
	Enable bool   `json:"enable"`
	Reason string `json:"reason"`
}

// rootIsBitLocker reports whether the source's root partition was
// BitLocker-protected at backup, per the layout manifest.
func rootIsBitLocker(r *run) bool {
	if r.layout == nil {
		return false
	}
	d := r.layout.SystemDisk()
	if d == nil {
		return false
	}
	for _, p := range d.Partitions {
		if p.Role == layout.RoleRoot {
			return p.Encryption == layout.EncryptionBitLocker
		}
	}
	return false
}

// winEncryption: a BitLocker source is always restored plaintext. A disk:
// target records re-encryption intent for W07's executor (D-BL); a vhdx:
// rehearsal image is left unencrypted (R23, R24). No RunOnce.
func winEncryption(_ context.Context, r *run) error {
	if !rootIsBitLocker(r) {
		r.recordSkipped(PhaseEncryption, "source root partition was not BitLocker-protected")
		return nil
	}
	if r.opts.Target.Kind == TargetVHDX {
		r.recordSkipped(PhaseEncryption, "rehearsal image left unencrypted")
		return nil
	}
	if r.rootVolume == "" {
		return errors.New("encryption: no root volume recorded for this run")
	}
	dir := filepath.Join(winBreezeDir(r), "data")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(postRestoreActions{
		SchemaVersion: 1,
		BitLocker:     &postRestoreBitLocker{Reencrypt: true, Volume: "C:"},
		WinRE:         postRestoreWinRE{Enable: false, Reason: "recovery partition contents were not backed up"},
	})
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "post-restore-actions.json"), data, 0o600); err != nil {
		return err
	}
	r.warn("volume C: was BitLocker-protected at backup; it is restored unencrypted; re-encryption on first boot arrives with the Windows recovery media (W07)")
	return nil
}
