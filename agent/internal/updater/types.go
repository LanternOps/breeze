package updater

// BinaryPair is a freshly-downloaded binary in a temp location plus its final
// install path. Used to pipe optional companion binaries (e.g. breeze-user-helper.exe)
// through the Windows in-place upgrade swap.
type BinaryPair struct {
	Temp   string
	Target string
}

// IsZero reports whether both fields are the empty string. Useful for treating
// an accidentally zero-valued BinaryPair as "no companion to swap" instead of
// generating a broken script — though the preferred API is to pass a *BinaryPair
// and use nil to express absence (see restartScriptOptions.UserHelper).
func (p BinaryPair) IsZero() bool { return p.Temp == "" && p.Target == "" }

// UpdateOptions carries optional companion behavior for an update operation.
// Passed by value into UpdateToWithOptions / UpdateFromURL so the call site is
// self-describing: there is no Updater-level state for callers to mutate, and
// the helper-swap path is visible from a single function body. Issue #816 /
// #845 follow-up (PR B): replaces the prior u.extras action-at-a-distance.
type UpdateOptions struct {
	// UserHelper, when non-nil, is also swapped alongside the main binary
	// on Windows. Ignored on other platforms (the agent-only path is the
	// only path on non-Windows).
	UserHelper *BinaryPair

	// Backup, when non-nil, is also swapped alongside the main binary during
	// this upgrade: on Windows via the restart-helper script (like UserHelper),
	// on Linux and the macOS raw-binary fallback via an atomic same-directory
	// rename before the agent restarts (see swapCompanionBinary). Unlike
	// UserHelper this applies on EVERY platform — breeze-backup ships
	// everywhere (agent/Makefile), not just Windows — with one exception: the
	// macOS .pkg install path already bundles its own breeze-backup, so
	// updateTo discards (rather than swaps) a staged Backup pair when the pkg
	// path is taken. breeze-backup's version is slaved to the agent's; there
	// is no independent backup update directive.
	Backup *BinaryPair
}

// RollbackComponent is one binary owned by the agent installation. These
// values are deliberately identical to release-manifest component names.
type RollbackComponent string

const (
	RollbackComponentAgent      RollbackComponent = "agent"
	RollbackComponentHelper     RollbackComponent = "helper"
	RollbackComponentUserHelper RollbackComponent = "user-helper"
	RollbackComponentWatchdog   RollbackComponent = "watchdog"
	RollbackComponentBackup     RollbackComponent = "backup"
)

type RollbackComponentVersion struct {
	Current string
	Target  string
}

// RollbackArtifactMetadata is the directive-bound description of one target
// artifact. Authorization and directive-signature verification belong to the
// rollback state machine; the updater only verifies this metadata against the
// signed release manifest and downloaded bytes.
type RollbackArtifactMetadata struct {
	Component      RollbackComponent
	CurrentVersion string
	TargetVersion  string
	DownloadURL    string
	SHA256         string
	Size           int64
}

type RollbackStageRequest struct {
	DirectiveID          string
	Platform             string
	Architecture         string
	CurrentVersion       string
	TargetVersion        string
	ComponentVersions    map[RollbackComponent]RollbackComponentVersion
	ReleaseManifest      string
	ManifestSignature    string
	ManifestSigningKeyID string
	Artifacts            []RollbackArtifactMetadata
}

type StagedRollbackArtifact struct {
	RollbackArtifactMetadata
	StagedPath string
}

type StagedRollbackSet struct {
	DirectiveID string
	Artifacts   []StagedRollbackArtifact
}

// Cleanup removes staged downloads. It is safe to call after partial work.
func (s StagedRollbackSet) Cleanup() {
	for _, artifact := range s.Artifacts {
		removeCleanup(artifact.StagedPath)
	}
}

type RollbackSwapArtifact struct {
	Component  RollbackComponent
	StagedPath string
	LivePath   string
}

type RollbackSwapSet struct {
	DirectiveID string
	JournalPath string
	Artifacts   []RollbackSwapArtifact
}
