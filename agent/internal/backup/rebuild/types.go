// Package rebuild implements the bare-metal recovery engine (spec §6): given
// a snapshot id, its recorded disk layout, a target (block device or raw
// image file), and an identity mode, it provisions GPT partitions, restores
// the whole-machine file snapshot, applies Linux system state offline,
// installs/refreshes the bootloader, writes the identity marker, validates,
// and returns a structured Result. All OS interaction goes through the
// System seam (system.go) so the engine is fully testable without root.
package rebuild

import (
	"time"

	"github.com/breeze-rmm/agent/internal/backup/layout"
	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// TargetKind selects what rebuild.Run writes to.
type TargetKind string

const (
	TargetDisk  TargetKind = "disk"
	TargetImage TargetKind = "image"
)

// Target is where the engine provisions and restores the machine.
type Target struct {
	Kind TargetKind `json:"kind"`
	Path string     `json:"path"`
	// ImageSizeBytes is used only for TargetImage: the size to create the
	// file at when it does not already exist (sparse).
	ImageSizeBytes int64 `json:"imageSizeBytes,omitempty"`
}

// IdentityMode selects whether the rebuilt machine keeps the source
// machine's identity (bound to a pending recovery via Marker) or becomes a
// fresh, unenrolled machine.
type IdentityMode string

const (
	IdentityOriginal IdentityMode = "original"
	IdentityNew      IdentityMode = "new"
)

// Marker binds the restored device to a pending server-side recovery (W04).
type Marker struct {
	RecoveryID string `json:"recoveryId"`
	Nonce      string `json:"nonce"`
}

// Phase is one of the seven engine phases, always run and reported in the
// same order.
type Phase string

const (
	PhasePreflight  Phase = "preflight"
	PhaseProvision  Phase = "provision"
	PhaseRestore    Phase = "restore"
	PhaseBoot       Phase = "boot"
	PhaseIdentity   Phase = "identity"
	PhaseEncryption Phase = "encryption"
	PhaseValidate   Phase = "validate"
)

// AllPhases is the fixed phase order every rebuild.Run reports.
var AllPhases = []Phase{PhasePreflight, PhaseProvision, PhaseRestore, PhaseBoot, PhaseIdentity, PhaseEncryption, PhaseValidate}

// PhaseStatus is the outcome of one phase within a single Run call.
type PhaseStatus string

const (
	PhaseCompleted PhaseStatus = "completed"
	PhaseSkipped   PhaseStatus = "skipped" // resumed run: already done by an earlier call
	PhaseFailed    PhaseStatus = "failed"
	PhaseRefused   PhaseStatus = "refused"
)

// PhaseResult records one phase's outcome and timing within Result.Phases.
type PhaseResult struct {
	Phase       Phase       `json:"phase"`
	Status      PhaseStatus `json:"status"`
	StartedAt   time.Time   `json:"startedAt"`
	CompletedAt time.Time   `json:"completedAt"`
	Message     string      `json:"message,omitempty"`
}

// PlannedPartition is one partition PlanPartitions laid out on the target.
type PlannedPartition struct {
	Number     int    `json:"number"`
	Role       string `json:"role"`
	TypeGUID   string `json:"typeGuid"`
	PartUUID   string `json:"partUuid,omitempty"`
	Name       string `json:"name,omitempty"`
	StartBytes int64  `json:"startBytes"`
	SizeBytes  int64  `json:"sizeBytes"`
	Filesystem string `json:"filesystem,omitempty"`
	FSUUID     string `json:"fsUuid,omitempty"`
	Label      string `json:"label,omitempty"`
	MountPoint string `json:"mountPoint,omitempty"`
	Grown      bool   `json:"grown"` // absorbed the target's extra (or short) space
}

// Plan is PlanPartitions' output: the partition table the engine will
// provision on the target.
type Plan struct {
	SourceDisk      string             `json:"sourceDisk"`
	SourceSizeBytes int64              `json:"sourceSizeBytes"`
	TargetPath      string             `json:"targetPath"`
	TargetSizeBytes int64              `json:"targetSizeBytes"`
	SectorSize      int                `json:"sectorSize"`
	Partitions      []PlannedPartition `json:"partitions"`
	MinimumBytes    int64              `json:"minimumBytes"` // what the target must offer
}

// Options configures a single Run call.
type Options struct {
	SnapshotID string
	Provider   providers.BackupProvider
	Target     Target
	Identity   IdentityMode
	Marker     *Marker          // original identity only
	Layout     *layout.Manifest // nil → downloaded from snapshots/<id>/layout.json
	StateDir   string           // default /var/lib/breeze/rebuild
	StagingRoot string          // default <StateDir>/mnt/<snapshotID>

	DryRun              bool // preflight only; returns the Plan
	ForceReprovision    bool
	AllowPartialRestore bool
	RegenerateInitramfs bool // default true; CLI --no-initramfs clears it
	SkipBoot            bool // tests/CI only: synthetic roots have no bootloader

	System   System // nil → real system (system_linux.go)
	Progress func(phase Phase, message string, current, total int64)
}

// Result is Run's structured outcome.
type Result struct {
	SnapshotID    string        `json:"snapshotId"`
	Target        Target        `json:"target"`
	Identity      IdentityMode  `json:"identity"`
	Status        string        `json:"status"` // completed | refused | failed
	PhaseReached  Phase         `json:"phaseReached"`
	Phases        []PhaseResult `json:"phases"`
	Plan          *Plan         `json:"plan,omitempty"`
	Refusal       string        `json:"refusal,omitempty"`
	Error         string        `json:"error,omitempty"`
	Warnings      []string      `json:"warnings,omitempty"`
	FilesRestored int           `json:"filesRestored"`
	BytesRestored int64         `json:"bytesRestored"`
	DurationMs    int64         `json:"durationMs"`
	Resumed       bool          `json:"resumed"`
}

// RefusalError carries an operator-facing reason; Run maps it to Status
// "refused" without touching the target.
type RefusalError struct{ Reason string }

func (e *RefusalError) Error() string { return "refused: " + e.Reason }

const (
	MiB = int64(1) << 20
	GiB = int64(1) << 30
)
