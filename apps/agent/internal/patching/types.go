package patching

// AvailablePatch describes an update that can be installed.
type AvailablePatch struct {
	ID          string
	Provider    string
	Title       string
	Description string
	Version     string
}

// InstalledPatch describes an update that is already installed.
type InstalledPatch struct {
	ID       string
	Provider string
	Title    string
	Version  string
}

// InstallResult captures the outcome of a patch installation.
type InstallResult struct {
	PatchID        string
	Provider       string
	RebootRequired bool
	Message        string
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
