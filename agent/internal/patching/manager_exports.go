package patching

// CmdRunner is the exported alias of the package-private cmdRunner process
// execution signature, for callers outside this package (e.g.
// agent/internal/remote/tools) that need to inject a fake runner in tests
// without duplicating the type.
type CmdRunner = cmdRunner

// ValidateBrewPackageName exposes the internal Homebrew formula/cask name
// validator to callers outside this package. Not darwin-build-tagged: the
// name-shape check itself has nothing platform-specific about it, unlike the
// HomebrewProvider that actually shells out to brew.
func ValidateBrewPackageName(name string) error {
	return validateBrewPackageName(name)
}
