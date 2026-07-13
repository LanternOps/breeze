package config

import (
	"fmt"
	"net/url"
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
	// Validate before handing this to a caller that will cache it.
	// SetAllAndPersist writes agent.yaml through viper.WriteConfig, which
	// truncates in place rather than doing an atomic temp+rename, so a helper
	// reading concurrently with a promotion can observe a torn file that still
	// parses as valid YAML but carries a truncated value
	// ("server_url: https://ba"). Caching that would pin the shipper to a
	// garbage host for a full TTL.
	if u, err := url.Parse(parsed.ServerURL); err != nil {
		return "", fmt.Errorf("%s has an unparsable server_url: %w", path, err)
	} else if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", fmt.Errorf("%s has a malformed server_url %q (want an http(s) URL with a host)", path, parsed.ServerURL)
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
//     the caller loaded at startup — whenever a re-read fails. A helper that
//     cannot read the config file must keep shipping to the URL it already had,
//     not silently stop shipping: a transient read error is not evidence that
//     the server moved. Callers should pass a non-empty initial.
//   - Never returns a URL it was never given: if initial is empty and every
//     read fails, it returns "", and the shipper reports that as the wiring
//     bug it is rather than POSTing to a relative URL.
//   - Reports SUSTAINED read failure on stderr. Keeping quiet would be its own
//     instance of #2463: if agent.yaml is unreadable (an ACL reharden, #1481)
//     or the agent's promotion persist failed, this provider serves a possibly
//     DEAD primary forever with no signal anywhere. stderr rather than slog
//     because this runs on the shipping path and the shipper must not log
//     through itself; both helpers redirect stderr into their log file.
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
		failures  int       // consecutive
	)

	return func() string {
		mu.Lock()
		defer mu.Unlock()

		if now := time.Now(); now.After(nextCheck) {
			// Advanced before the attempt, so a failing read backs off a full
			// TTL rather than re-reading on every chunk of every flush.
			nextCheck = now.Add(ttl)

			serverURL, err := PersistedServerURL(cfgFile)
			switch {
			case err == nil:
				failures = 0
				lastGood = serverURL
			default:
				// One failure is expected and benign: agent.yaml is written
				// with a truncating in-place write, so a read landing mid-
				// persist can tear. Sustained failure is not benign — it means
				// we may be pinned to a demoted primary. Rate-limited to keep a
				// broken path from flooding the helper log (same shape as
				// Shipper.Enqueue's drop reporting).
				failures++
				if failures == 3 || failures%60 == 0 {
					fmt.Fprintf(os.Stderr,
						"[server-url] %d consecutive failures re-reading persisted server URL: %v — still using %q, which may be a demoted primary\n",
						failures, err, lastGood)
				}
			}
		}
		return lastGood
	}
}
