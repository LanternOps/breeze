//go:build darwin

package collectors

// getChassisType returns empty on macOS — Apple hardware does not expose
// DMI/SMBIOS chassis type data. Classification falls through to model name
// heuristics and OS edition checks.
func getChassisType() string {
	return ""
}
