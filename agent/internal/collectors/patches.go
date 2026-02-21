package collectors

// PatchInfo represents an available update/patch
type PatchInfo struct {
	Name        string `json:"name"`
	Version     string `json:"version"`
	CurrentVer  string `json:"currentVersion,omitempty"`
	Category    string `json:"category"` // "system", "security", "application", "homebrew"
	Severity    string `json:"severity,omitempty"` // "critical", "important", "moderate", "low"
	KBNumber    string `json:"kbNumber,omitempty"` // Windows KB number
	Size        int64  `json:"size,omitempty"` // Size in bytes
	IsRestart   bool   `json:"requiresRestart,omitempty"`
	ReleaseDate string `json:"releaseDate,omitempty"`
	Description string `json:"description,omitempty"`
	Source      string `json:"source"` // "apple", "microsoft", "homebrew", "apt", "yum"
}

// InstalledPatchInfo represents a previously installed update/patch
type InstalledPatchInfo struct {
	Name        string `json:"name"`
	Version     string `json:"version"`
	KBNumber    string `json:"kbNumber,omitempty"` // Windows KB number
	Category    string `json:"category"`
	Source      string `json:"source"`
	InstalledAt string `json:"installedAt"` // ISO 8601 timestamp
}

// PatchCollector collects available patches/updates
type PatchCollector struct{}

// NewPatchCollector creates a new patch collector
func NewPatchCollector() *PatchCollector {
	return &PatchCollector{}
}
