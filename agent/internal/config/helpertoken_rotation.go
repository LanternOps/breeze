package config

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync/atomic"

	"github.com/spf13/viper"
)

// helperTokenRotationMarkerName is a marker file beside agent.yaml recording
// that a helper token was found in agent.yaml, where older Windows agents kept
// it. Besides moving the token to secrets.yaml, the agent rotates its
// credentials once, so the token that used to sit in agent.yaml stops being
// accepted. Any verified promotion settles it (PromotePendingCredentials
// removes the file): the server honours the superseded token only for its
// short grace window.
//
// It is a separate file rather than a secrets.yaml key because SaveTo rebuilds
// secrets.yaml from scratch and would silently drop it. It holds no secret; it
// inherits the config directory's SYSTEM/Administrators-only (root) ACL, so a
// standard user can neither plant nor delete it.
const helperTokenRotationMarkerName = "helper_token_rotation_owed"

// helperTokenRotationOwedInProcess keeps the debt for this process when the
// marker could not be written: the scrub still runs, and the rotation is still
// attempted before the next restart would forget it.
var helperTokenRotationOwedInProcess atomic.Bool

// helperTokenRotationClearedInProcess records that a rotation was promoted in
// this process but its marker could not be removed. The debt is settled, so
// the leftover marker must not start a rotation at every backoff step for the
// rest of the run. The next start sees the marker again and rotates once more.
var helperTokenRotationClearedInProcess atomic.Bool

// legacyHelperTokenLine matches a non-empty helper_auth_token entry in YAML
// text (optionally quoted key), but not pending_helper_auth_token, a comment,
// or an empty value. Used only when agent.yaml does not parse.
var legacyHelperTokenLine = regexp.MustCompile(`(?m)^[ \t]*["']?helper_auth_token["']?[ \t]*:[ \t]*(?:"[^"\n]+"|'[^'\n]+'|[^\s#"'])`)

func helperTokenRotationMarkerPathFor(cfgFile string) string {
	if cfgFile != "" {
		return filepath.Join(filepath.Dir(cfgFile), helperTokenRotationMarkerName)
	}
	return filepath.Join(configDir(), helperTokenRotationMarkerName)
}

// HelperTokenRotationOwed reports whether the active config's helper token was
// found in agent.yaml and no verified rotation has replaced it yet.
func HelperTokenRotationOwed() bool {
	if helperTokenRotationOwedInProcess.Load() {
		return true
	}
	if helperTokenRotationClearedInProcess.Load() {
		return false
	}
	persistMu.Lock()
	path := helperTokenRotationMarkerPathFor(viper.ConfigFileUsed())
	persistMu.Unlock()
	_, err := os.Stat(path)
	return err == nil
}

// recordHelperTokenRotationOwed writes the rotation-owed marker beside cfgPath.
// migrateInlineSecretsToSecretFile calls it BEFORE it rewrites anything, so the
// debt survives a crash, or a failed scrub, between finding the token and
// removing it.
func recordHelperTokenRotationOwed(cfgPath string) {
	// A newly found token is a new debt, whatever an earlier promotion settled.
	helperTokenRotationClearedInProcess.Store(false)
	marker := helperTokenRotationMarkerPathFor(cfgPath)
	if _, err := os.Stat(marker); err == nil {
		return
	}
	if err := atomicWriteFile(marker, []byte("helper_auth_token was found in agent.yaml; a credential rotation is owed\n"), 0o600); err != nil {
		log.Error("failed to record that the helper token must be rotated; this process will still rotate it, a restart would not",
			"path", marker, "error", err.Error())
		helperTokenRotationOwedInProcess.Store(true)
		return
	}
	if err := enforceSecretFilePermissions(marker); err != nil {
		log.Warn("failed to restrict helper token rotation marker", "path", marker, "error", err.Error())
	}
	log.Warn("helper token found in agent.yaml; removing it and rotating credentials", "path", cfgPath)
}

// inlineHelperTokenStillValid reports whether a helper token found in
// agent.yaml may still be accepted by the server: it is the current or the
// staged helper token in secrets.yaml. Once a rotation has replaced it (for
// example one promoted while agent.yaml could not be rewritten), removing it
// is enough and no further rotation is owed. Anything it cannot establish —
// unreadable secrets.yaml, no helper token there, a non-string value — counts
// as still valid, so the rotation is owed. Token values are never logged.
func inlineHelperTokenStillValid(cfgPath string, inline any) bool {
	token, ok := inline.(string)
	if !ok {
		return true
	}
	creds, err := readPersistedCredentialsAt(cfgPath)
	if err != nil || creds == nil || creds.HelperAuthToken == "" {
		return true
	}
	return token == creds.HelperAuthToken ||
		(creds.PendingHelperAuthToken != "" && token == creds.PendingHelperAuthToken)
}

// clearHelperTokenRotationOwed removes the marker beside the active config once
// a rotation has been promoted. Failure is logged, never returned: the
// promotion already succeeded. A marker that cannot be removed is ignored for
// the rest of this process (helperTokenRotationClearedInProcess); after a
// restart it costs one more rotation.
func clearHelperTokenRotationOwed() {
	helperTokenRotationOwedInProcess.Store(false)
	persistMu.Lock()
	marker := helperTokenRotationMarkerPathFor(viper.ConfigFileUsed())
	persistMu.Unlock()
	if err := os.Remove(marker); err != nil && !errors.Is(err, os.ErrNotExist) {
		helperTokenRotationClearedInProcess.Store(true)
		log.Error("failed to clear helper token rotation marker after a promoted rotation; ignoring it until the agent restarts", "path", marker, "error", err.Error())
	}
}

// removeStaleConfigScratchFiles deletes the temp files an interrupted write of
// agent.yaml or secrets.yaml can leave beside cfgPath (atomicWriteFile's
// ".partial", writeYAMLFile's ".tmp"). Nothing reads them back, and one left by
// an older agent can hold a token under whatever ACL it was created with.
func removeStaleConfigScratchFiles(cfgPath string) {
	for _, base := range []string{cfgPath, secretsFilePathFor(cfgPath)} {
		for _, suffix := range []string{".tmp", ".partial"} {
			path := base + suffix
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				log.Warn("failed to remove stale config scratch file", "path", path, "error", err.Error())
			}
		}
	}
}

// sameConfigPath reports whether a and b name the same config file path.
// Windows paths are case-insensitive.
func sameConfigPath(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}
