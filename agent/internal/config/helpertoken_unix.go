//go:build !windows

package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// helperTokenFileName is a dedicated file for helper_auth_token, separate
// from agent.yaml. agent.yaml stays world-readable by design (#988) for its
// non-secret fields (server URL, agent id); this file exists so the one
// secret the Helper needs is not handed to every other local account along
// with them.
const helperTokenFileName = "helper_token.yaml"

// helperTokenFilePathFor mirrors secretsFilePathFor: an explicit cfgFile
// (used by tests and by SaveTo/Load callers that pass a non-default path)
// puts the helper token file beside it; otherwise it lives in the real
// configDir().
func helperTokenFilePathFor(cfgFile string) string {
	if cfgFile != "" {
		return filepath.Join(filepath.Dir(cfgFile), helperTokenFileName)
	}
	return filepath.Join(configDir(), helperTokenFileName)
}

// writeHelperTokenFileFor persists token to its own file beside cfgFile (or
// in configDir() when cfgFile is ""), group-readable only by members of the
// breeze group (the same group install.sh/postinstall add every console/GUI
// user to for the IPC socket — see sessionbroker.IPCGroupName). An empty
// token removes the file rather than leaving a stale one behind.
//
// The breeze group may not exist yet (e.g. mid-install, before the
// installer's group-creation step has run). Lookup failure is logged and
// handled by falling back to root-only (mode 0600, group left as the
// process's own, i.e. root): never widen the mode to compensate for a
// failed lookup.
func writeHelperTokenFileFor(cfgFile, token string) error {
	path := helperTokenFilePathFor(cfgFile)
	if token == "" {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("removing stale helper token file: %w", err)
		}
		return nil
	}

	data, err := yaml.Marshal(map[string]string{"helper_auth_token": token})
	if err != nil {
		return fmt.Errorf("marshaling helper token file: %w", err)
	}
	if err := atomicWriteFile(path, data, 0o600); err != nil {
		return fmt.Errorf("writing helper token file: %w", err)
	}

	gid, err := breezeGroupIDLookupImpl(breezeGroupName)
	if err != nil {
		log.Warn("breeze group unavailable; helper token file left root-only",
			"path", path, "error", err.Error())
		return nil
	}
	if err := os.Chown(path, -1, gid); err != nil {
		log.Warn("failed to group-own helper token file; left root-only",
			"path", path, "error", err.Error())
		return nil
	}
	// 0640: owner (root) read/write, group (breeze) read-only, others none.
	// chmod after chown — mirrors applySocketOwner's ordering rationale
	// (some platforms can affect mode bits on an ownership change).
	if err := os.Chmod(path, 0o640); err != nil {
		return fmt.Errorf("setting helper token file mode: %w", err)
	}
	return nil
}

// readHelperTokenFileFor reads helper_auth_token back from its dedicated file,
// beside cfgFile (or in configDir() when cfgFile is ""). A missing file is
// not an error — it returns "", nil, matching the "nothing to read yet"
// contract of the rest of this package's credential readers.
func readHelperTokenFileFor(cfgFile string) (string, error) {
	data, err := os.ReadFile(helperTokenFilePathFor(cfgFile))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", nil
		}
		return "", err
	}
	var parsed struct {
		HelperAuthToken string `yaml:"helper_auth_token"`
	}
	if err := yaml.Unmarshal(data, &parsed); err != nil {
		return "", fmt.Errorf("parsing helper token file: %w", err)
	}
	return parsed.HelperAuthToken, nil
}

// reapplyHelperTokenFilePermissionsFor re-derives the breeze GID and
// reapplies ownership/mode to an existing helper token file beside cfgFile.
// Called from FixConfigPermissions on every start so a group created or
// repaired after the file was first written (or a GID that changed) is
// picked up, without ever widening the mode on failure.
func reapplyHelperTokenFilePermissionsFor(cfgFile string) {
	path := helperTokenFilePathFor(cfgFile)
	if _, err := os.Stat(path); err != nil {
		return // nothing to fix yet
	}
	if err := os.Chmod(path, 0o600); err != nil {
		log.Warn("failed to fix helper token file mode", "path", path, "error", err.Error())
		return
	}
	gid, err := breezeGroupIDLookupImpl(breezeGroupName)
	if err != nil {
		log.Warn("breeze group unavailable; helper token file left root-only",
			"path", path, "error", err.Error())
		return
	}
	if err := os.Chown(path, -1, gid); err != nil {
		log.Warn("failed to group-own helper token file; left root-only",
			"path", path, "error", err.Error())
		return
	}
	if err := os.Chmod(path, 0o640); err != nil {
		log.Warn("failed to fix helper token file mode", "path", path, "error", err.Error())
	}
}
