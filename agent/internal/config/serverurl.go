package config

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

// defaultConfigFilePath mirrors Load()'s default lookup — viper.SetConfigName
// ("agent") + viper.AddConfigPath(configDir()) — without touching the global
// viper singleton. Load() also falls back to "." ; a helper that finds no
// agent.yaml at the real config dir simply keeps its startup URL (see
// NewPersistedServerURLProvider), which is the correct degradation.
func defaultConfigFilePath() string {
	return filepath.Join(configDir(), "agent.yaml")
}

// defaultPersistedServerURLTTL bounds how often a helper process re-reads
// agent.yaml looking for a promoted server URL. Promotion is rare (it takes
// backupProbeThreshold consecutive heartbeat failures) and the log shipper
// flushes at most once a minute, so a 60s TTL costs at most one small YAML
// read per flush while keeping the post-failover blind window to ~1 minute.
const defaultPersistedServerURLTTL = 60 * time.Second

// PersistedServerURL reads server_url straight out of agent.yaml.
//
// It exists for the HELPER processes (breeze-user-helper, breeze-desktop-
// helper). They are separate, long-lived processes: they load config once at
// spawn and are never respawned when the agent promotes a backup server URL
// (#2323) — HelperLifecycleManager only spawns helpers that are MISSING, and
// promoteBackupServerURL signals nothing — so a startup copy of ServerURL
// keeps them shipping diagnostics to the dead primary for the rest of the
// logon session (#2463). The agent persists the promotion swap to agent.yaml
// synchronously (heartbeat.promoteBackupServerURL -> config.SetAllAndPersist),
// which makes that file the authoritative cross-process source of truth.
//
// It deliberately does NOT go through Load():
//
//   - Load() also opens secrets.yaml, which is root/SYSTEM-only by design
//     (0600 on Unix, an SDDL with no Users ACE on Windows), so it returns an
//     error outright in a user-context helper. agent.yaml is world-readable
//     (0644) precisely so the helper can read its server URL and agent id —
//     see the comment in permissions_unix.go.
//   - Load() mutates the package-global viper singleton with no lock, so it is
//     not safe to call repeatedly from a background shipping goroutine.
//
// cfgFile may be empty, in which case the default config path is used.
func PersistedServerURL(cfgFile string) (string, error) {
	path := cfgFile
	if path == "" {
		path = defaultConfigFilePath()
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("reading %s: %w", path, err)
	}

	// Decode only the one key we need. A partial struct means unrelated
	// schema drift elsewhere in agent.yaml cannot break the read.
	var parsed struct {
		ServerURL string `yaml:"server_url"`
	}
	if err := yaml.Unmarshal(data, &parsed); err != nil {
		return "", fmt.Errorf("parsing %s: %w", path, err)
	}
	if parsed.ServerURL == "" {
		return "", fmt.Errorf("%s has no server_url", path)
	}
	return parsed.ServerURL, nil
}

// NewPersistedServerURLProvider returns a func() string for a helper process's
// logging.ShipperConfig.ServerURL — a provider that follows a backup-server-URL
// promotion instead of freezing the startup value (#2463).
//
// Semantics:
//
//   - Re-reads agent.yaml at most once per ttl (<=0 selects the default).
//   - Falls back to the last known good URL — seeded with initial, the value
//     the caller loaded at startup — whenever a re-read fails or yields an
//     empty value. A helper that cannot read the config file must keep shipping
//     to the URL it already had, not silently stop shipping: a transient read
//     error is not evidence that the server moved.
//   - Never returns a URL it was never given: if initial is empty and every
//     read fails, it returns "", and the shipper reports that as the wiring
//     bug it is rather than POSTing to a relative URL.
//
// Safe for concurrent use — the shipper calls it from its own goroutine.
func NewPersistedServerURLProvider(cfgFile, initial string, ttl time.Duration) func() string {
	if ttl <= 0 {
		ttl = defaultPersistedServerURLTTL
	}

	var (
		mu        sync.Mutex
		lastGood  = initial
		nextCheck time.Time // zero => re-read on first call
	)

	return func() string {
		mu.Lock()
		defer mu.Unlock()

		if now := time.Now(); now.After(nextCheck) {
			nextCheck = now.Add(ttl)
			if serverURL, err := PersistedServerURL(cfgFile); err == nil {
				lastGood = serverURL
			}
			// On error: keep lastGood. Intentionally silent — this runs on the
			// log-shipping path, so logging a read failure here would be the
			// very log entry that then tries to ship through this provider.
		}
		return lastGood
	}
}
