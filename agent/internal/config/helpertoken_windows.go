//go:build windows

package config

// Windows has no helper token file. The Breeze Helper ("Breeze Assist") runs
// as the logged-in user, and there is no Windows equivalent of the Unix
// "breeze" group that helpertoken_unix.go uses to scope a file to console/GUI
// users. Instead the agent delivers the token over its named-pipe IPC channel,
// only to an Assist the broker has authenticated in the active console session
// (Heartbeat.handleHelperSessionAuthenticated / sendHelperTokenUpdate). On disk
// the token lives only in SYSTEM/Administrators-only secrets.yaml. These are
// no-ops so the cross-platform call sites in config.go don't need a build-tag
// switch of their own.

func helperTokenFilePathFor(string) string { return "" }

func writeHelperTokenFileFor(string, string) error { return nil }

func readHelperTokenFileFor(string) (string, error) { return "", nil }

func reapplyHelperTokenFilePermissionsFor(string) {}
