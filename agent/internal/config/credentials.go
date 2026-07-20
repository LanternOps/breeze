package config

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/viper"
	"gopkg.in/yaml.v3"
)

// Issue #2621 — durable credential persistence for two-phase token rotation.
//
// The stranding bug this file exists to prevent: the server used to commit new
// credential hashes BEFORE the agent had written the matching plaintext to
// disk. A failed write left the agent running on in-memory credentials that no
// copy on disk could reproduce, so the next restart loaded stale credentials
// and 401'd forever.
//
// The invariant enforced here is: at every instant, secrets.yaml holds at least
// one credential set the server will accept. During a rotation it holds two —
// the current set and the staged set — and only collapses back to one after the
// server has confirmed the promotion.

const (
	secretKeyAuthToken         = "auth_token"
	secretKeyWatchdogAuthToken = "watchdog_auth_token"
	secretKeyHelperAuthToken   = "helper_auth_token"

	secretKeyPendingAuthToken         = "pending_auth_token"
	secretKeyPendingWatchdogAuthToken = "pending_watchdog_auth_token"
	secretKeyPendingHelperAuthToken   = "pending_helper_auth_token"
)

// atomicWriteFileForTests is the write seam for credential persistence. Tests
// override it to inject the failure modes the issue actually reported (ENOSPC,
// EROFS, ACL denial on the rename) and to simulate a write that lands but does
// not contain what was asked for — neither of which can be provoked through the
// filesystem here, because the config layer re-asserts directory permissions on
// every write. Nil in production; see mutateSecretsAndPersist.
var atomicWriteFileForTests func(string, []byte, os.FileMode) error

func writeSecretsFile(path string, data []byte, perm os.FileMode) error {
	if atomicWriteFileForTests != nil {
		return atomicWriteFileForTests(path, data, perm)
	}
	return atomicWriteFile(path, data, perm)
}

// PersistedCredentials is the credential state actually on disk, as read back
// from secrets.yaml.
type PersistedCredentials struct {
	AuthToken                string
	WatchdogAuthToken        string
	HelperAuthToken          string
	PendingAuthToken         string
	PendingWatchdogAuthToken string
	PendingHelperAuthToken   string
}

// mutateSecretsAndPersist applies mutate to the parsed contents of secrets.yaml
// and writes the result back atomically at 0600 (tmp file → fsync → rename →
// dir fsync, via atomicWriteFile). Deleting a key is expressed by removing it
// from the map, which viper.Set cannot express — that is why this exists
// alongside setSecretAndPersistLocked.
//
// The whole read-modify-write runs under persistMu so concurrent credential
// updates cannot interleave and lose a key.
func mutateSecretsAndPersist(mutate func(map[string]any)) error {
	persistMu.Lock()
	defer persistMu.Unlock()

	path := secretsFilePath()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	if err := enforceConfigDirPermissions(filepath.Dir(path)); err != nil {
		return err
	}

	sv := viper.New()
	sv.SetConfigFile(path)
	sv.SetConfigType("yaml")
	if err := sv.ReadInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok && !os.IsNotExist(err) {
			return err
		}
	}

	settings := sv.AllSettings()
	if settings == nil {
		settings = map[string]any{}
	}
	mutate(settings)

	secretsYAML, err := yaml.Marshal(settings)
	if err != nil {
		return fmt.Errorf("marshaling secrets file: %w", err)
	}
	if err := writeSecretsFile(path, secretsYAML, 0600); err != nil {
		return err
	}
	return enforceSecretFilePermissions(path)
}

// ReadPersistedCredentials reads the credential state straight off disk,
// bypassing any in-memory config. This is the read-back half of
// write-then-verify: a Save that returned nil but produced an unreadable or
// truncated file must not be treated as durable.
func ReadPersistedCredentials() (*PersistedCredentials, error) {
	return readPersistedCredentialsFrom(secretsFilePath())
}

// readPersistedCredentialsAt reads the credential state from the secrets file
// belonging to an explicit agent.yaml path. SaveTo can target a config file
// other than the process-bound one, and resolving the wrong secrets file there
// would make it look like there are no staged credentials to preserve.
func readPersistedCredentialsAt(cfgPath string) (*PersistedCredentials, error) {
	return readPersistedCredentialsFrom(secretsFilePathFor(cfgPath))
}

func readPersistedCredentialsFrom(path string) (*PersistedCredentials, error) {
	sv := viper.New()
	sv.SetConfigFile(path)
	sv.SetConfigType("yaml")
	if err := sv.ReadInConfig(); err != nil {
		return nil, fmt.Errorf("reading secrets file: %w", err)
	}

	return &PersistedCredentials{
		AuthToken:                sv.GetString(secretKeyAuthToken),
		WatchdogAuthToken:        sv.GetString(secretKeyWatchdogAuthToken),
		HelperAuthToken:          sv.GetString(secretKeyHelperAuthToken),
		PendingAuthToken:         sv.GetString(secretKeyPendingAuthToken),
		PendingWatchdogAuthToken: sv.GetString(secretKeyPendingWatchdogAuthToken),
		PendingHelperAuthToken:   sv.GetString(secretKeyPendingHelperAuthToken),
	}, nil
}

// StagePendingCredentials durably writes a staged credential set ALONGSIDE the
// current one, then reads it back to prove the write landed.
//
// Critically, it does not touch auth_token / watchdog_auth_token /
// helper_auth_token. If this call fails — or the process dies mid-write — the
// agent still has its working credentials on disk, and the server has not
// promoted anything, so the rotation is simply abandoned with no divergence.
//
// Returns an error if the readback does not match what was written; the caller
// MUST NOT confirm the rotation to the server in that case.
func StagePendingCredentials(authToken, watchdogAuthToken, helperAuthToken string) error {
	if authToken == "" || watchdogAuthToken == "" || helperAuthToken == "" {
		return fmt.Errorf("refusing to stage an incomplete credential set")
	}

	if err := mutateSecretsAndPersist(func(settings map[string]any) {
		settings[secretKeyPendingAuthToken] = authToken
		settings[secretKeyPendingWatchdogAuthToken] = watchdogAuthToken
		settings[secretKeyPendingHelperAuthToken] = helperAuthToken
	}); err != nil {
		return fmt.Errorf("staging pending credentials: %w", err)
	}

	persisted, err := ReadPersistedCredentials()
	if err != nil {
		return fmt.Errorf("verifying staged credentials: %w", err)
	}
	if persisted.PendingAuthToken != authToken ||
		persisted.PendingWatchdogAuthToken != watchdogAuthToken ||
		persisted.PendingHelperAuthToken != helperAuthToken {
		return fmt.Errorf("staged credentials failed readback verification")
	}
	// The current set must still be intact — a staging write that clobbered it
	// would have destroyed the fallback the whole design depends on.
	if persisted.AuthToken == "" {
		return fmt.Errorf("staging clobbered the current auth token")
	}
	return nil
}

// PromotePendingCredentials collapses the staged set into the current set in a
// single atomic write, once the server has confirmed the promotion.
//
// Ordering note: this runs strictly AFTER the server confirms. If the process
// dies before this call, secrets.yaml still carries the staged tokens under
// their pending_* keys and startup reconciliation recovers them; if it dies
// during, atomicWriteFile's rename means the file is either fully the old
// content or fully the new one, never a torn mix.
func PromotePendingCredentials(authToken, watchdogAuthToken, helperAuthToken string) error {
	if authToken == "" || watchdogAuthToken == "" || helperAuthToken == "" {
		return fmt.Errorf("refusing to promote an incomplete credential set")
	}

	if err := mutateSecretsAndPersist(func(settings map[string]any) {
		settings[secretKeyAuthToken] = authToken
		settings[secretKeyWatchdogAuthToken] = watchdogAuthToken
		settings[secretKeyHelperAuthToken] = helperAuthToken
		delete(settings, secretKeyPendingAuthToken)
		delete(settings, secretKeyPendingWatchdogAuthToken)
		delete(settings, secretKeyPendingHelperAuthToken)
	}); err != nil {
		return fmt.Errorf("promoting pending credentials: %w", err)
	}

	persisted, err := ReadPersistedCredentials()
	if err != nil {
		return fmt.Errorf("verifying promoted credentials: %w", err)
	}
	if persisted.AuthToken != authToken ||
		persisted.WatchdogAuthToken != watchdogAuthToken ||
		persisted.HelperAuthToken != helperAuthToken {
		return fmt.Errorf("promoted credentials failed readback verification")
	}

	// The Breeze Helper runs as the logged-in user and cannot read the root-only
	// secrets.yaml, so helper_auth_token is deliberately exempted from stripping
	// and also lives in agent.yaml (see secretKeyAllowedInAgentYAML). Promoting
	// only into secrets.yaml would leave the Helper reading the SUPERSEDED token
	// and 401ing as soon as its 5-minute grace lapsed — the same stranding bug,
	// one component over.
	if err := SetAndPersist(secretKeyHelperAuthToken, helperAuthToken); err != nil {
		return fmt.Errorf("persisting rotated helper token to agent config: %w", err)
	}
	return nil
}

// ClearPendingCredentials drops a staged set that can never be promoted (the
// server reported it expired). The current credentials are left untouched, so
// this is always safe: the worst case is a rotation that has to start over.
func ClearPendingCredentials() error {
	return mutateSecretsAndPersist(func(settings map[string]any) {
		delete(settings, secretKeyPendingAuthToken)
		delete(settings, secretKeyPendingWatchdogAuthToken)
		delete(settings, secretKeyPendingHelperAuthToken)
	})
}
