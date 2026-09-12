package heartbeat

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/breeze-rmm/agent/internal/config"
)

// recoveryMarkerDataDir is a seam over config.GetDataDir so tests can point
// the ack-on-response path (processHeartbeatResponse) at a temp directory
// instead of the real platform data dir. Production never overrides it.
var recoveryMarkerDataDir = config.GetDataDir

// RecoveryMarker mirrors the JSON left on the restored disk at
// <dataDir>/recovery-marker.json by the bare-metal rebuild engine
// (internal/backup/rebuild). See spec
// docs/superpowers/specs/backup/2026-09-10-bare-metal-boot-media-recovery-design.md
// Sec8.1 and plan
// docs/superpowers/plans/backup/2026-09-10-bare-metal-w04a-recovery-codes-state-machine-checkin.md.
type RecoveryMarker struct {
	RecoveryID string `json:"recoveryId"`
	Nonce      string `json:"nonce"`
	SnapshotID string `json:"snapshotId,omitempty"`
}

const (
	recoveryMarkerFile      = "recovery-marker.json"
	recoveryMarkerAckedFile = "recovery-marker.acked.json"
)

// LoadRecoveryMarker reads <dataDir>/recovery-marker.json. It returns
// (nil, nil) when the file is simply absent (the common case — most agents
// never went through a bare-metal recovery), and an error when the file
// exists but is unreadable or missing its recoveryId.
func LoadRecoveryMarker(dataDir string) (*RecoveryMarker, error) {
	path := filepath.Join(dataDir, recoveryMarkerFile)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read recovery marker: %w", err)
	}

	var marker RecoveryMarker
	if err := json.Unmarshal(data, &marker); err != nil {
		return nil, fmt.Errorf("decode recovery marker: %w", err)
	}
	if marker.RecoveryID == "" {
		return nil, fmt.Errorf("recovery marker missing recoveryId")
	}
	return &marker, nil
}

// AcknowledgeRecoveryMarker renames the marker file to
// recovery-marker.acked.json once the server has confirmed the check-in, so
// a restart of the agent never re-sends an already-completed recovery. A
// missing marker file is not an error — acknowledging is idempotent.
func AcknowledgeRecoveryMarker(dataDir string) error {
	src := filepath.Join(dataDir, recoveryMarkerFile)
	dst := filepath.Join(dataDir, recoveryMarkerAckedFile)
	if err := os.Rename(src, dst); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("acknowledge recovery marker: %w", err)
	}
	return nil
}
