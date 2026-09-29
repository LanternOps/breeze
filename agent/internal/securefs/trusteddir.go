package securefs

// TrustedExecutableDir is the root-owned, Breeze-only directory privileged
// agent/watchdog binaries live in on macOS. Unlike /usr/local/bin, nothing
// else on the system (Homebrew included) ever writes here, so its ownership
// can't drift out from under a running root daemon.
//
// These are plain string constants (not build-tagged) so cross-platform
// callers — e.g. code shared between the Linux and macOS agent — can name
// the macOS path without needing a darwin-only build of their own. Only
// darwin-specific code (internal/securefs/trusteddir_darwin.go and its
// callers) actually acts on them; Linux installs are not relocated by this
// release.
const TrustedExecutableDir = "/Library/Breeze/bin"

// TrustedExecutableDirRoot is the highest path component TrustedExecutableDir
// sits under whose ownership Breeze does not manage — the system already
// owns and trusts it. Callers that create or repair TrustedExecutableDir
// (or an ancestor of it, e.g. "/Library/Breeze") pass this as the boundary
// a symlink-refusing walk (EnsureTrustedDirChain) stops trusting blindly at.
const TrustedExecutableDirRoot = "/Library"

// LegacyExecutableDir is the pre-migration install location shared by both
// Linux and macOS. On macOS, a privileged process still running from here
// is copied into TrustedExecutableDir only when this location fails
// VerifyTrustedExecutablePathChain — relocating a bare binary costs its
// path-keyed Full Disk Access grant (#7211); see internal/macrelocate. On
// Linux this remains the install location — it is not relocated.
const LegacyExecutableDir = "/usr/local/bin"
