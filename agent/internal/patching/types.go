package patching

// AvailablePatch describes an update that can be installed.
type AvailablePatch struct {
	ID             string
	Provider       string
	Title          string
	Description    string
	Version        string
	Severity       string // critical, important, moderate, low, unknown
	Category       string // security, system, application, driver, definitions, feature
	KBNumber       string // e.g. "KB5034441"
	Size           int64  // bytes
	IsDownloaded   bool
	RebootRequired bool
	ReleaseDate    string // ISO 8601 date
	UpdateType     string // "software", "driver", or "feature"
	EulaAccepted   bool
	// Scope records the install scope the patch was discovered at, for
	// providers that can distinguish one (currently winget:
	// PatchScopeMachine vs PatchScopeUser). Empty means the provider has no
	// scope concept and the platform should treat the patch as machine-wide.
	Scope string
}

// Install scopes reported in AvailablePatch.Scope.
const (
	// PatchScopeMachine is a machine-wide (all users) install, discoverable
	// and remediable from the SYSTEM agent process.
	PatchScopeMachine = "machine"
	// PatchScopeUser is a per-user install, only visible from inside the
	// interactive user's session (#2727).
	PatchScopeUser = "user"
)

// InstalledPatch describes an update that is already installed.
type InstalledPatch struct {
	ID          string
	Provider    string
	Title       string
	Version     string
	KBNumber    string
	InstalledAt string // ISO 8601 date
	Category    string
}

// InstallResult captures the outcome of a patch installation.
type InstallResult struct {
	PatchID        string
	Provider       string
	RebootRequired bool
	Message        string
	ResultCode     int // WUA result code (2=succeeded, 3=succeeded with errors)
	HResult        int // HRESULT from WUA
	// Skipped marks an install that had nothing to do — the package is
	// already current, or the update is no longer offered (#6910). It is a
	// non-error outcome: the job records the item as skipped (visible, with
	// Message explaining why) and it never counts as a failure or an install.
	Skipped bool
	// SkipReason is one of the SkipReason* constants when Skipped is true.
	SkipReason string
}

// Reasons reported in InstallResult.SkipReason (#6910).
const (
	// SkipReasonAlreadyCurrent: the package is already at the newest version
	// its source offers (winget 0x8A15002B UPDATE_NOT_APPLICABLE).
	SkipReasonAlreadyCurrent = "already_current"
	// SkipReasonAlreadyInstalled: the update was installed between scan and
	// install (e.g. by Windows Update itself).
	SkipReasonAlreadyInstalled = "already_installed"
	// SkipReasonNotOffered: the update is no longer offered — superseded or
	// expired between scan and install (Defender definitions, KB2267602,
	// are republished several times a day).
	SkipReasonNotOffered = "not_offered"
)

// PatchProvider is implemented by platform-specific patch sources.
type PatchProvider interface {
	ID() string
	Name() string
	Scan() ([]AvailablePatch, error)
	Install(patchID string) (InstallResult, error)
	Uninstall(patchID string) error
	GetInstalled() ([]InstalledPatch, error)
}
