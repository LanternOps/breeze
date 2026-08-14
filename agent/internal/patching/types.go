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
}

// PatchProvider is implemented by platform-specific patch sources.
type PatchProvider interface {
	ID() string
	Name() string
	Scan() ([]AvailablePatch, error)
	Install(patchID string) (InstallResult, error)
	Uninstall(patchID string) error
	GetInstalled() ([]InstalledPatch, error)
}
