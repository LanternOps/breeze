//go:build darwin

package recoveryinstall

import "os"

// DarwinInstallDir is the Installer.InstallDir on macOS: versions go to
// /Library/Breeze/isolation-recovery/<version>/, inside the root-only tree the
// agent already trusts (securefs.TrustedExecutableDir's parent), and never
// /usr/local, which a non-root identity can own (#7211).
//
// As on Windows, no production Installer is wired: the trusted fetcher and
// the code-signature verifier arrive with the release-signing work, and until
// then EnsureRecovery fails closed.
const DarwinInstallDir = "/Library/Breeze"

// publishExclusive links the verified inode into place: create-exclusive, so
// it can never replace an executable that already exists at that version.
func publishExclusive(source, target string) error { return os.Link(source, target) }
