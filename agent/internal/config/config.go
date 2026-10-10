package config

import (
	"bytes"
	"errors"
	"fmt"
	mathrand "math/rand"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/spf13/viper"
	"gopkg.in/yaml.v3"
)

// WatchdogConfig holds settings for the breeze-watchdog service.
type WatchdogConfig struct {
	Enabled                 bool          `mapstructure:"enabled" yaml:"enabled"`
	ProcessCheckInterval    time.Duration `mapstructure:"process_check_interval" yaml:"process_check_interval"`
	IPCProbeInterval        time.Duration `mapstructure:"ipc_probe_interval" yaml:"ipc_probe_interval"`
	HeartbeatStaleThreshold time.Duration `mapstructure:"heartbeat_stale_threshold" yaml:"heartbeat_stale_threshold"`
	MaxRecoveryAttempts     int           `mapstructure:"max_recovery_attempts" yaml:"max_recovery_attempts"`
	RecoveryCooldown        time.Duration `mapstructure:"recovery_cooldown" yaml:"recovery_cooldown"`
	// StandbyTimeout is the ABSOLUTE cap on a standby. Since #5252 it is the
	// ceiling only: a shutdown reason the agent itself sends is bounded by the
	// much shorter StandbyGrace instead, so an ordinary stop no longer leaves
	// a host unmanaged for half an hour.
	StandbyTimeout time.Duration `mapstructure:"standby_timeout" yaml:"standby_timeout"`
	// StandbyGrace is how long a recognized graceful shutdown (user_stop,
	// update, config_reload) is tolerated before the watchdog treats the agent
	// as stranded and restarts it. An agent-declared ExpectedDuration can
	// raise it; StandbyTimeout caps it.
	StandbyGrace           time.Duration `mapstructure:"standby_grace" yaml:"standby_grace"`
	FailoverPollInterval   time.Duration `mapstructure:"failover_poll_interval" yaml:"failover_poll_interval"`
	HealthJournalMaxSizeMB int           `mapstructure:"health_journal_max_size_mb" yaml:"health_journal_max_size_mb"`
	HealthJournalMaxFiles  int           `mapstructure:"health_journal_max_files" yaml:"health_journal_max_files"`
	// Auto-restart verification gate — set after Task 5 wires them.
	RestartVerificationGrace   time.Duration `mapstructure:"restart_verification_grace" yaml:"restart_verification_grace"`
	RestartVerificationTimeout time.Duration `mapstructure:"restart_verification_timeout" yaml:"restart_verification_timeout"`
	MaxRestartsPer24h          int           `mapstructure:"max_restarts_per_24h" yaml:"max_restarts_per_24h"`
}

type PolicyRegistryStateProbe struct {
	RegistryPath string `mapstructure:"registry_path"`
	ValueName    string `mapstructure:"value_name"`
}

type PolicyConfigStateProbe struct {
	FilePath  string `mapstructure:"file_path"`
	ConfigKey string `mapstructure:"config_key"`
}

type Config struct {
	AgentID   string `mapstructure:"agent_id"`
	ServerURL string `mapstructure:"server_url"`
	// BackupServerURL is a second control-plane URL delivered by the server
	// via heartbeat configUpdate (#2288). The heartbeat loop probes it after
	// backupProbeThreshold consecutive primary failures and promote-swaps on
	// a successful authenticated heartbeat. Never a secret; lives in agent.yaml.
	BackupServerURL   string `mapstructure:"backup_server_url"`
	AuthToken         string `mapstructure:"auth_token"`
	WatchdogAuthToken string `mapstructure:"watchdog_auth_token"`
	HelperAuthToken   string `mapstructure:"helper_auth_token"`
	// Issue #2621 — staged credentials from a rotation that has been durably
	// written but not yet confirmed to the server. They are persisted ALONGSIDE
	// the still-current set, never in place of it: that is what makes a crash at
	// any point during rotation survivable. On startup an agent that finds these
	// populated re-drives the confirmation instead of silently dropping them.
	PendingAuthToken         string `mapstructure:"pending_auth_token"`
	PendingWatchdogAuthToken string `mapstructure:"pending_watchdog_auth_token"`
	PendingHelperAuthToken   string `mapstructure:"pending_helper_auth_token"`
	OrgID                    string `mapstructure:"org_id"`
	SiteID                   string `mapstructure:"site_id"`
	// DeviceID is the server's device row UUID (devices.id), distinct from
	// AgentID (devices.agent_id). Security remediation Wave 5 Task 4's
	// expired-certificate recovery proof is canonicalized on this value (see
	// apps/api/src/services/mtlsRenewalProof.ts and mtls.BuildRenewalProofCanonicalBytes) —
	// NOT on AgentID. Populated from EnrollResponse.DeviceID by
	// applyEnrollResponseIdentity (internal/agentapp/main.go) at enrollment
	// time — including on a `--force` re-enrollment, which is the only
	// recovery path for an agent that enrolled before this field existed.
	//
	// KNOWN ROLLOUT PROPERTY: an agent enrolled before this field was added
	// has an empty DeviceID on disk and stays that way until it re-enrolls —
	// nothing backfills it automatically. Until then (or a server-side
	// backfill lands), expired-cert recovery renewal degrades to requesting
	// without a proof for that agent (fails closed exactly as it did before
	// this field existed, whenever the org's binding mode requires one). This
	// is a known, accepted gap for already-enrolled fleets at rollout, not a
	// bug in agents enrolled after this field landed.
	DeviceID                     string `mapstructure:"device_id"`
	HeartbeatIntervalSeconds     int    `mapstructure:"heartbeat_interval_seconds"`
	MetricsIntervalSeconds       int    `mapstructure:"metrics_interval_seconds"`
	ProcessSampleIntervalSeconds int    `mapstructure:"process_sample_interval_seconds"`
	// PatchScanIntervalHours is the cadence of the (expensive) patch scan, in
	// hours. Clamped to [1, 168] at the use site; defaults to DefaultPatchScanIntervalHours.
	PatchScanIntervalHours int      `mapstructure:"patch_scan_interval_hours"`
	EnabledCollectors      []string `mapstructure:"enabled_collectors"`
	Hardware               struct {
		ToolDirs []string `mapstructure:"tool_dirs" yaml:"tool_dirs"`
	} `mapstructure:"hardware" yaml:"hardware"`
	BackupEnabled            bool     `mapstructure:"backup_enabled"`
	BackupPaths              []string `mapstructure:"backup_paths"`
	BackupRetention          int      `mapstructure:"backup_retention"`
	BackupProvider           string   `mapstructure:"backup_provider"`
	BackupLocalPath          string   `mapstructure:"backup_local_path"`
	BackupS3Bucket           string   `mapstructure:"backup_s3_bucket"`
	BackupS3Region           string   `mapstructure:"backup_s3_region"`
	BackupS3AccessKey        string   `mapstructure:"backup_s3_access_key"`
	BackupS3SecretKey        string   `mapstructure:"backup_s3_secret_key"`
	BackupVSSEnabled         bool     `mapstructure:"backup_vss_enabled"`          // Windows: VSS shadow copy before backup
	BackupSystemStateEnabled bool     `mapstructure:"backup_system_state_enabled"` // Collect system state alongside file backup
	BackupBinaryPath         string   `mapstructure:"backup_binary_path"`          // Path to breeze-backup helper binary
	BackupStagingDir         string   `mapstructure:"backup_staging_dir"`          // Staging directory for Hyper-V exports, MSSQL backups, etc. (empty = OS temp dir)

	// Local vault (SMB share / USB drive) configuration
	VaultEnabled        bool   `mapstructure:"vault_enabled"`
	VaultPath           string `mapstructure:"vault_path"`
	VaultRetentionCount int    `mapstructure:"vault_retention_count"`

	// Logging configuration
	LogLevel         string `mapstructure:"log_level"`
	LogFormat        string `mapstructure:"log_format"`
	LogFile          string `mapstructure:"log_file"`
	LogMaxSizeMB     int    `mapstructure:"log_max_size_mb"`
	LogMaxBackups    int    `mapstructure:"log_max_backups"`
	LogShippingLevel string `mapstructure:"log_shipping_level"`

	// DesktopDebug enables verbose remote-desktop diagnostics. When true,
	// the agent's log shipper is forced up to info-level shipping for the
	// desktop and heartbeat components, surfacing per-frame heartbeats,
	// per-candidate ICE gathering, WebRTC state transitions, and the
	// hot-path findActiveHelper routing decision. Leave off in production;
	// flip on via agent.yaml when debugging a specific device. Always-on
	// warn-level events (findActiveHelper fallback, helper panic, zero-
	// relay TURN, disconnect timeout, etc.) ship regardless.
	DesktopDebug bool `mapstructure:"desktop_debug"`

	// PAMEnabled gates privileged access management features, including the
	// dormant local elevation account. Default false.
	PAMEnabled bool `mapstructure:"pam_enabled"`

	// PAMActuatorStrategy selects the Windows elevation actuator: "sendinput"
	// (Path A — inject credentials into consent.exe) or "token_launch" (Path B —
	// suppress consent.exe and launch the target elevated via CreateProcessAsUser
	// as ~breeze_elev). Default "sendinput". Path B ships dark; flip per-device
	// via agent.yaml. Ignored when PAMEnabled is false.
	PAMActuatorStrategy string `mapstructure:"pam_actuator_strategy"`

	// Concurrency limits
	MaxConcurrentCommands int `mapstructure:"max_concurrent_commands"`
	CommandQueueSize      int `mapstructure:"command_queue_size"`

	// Audit configuration
	AuditEnabled    bool `mapstructure:"audit_enabled"`
	AuditMaxSizeMB  int  `mapstructure:"audit_max_size_mb"`
	AuditMaxBackups int  `mapstructure:"audit_max_backups"`

	// User helper configuration
	UserHelperEnabled bool   `mapstructure:"user_helper_enabled"`
	IPCSocketPath     string `mapstructure:"ipc_socket_path"`
	// HelperLifecycleMode overrides on-demand vs always-on helper spawning:
	// "always-on" | "on-demand" | "auto" (default). Auto resolves to on-demand
	// on RD Session Hosts and always-on everywhere else.
	HelperLifecycleMode string `mapstructure:"helper_lifecycle_mode"`

	// Patch management
	PatchExcludeDrivers        bool     `mapstructure:"patch_exclude_drivers"`
	PatchExcludeFeatureUpdates bool     `mapstructure:"patch_exclude_feature_updates"`
	PatchMinDiskSpaceGB        float64  `mapstructure:"patch_min_disk_space_gb"`
	PatchRequireACPower        bool     `mapstructure:"patch_require_ac_power"`
	PatchMaintenanceStart      string   `mapstructure:"patch_maintenance_start"` // "HH:MM" local time
	PatchMaintenanceEnd        string   `mapstructure:"patch_maintenance_end"`   // "HH:MM" local time
	PatchMaintenanceDays       []string `mapstructure:"patch_maintenance_days"`  // ["monday",...] empty=all
	PatchRebootMaxPerDay       int      `mapstructure:"patch_reboot_max_per_day"`
	PatchAutoAcceptEula        bool     `mapstructure:"patch_auto_accept_eula"`

	// Policy state telemetry probes for registry/config checks.
	PolicyRegistryStateProbes []PolicyRegistryStateProbe `mapstructure:"policy_registry_state_probes"`
	PolicyConfigStateProbes   []PolicyConfigStateProbe   `mapstructure:"policy_config_state_probes"`

	// Auto-update toggle (default: true)
	AutoUpdate bool `mapstructure:"auto_update"`

	// AllowDevUpdate gates the `dev_update` command, which installs a binary
	// from a server-supplied URL verified ONLY against a server-supplied
	// checksum — it bypasses the Ed25519 signed-manifest trust root. Default
	// false so a compromised/MITM'd control plane cannot use dev_update to push
	// an arbitrary unsigned binary (SYSTEM/root code exec). Set true only on
	// developer/test machines that need manual dev pushes.
	AllowDevUpdate bool `mapstructure:"allow_dev_update" yaml:"allow_dev_update"`

	// PinnedManifestPubKeys are deployment-specific Ed25519 pubkeys delivered
	// via enrollment/heartbeat and pinned TOFU-style. Format: "<keyId>:<base64-raw-pubkey>".
	// Merged with the embedded LanternOps trust root in updater.trustedManifestKeys()
	// so self-host (BINARY_SOURCE=local) deployments can sign their own manifests.
	PinnedManifestPubKeys []string `mapstructure:"pinned_manifest_pub_keys" yaml:"pinned_manifest_pub_keys"`

	// RequireManifestSigningKeyID makes a release-manifest response that omits
	// signingKeyId a hard failure ("manifest signing key ID required") instead
	// of falling back to verifying against the whole trusted key set.
	//
	// Default false is the compatibility position for the rollout: an agent
	// talking to a control plane that predates signingKeyId still updates, but
	// logs one bounded warning per process. Once every control plane in the
	// fleet emits the ID, flipping this to true removes the last path on which
	// a manifest can be verified by a key other than the one it names.
	RequireManifestSigningKeyID bool `mapstructure:"require_manifest_signing_key_id" yaml:"require_manifest_signing_key_id"`

	// HPWarrantyCollectionEnabled is the control-plane switch for device-side
	// HP warranty collection via HP's CMSL (#5511). Pushed on the heartbeat as
	// warranty_settings.hp_cmsl_enabled and persisted so the setting survives a
	// restart; the collector reads it through
	// Heartbeat.hpWarrantyCollectionEnabled().
	//
	// Default false. Collection installs and runs HP software on the endpoint
	// and is opt-in per configuration policy, so an agent that has never been
	// told anything must do nothing.
	HPWarrantyCollectionEnabled bool `mapstructure:"hp_warranty_collection_enabled" yaml:"hp_warranty_collection_enabled"`

	// ManifestDelegationEpoch is the highest signed-key-delegation epoch this
	// agent has ADOPTED (0 = none). It is the monotonic replay counter: a
	// delegation is only accepted when its epoch is STRICTLY greater than this
	// value, so a record that has already been adopted — or an older one
	// resurrected by an attacker — can never be applied again.
	//
	// Persisted in the same SaveTo that adds the delegated key, so the two
	// facts can never disagree. See manifestdelegation.go.
	ManifestDelegationEpoch uint64 `mapstructure:"manifest_delegation_epoch" yaml:"manifest_delegation_epoch"`

	// mTLS client certificate (Cloudflare API Shield)
	MtlsCertPEM     string `mapstructure:"mtls_cert_pem"`
	MtlsKeyPEM      string `mapstructure:"mtls_key_pem"`
	MtlsCertExpires string `mapstructure:"mtls_cert_expires"`

	// Security remediation Wave 5 Task 5 — pending (unconfirmed) mTLS
	// certificate material staged during the two-phase renewal protocol
	// (Task 4's protocolVersion 2 /renew-cert flow). The OLD active
	// MtlsCertPEM/MtlsKeyPEM/MtlsCertExpires above remain in force and in use
	// until /renew-cert/confirm succeeds, so a crash at any point between
	// staging and confirmation never strands the agent: on restart it just
	// resumes confirmation instead of losing the certificate. Persisted and
	// cleared exactly like the active fields, via the same atomic SaveTo —
	// treated as a unit with them, not via the separate
	// mutateSecretsAndPersist path credentials.go uses for token rotation.
	//
	// PendingMTLSExpiresAt is the server's short (15-minute)
	// activation-window deadline — the point by which confirmation must
	// succeed or the pending material is discarded — NOT the certificate's
	// own multi-day/month validity (that is recovered from the certificate
	// body itself at promotion time via mtls.CertificateNotAfter, so it does
	// not need a fifth persisted field).
	PendingMTLSCertificate   string    `mapstructure:"pending_mtls_certificate"`
	PendingMTLSPrivateKey    string    `mapstructure:"pending_mtls_private_key"`
	PendingMTLSCertificateID string    `mapstructure:"pending_mtls_certificate_id"`
	PendingMTLSExpiresAt     time.Time `mapstructure:"pending_mtls_expires_at"`

	// Watchdog configuration for the breeze-watchdog service.
	Watchdog WatchdogConfig `mapstructure:"watchdog" yaml:"watchdog"`

	// WorkspaceIndex controls the server-driven workspace indexing loop.
	// Enabled nil defaults to on; explicit false is a hard local kill switch.
	WorkspaceIndex struct {
		Enabled      *bool  `mapstructure:"enabled" yaml:"enabled"`
		EndpointBase string `mapstructure:"endpoint_base" yaml:"endpoint_base"`
	} `mapstructure:"workspace_index" yaml:"workspace_index"`

	// IsService is a runtime flag set when the agent is running as a system service
	// (Windows SCM, macOS launchd, Linux systemd). It is not persisted to config.
	IsService bool `mapstructure:"-"`

	// IsHeadless is a runtime flag set when no console/TTY is attached (launchd
	// daemon, systemd service, etc.). Desktop commands route through IPC when set.
	IsHeadless bool `mapstructure:"-"`

	// IsInstalledAgent is a runtime flag set when this process is the host's
	// installed Breeze agent: started by the OS service manager (Windows SCM,
	// macOS LaunchDaemon, Linux systemd as root), running from the canonical
	// agent.yaml under ConfigDir(), and not a Quick Support client. Only that
	// process owns machine-wide artifacts shared with other Breeze processes on
	// the host (the Breeze Assist package, its autostart entry and its
	// per-session state). A foreground `run`, a second build pointed at another
	// config file, or a Quick Support client must leave those alone.
	// Runtime-only, never read from disk.
	IsInstalledAgent bool `mapstructure:"-"`

	// SupportMode marks this process as an ephemeral Quick Support client:
	// enrolled into a throwaway temp workspace, serving one remote-desktop
	// session, then self-destructing. It gates off everything a disposable
	// client must not do (watchdog, updater, background collector loops) and
	// — critically — is the guard that lets a support_end command destroy
	// this process while refusing to touch a real, permanently-installed
	// agent. Runtime-only: `mapstructure:"-"` keeps it out of any config
	// round-trip, so it can never be set by a file on disk.
	SupportMode bool `mapstructure:"-"`

	// SupportSessionID is the server-side support session this client was
	// redeemed for. Runtime-only, same reasoning as SupportMode.
	SupportSessionID string `mapstructure:"-"`

	// SupportWorkDir is the temp directory holding this support client's
	// config, secrets and log file. It is what the self-destruct removes, so
	// it must NEVER be the real agent config dir. Runtime-only.
	SupportWorkDir string `mapstructure:"-"`
}

// IsEnrolled reports whether cfg represents a complete enrollment — both
// the AgentID (written to agent.yaml) and the AuthToken (written to
// secrets.yaml). Callers that poll for enrollment readiness MUST use
// this predicate rather than checking AgentID alone, because SaveTo
// writes agent.yaml before secrets.yaml and a concurrent reader can
// otherwise observe a torn write (AgentID set but AuthToken not yet
// persisted). A torn read simply causes one more poll cycle.
func IsEnrolled(cfg *Config) bool {
	return cfg != nil && cfg.AgentID != "" && cfg.AuthToken != ""
}

// defaultLogFile returns the platform-specific default log file path.
func defaultLogFile() string {
	// A support session logs inside its private folder (#7629).
	if root := registeredUserWorkspace(); root != "" {
		return filepath.Join(root, "logs", "agent.log")
	}
	switch runtime.GOOS {
	case "windows":
		return filepath.Join(configDir(), "logs", "agent.log")
	case "darwin":
		return "/Library/Application Support/Breeze/logs/agent.log"
	default:
		return "/var/log/breeze/agent.log"
	}
}

// LogDir returns the platform-specific directory where agent logs are written.
func LogDir() string {
	return filepath.Dir(defaultLogFile())
}

// ConfigDir returns the platform-specific configuration directory.
func ConfigDir() string {
	return configDir()
}

// DefaultPatchScanIntervalHours is the default patch-scan cadence. Shared so the
// config default and the heartbeat clamp don't drift apart.
const DefaultPatchScanIntervalHours = 24

// DefaultHeartbeatIntervalSeconds is the default heartbeat cadence. Shared for
// the same reason as the patch-scan default above: authstate's backoff cap is
// tuned to sit ABOVE this interval (a cap at or below it suppresses nothing),
// and that invariant is only enforceable if both sides read one constant.
const DefaultHeartbeatIntervalSeconds = 60

func Default() *Config {
	return &Config{
		HeartbeatIntervalSeconds:     DefaultHeartbeatIntervalSeconds,
		MetricsIntervalSeconds:       30,
		ProcessSampleIntervalSeconds: 180,
		PatchScanIntervalHours:       DefaultPatchScanIntervalHours,
		EnabledCollectors:            []string{"hardware", "software", "metrics", "network"},
		LogLevel:                     "info",
		LogFormat:                    "text",
		LogFile:                      defaultLogFile(),
		LogMaxSizeMB:                 50,
		LogMaxBackups:                3,
		LogShippingLevel:             "warn",
		PAMEnabled:                   false,
		PAMActuatorStrategy:          "sendinput",
		MaxConcurrentCommands:        10,
		CommandQueueSize:             100,
		AuditEnabled:                 true,
		AuditMaxSizeMB:               50,
		AuditMaxBackups:              3,

		AutoUpdate:                 true,
		PatchExcludeFeatureUpdates: true,
		PatchMinDiskSpaceGB:        2.0,
		PatchRequireACPower:        true,
		PatchRebootMaxPerDay:       3,
		PatchAutoAcceptEula:        false,
		PolicyRegistryStateProbes:  []PolicyRegistryStateProbe{},
		PolicyConfigStateProbes:    []PolicyConfigStateProbe{},

		Watchdog: WatchdogConfig{
			Enabled:                 true,
			ProcessCheckInterval:    5 * time.Second,
			IPCProbeInterval:        30 * time.Second,
			HeartbeatStaleThreshold: 3 * time.Minute,
			MaxRecoveryAttempts:     3,
			RecoveryCooldown:        10 * time.Minute,
			StandbyTimeout:          30 * time.Minute,
			// Kept in lockstep with watchdog.DefaultStandbyGrace by
			// TestStandbyGraceDefaultMatchesConfigDefault (it lives in the
			// watchdog package, which may import config; not the reverse —
			// watchdog/netcache.go already imports config). Not imported:
			// config is the more fundamental package and must not grow a
			// dependency on the watchdog for one constant.
			StandbyGrace:               2 * time.Minute,
			FailoverPollInterval:       30 * time.Second,
			HealthJournalMaxSizeMB:     10,
			HealthJournalMaxFiles:      3,
			RestartVerificationGrace:   30 * time.Second,
			RestartVerificationTimeout: 120 * time.Second,
			MaxRestartsPer24h:          5,
		},
	}
}

// Load reads the config file (and secrets.yaml) into a fresh *Config.
//
// It takes persistMu because it MUTATES the package-global viper singleton
// (SetConfigFile/AddConfigPath/AutomaticEnv/ReadInConfig/Unmarshal), and viper
// has no internal locking. It is not a startup-only path: Reload runs on every
// successful manifest-key pin and every delivered delegation record, while
// SetAndPersist (command worker pool), SaveTo (cert-renewal goroutine) and
// SetAllAndPersist (backup-URL promotion) write viper from other goroutines.
// Several of those races are MAP races, which in production are not a corrupt
// value but `fatal error: concurrent map read and map write` — an unrecoverable
// throw that kills the agent process.
//
// Callers already holding persistMu must use loadLocked (sync.Mutex is not
// reentrant). Verified when this lock was widened: no persistMu holder reaches
// Load transitively — SetAndPersist/SetAllAndPersist/SetSecretAndPersist/SaveTo/
// mutateSecretsAndPersist all stay inside viper.Set/WriteConfig, their own
// viper.New() instances, migrateInlineSecretsToSecretFile and the enforce*
// permission helpers, none of which call Load or Reload.
func Load(cfgFile string) (*Config, error) {
	persistMu.Lock()
	defer persistMu.Unlock()
	return loadLocked(cfgFile)
}

// loadLocked is Load's body; callers must hold persistMu. It exists so a
// read-modify-write over the config file (PinManifestKeys,
// ApplyManifestKeyDelegation) can hold the lock across BOTH halves instead of
// dropping it between the read and the write.
func loadLocked(cfgFile string) (*Config, error) {
	// Checked before viper is touched: a refused load must not rebind the
	// process to a config outside its user workspace, since every later
	// persist follows the bound file (#7629).
	if err := checkConfigTarget(cfgFile); err != nil {
		return nil, err
	}
	cfg := Default()

	// The machine-wide agent.yaml is read only through the trust check (see
	// machine_config_trust.go): the file and folder must be ones no other
	// account can have written, and what viper parses is what was read from
	// the checked handle.
	trustedFile := ""
	if cfgFile != "" {
		viper.SetConfigFile(cfgFile)
		if machineConfigFileNeedsTrust(cfgFile) {
			trustedFile = cfgFile
		}
	} else if p := defaultConfigFilePath(); machineConfigFileNeedsTrust(p) {
		if _, err := os.Lstat(p); err == nil {
			viper.SetConfigFile(p)
			trustedFile = p
		} else {
			// No machine config yet: look only in the working directory,
			// never for some other agent.* in the machine folder.
			viper.SetConfigName("agent")
			viper.SetConfigType("yaml")
			viper.AddConfigPath(".")
		}
	} else {
		viper.SetConfigName("agent")
		viper.SetConfigType("yaml")
		viper.AddConfigPath(configDir())
		viper.AddConfigPath(".")
	}

	viper.AutomaticEnv()
	viper.SetEnvPrefix("BREEZE")

	if trustedFile != "" {
		data, err := readTrustedMachineConfigFileFn(trustedFile)
		switch {
		case errors.Is(err, os.ErrNotExist) && cfgFile == "":
			// Removed since the Lstat above: a fresh host, as below.
		case err != nil:
			return nil, err
		default:
			viper.SetConfigType("yaml")
			if err := viper.ReadConfig(bytes.NewReader(data)); err != nil {
				return nil, fmt.Errorf("reading %s: %w", trustedFile, err)
			}
		}
	} else if err := viper.ReadInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			return nil, err
		}
	}

	if err := viper.Unmarshal(cfg); err != nil {
		return nil, err
	}

	// Accept watchdog.max_heartbeat_staleness_sec (in seconds) as documented in
	// issue #799 — coerce to the canonical Duration field. The alias mechanism
	// in viper does not coerce numeric→Duration, so we read it explicitly after
	// Unmarshal.
	if v := viper.GetInt("watchdog.max_heartbeat_staleness_sec"); v > 0 {
		cfg.Watchdog.HeartbeatStaleThreshold = time.Duration(v) * time.Second
	}

	// Merge secrets from the separate secrets file if it exists.
	// Old-format configs with inline secrets still work via the unmarshal
	// above; the secrets file values take precedence when present.
	secretsPath := secretsFilePathFor(viper.ConfigFileUsed())
	sv, err := readSecretsFile(secretsPath)
	if err != nil {
		return nil, err
	}
	if sv != nil {
		// IMPORTANT: this read-back is a hardcoded list and CANNOT be driven by
		// isSecretYAMLKey (there's no generic config-key -> struct-field mapping
		// at this layer). When you add a new secret field, update BOTH
		// isSecretYAMLKey (so it gets stripped to secrets.yaml) AND this block
		// (so it gets read back) — otherwise the field is silently lost on load.
		if v := sv.GetString("auth_token"); v != "" {
			cfg.AuthToken = v
		}
		if v := sv.GetString("watchdog_auth_token"); v != "" {
			cfg.WatchdogAuthToken = v
		}
		if v := sv.GetString("helper_auth_token"); v != "" {
			cfg.HelperAuthToken = v
		}
		// Issue #2621 — staged rotation credentials. Losing these on load would
		// reintroduce the stranding bug from the other direction: the server may
		// already have promoted them, and this is the agent's only durable copy.
		if v := sv.GetString("pending_auth_token"); v != "" {
			cfg.PendingAuthToken = v
		}
		if v := sv.GetString("pending_watchdog_auth_token"); v != "" {
			cfg.PendingWatchdogAuthToken = v
		}
		if v := sv.GetString("pending_helper_auth_token"); v != "" {
			cfg.PendingHelperAuthToken = v
		}
		if v := sv.GetString("mtls_cert_pem"); v != "" {
			cfg.MtlsCertPEM = v
		}
		if v := sv.GetString("mtls_key_pem"); v != "" {
			cfg.MtlsKeyPEM = v
		}
		if v := sv.GetString("mtls_cert_expires"); v != "" {
			cfg.MtlsCertExpires = v
		}
		// Wave 5 Task 5 — pending mTLS material. Reading these back on Load is
		// what makes crash/restart resumption possible: the heartbeat's
		// reconcile-on-startup logic checks these fields on the in-memory cfg
		// it was constructed with, so a staged-but-unconfirmed renewal from a
		// prior process must land here, not just in secrets.yaml.
		if v := sv.GetString("pending_mtls_certificate"); v != "" {
			cfg.PendingMTLSCertificate = v
		}
		if v := sv.GetString("pending_mtls_private_key"); v != "" {
			cfg.PendingMTLSPrivateKey = v
		}
		if v := sv.GetString("pending_mtls_certificate_id"); v != "" {
			cfg.PendingMTLSCertificateID = v
		}
		if t := sv.GetTime("pending_mtls_expires_at"); !t.IsZero() {
			cfg.PendingMTLSExpiresAt = t
		}
		// Companion: backup S3 credentials migrate to secrets.yaml via
		// isSecretYAMLKey; read them back so BackupS3AccessKey/BackupS3SecretKey
		// are populated after Load (otherwise backup config silently breaks).
		if v := sv.GetString("backup_s3_access_key"); v != "" {
			cfg.BackupS3AccessKey = v
		}
		if v := sv.GetString("backup_s3_secret_key"); v != "" {
			cfg.BackupS3SecretKey = v
		}
	}

	// Validate config: fatals block startup, warnings are logged and continue.
	result := cfg.ValidateTiered()
	for _, err := range result.Warnings {
		log.Warn("config validation", "error", err)
	}
	if result.HasFatals() {
		for _, err := range result.Fatals {
			log.Error("config validation fatal", "error", err)
		}
		return nil, fmt.Errorf("config has fatal validation errors: %v", result.Fatals[0])
	}

	return cfg, nil
}

// persistMu serializes every access to the package-global viper singleton:
// the persists (SetAndPersist, SetAllAndPersist, SetSecretAndPersist, SaveTo,
// mutateSecretsAndPersist) AND the loads (Load, Reload, and the
// read-modify-write pairs PinManifestKeys / ApplyManifestKeyDelegation). All of
// them mutate viper state and rewrite the same files; concurrent callers (e.g. a
// set_auto_update command worker racing a backup-URL promotion, or a Reload
// after a manifest-key pin racing the cert-renewal goroutine's SaveTo) raced
// viper's internal maps and each other's writes.
//
// Load was outside this lock until the wave-06 whole-branch review: with
// Reload now running per successful pin and per delivered delegation record it
// is on the per-heartbeat path, and a map race there is a
// `fatal error: concurrent map read and map write` process kill, not a bad
// value. See Load's comment for the deadlock audit.
//
// (FixConfigPermissions' inline-secret migration still writes outside this
// lock — a pre-existing, startup-only path with no concurrent writer.)
var persistMu sync.Mutex

// SetAllAndPersist updates several non-secret config keys in viper and writes
// them to the config file in a SINGLE write, so related keys (e.g. the
// server_url/backup_server_url swap on backup promotion, #2288) can never be
// torn across two file writes by a crash between them. Secret keys are routed
// to secrets.yaml exactly as in SetAndPersist.
func SetAllAndPersist(kv map[string]any) error {
	persistMu.Lock()
	defer persistMu.Unlock()
	path := viper.ConfigFileUsed()
	if err := checkConfigTarget(path); err != nil {
		return err
	}

	if path != "" {
		if err := migrateInlineSecretsToSecretFile(path); err != nil {
			return err
		}
	}
	for _, k := range viper.AllKeys() {
		if isSecretYAMLKey(k) {
			viper.Set(k, nil)
		}
	}

	for key, value := range kv {
		if isSecretConfigKey(key) {
			if err := setSecretAndPersistLocked(key, value); err != nil {
				return err
			}
			viper.Set(key, nil)
		} else {
			viper.Set(key, value)
		}
	}
	if err := writeAgentYAMLFromViperLocked(path); err != nil {
		return err
	}
	if path != "" {
		if err := migrateInlineSecretsToSecretFile(path); err != nil {
			return err
		}
		return enforceConfigFilePermissions(path)
	}
	return nil
}

// SetAndPersist updates a single non-secret config key in viper and writes it
// to the existing config file. Any legacy inline secrets are migrated to
// secrets.yaml and scrubbed from agent.yaml after the write.
func SetAndPersist(key string, value any) error {
	persistMu.Lock()
	defer persistMu.Unlock()
	path := viper.ConfigFileUsed()
	if err := checkConfigTarget(path); err != nil {
		return err
	}

	// SECURITY: move any legacy inline secrets out of the on-disk agent.yaml into
	// root-only secrets.yaml BEFORE re-serializing viper, and clear them from
	// viper memory, so the WriteConfig below can never write a plaintext secret
	// to the world-readable (0644) agent.yaml. Previously WriteConfig serialized
	// the full viper state — including still-loaded legacy inline secrets — to
	// agent.yaml first and only stripped them afterwards, a transient plaintext
	// bearer-token exposure on the first run after an upgrade.
	if path != "" {
		if err := migrateInlineSecretsToSecretFile(path); err != nil {
			return err
		}
	}
	for _, k := range viper.AllKeys() {
		if isSecretYAMLKey(k) {
			viper.Set(k, nil)
		}
	}

	if isSecretConfigKey(key) {
		if err := setSecretAndPersistLocked(key, value); err != nil {
			return err
		}
		viper.Set(key, nil)
	} else {
		viper.Set(key, value)
	}
	if err := writeAgentYAMLFromViperLocked(path); err != nil {
		return err
	}
	if path != "" {
		// Defense-in-depth: clear any nil'd secret keys / late inline secrets
		// from agent.yaml after the write.
		if err := migrateInlineSecretsToSecretFile(path); err != nil {
			return err
		}
		return enforceConfigFilePermissions(path)
	}
	return nil
}

// writeAgentYAMLFromViperLocked serializes viper's settings to the config file
// at path with every secret key removed, atomically. viper.Set(key, nil) does
// NOT hide a value viper loaded from the file — lookups fall through to the
// config layer — so a secret an older agent left in agent.yaml stays in memory
// after the startup scrub and a plain WriteConfig would put it straight back
// in the world-readable file. Callers must hold persistMu.
func writeAgentYAMLFromViperLocked(path string) error {
	if path == "" {
		// No file was loaded, so viper holds no file-sourced secrets.
		return viper.WriteConfig()
	}
	data, err := yaml.Marshal(viper.AllSettings())
	if err != nil {
		return fmt.Errorf("marshaling agent config: %w", err)
	}
	data, err = stripSecretsFromAgentConfig(data)
	if err != nil {
		return fmt.Errorf("writing agent config: %w", err)
	}
	if err := atomicWriteFile(path, data, 0644); err != nil {
		return err
	}
	// The rename installs the temp file's private ACL; the content is already
	// clear of secrets, so restore Helper read access now rather than only
	// after the caller's follow-up steps succeed (same as saveToLocked).
	if err := enforceConfigFilePermissions(path); err != nil {
		log.Warn("failed to enforce config file permissions", "path", path, "error", err.Error())
	}
	return nil
}

func SetSecretAndPersist(key string, value any) error {
	persistMu.Lock()
	defer persistMu.Unlock()
	return setSecretAndPersistLocked(key, value)
}

// setSecretAndPersistLocked is SetSecretAndPersist's body; callers must hold
// persistMu.
func setSecretAndPersistLocked(key string, value any) error {
	path := secretsFilePath()
	if err := checkConfigTarget(path); err != nil {
		return err
	}
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
	sv.Set(key, value)

	// SECURITY: write atomically at 0600 — never via a 0644 temp file. The
	// previous WriteConfigAs(tmp) path created a world-readable (0644) temp file
	// holding the plaintext secret in the config dir before copying to the 0600
	// target, a local-user read window. atomicWriteFile creates its .partial tmp
	// at the requested 0600, so the secret is never world-readable on disk.
	secretsYAML, err := yaml.Marshal(sv.AllSettings())
	if err != nil {
		return fmt.Errorf("marshaling secrets file: %w", err)
	}
	if err := atomicWriteFile(path, secretsYAML, 0600); err != nil {
		return err
	}
	return enforceSecretFilePermissions(path)
}

// Reload reloads the currently bound config file, or the default config path
// when no explicit file has been loaded yet.
//
// viper.ConfigFileUsed() is itself a read of the shared singleton, so it is
// taken INSIDE the lock rather than passed to Load from outside it.
func Reload() (*Config, error) {
	persistMu.Lock()
	defer persistMu.Unlock()
	return loadLocked(viper.ConfigFileUsed())
}

func Save(cfg *Config) error {
	return SaveTo(cfg, "")
}

// SaveTo writes cfg to agent.yaml and its non-credential secrets to
// secrets.yaml.
//
// Issue #2773 — SaveTo does NOT write credential state from cfg. The agent,
// watchdog and helper tokens and the staged pending_* set are owned by
// StagePendingCredentials / PromotePendingCredentials / ClearPendingCredentials,
// which update secrets.yaml directly and never touch the caller's *Config, so
// cfg is a snapshot that can be arbitrarily stale relative to them: Load copies
// pending_* into the struct once at startup and nothing refreshes it, and the
// mTLS renewal paths capture the bearer token before taking any lock. Letting
// that snapshot win wrote credentials the server no longer accepts over the
// ones it does. So whatever is on disk is preserved verbatim; cfg only fills a
// credential the disk does not have yet (the first save of a fresh install).
// Enrollment, the one caller whose in-memory credentials ARE authoritative,
// uses SaveEnrollment.
//
// #8317 — the same holds for org_id/site_id: once agent.yaml has them, they
// are preserved from disk (see identitySource); only enrollment and
// PersistServerIdentity change them.
func SaveTo(cfg *Config, cfgFile string) error {
	persistMu.Lock()
	defer persistMu.Unlock()
	return saveToLocked(cfg, cfgFile, credentialsFromDisk)
}

// SaveEnrollment is SaveTo for a freshly enrolled identity: cfg's agent,
// watchdog and helper tokens replace whatever is on disk, and any staged
// pending_* set is dropped — it belonged to the previous identity and can
// never be promoted against the new one.
func SaveEnrollment(cfg *Config, cfgFile string) error {
	persistMu.Lock()
	defer persistMu.Unlock()
	return saveToLocked(cfg, cfgFile, credentialsFromConfig)
}

// credentialSource selects who is authoritative for credential keys in a
// saveToLocked call. See SaveTo and SaveEnrollment.
type credentialSource int

const (
	credentialsFromDisk credentialSource = iota
	credentialsFromConfig
)

// resolveCredentialsForSave decides the credential values a saveToLocked call
// writes. Callers must hold persistMu, which is what makes this read and the
// rewrite that follows atomic against the credential writers.
func resolveCredentialsForSave(cfg *Config, cfgPath string, source credentialSource) (PersistedCredentials, error) {
	onDisk, readErr := readPersistedCredentialsAt(cfgPath)
	if readErr != nil {
		if !errors.Is(readErr, os.ErrNotExist) {
			if source == credentialsFromDisk {
				// Fail closed. The file exists but could not be parsed, and the
				// write that follows replaces it wholesale: proceeding would drop
				// every credential cfg lacks — including a staged set the server
				// may already have promoted, i.e. the agent's only copy of its
				// current credential.
				return PersistedCredentials{}, fmt.Errorf("reading existing credentials before rewriting the secrets file: %w", readErr)
			}
			log.Warn("could not read existing credentials while saving an enrollment; replacing them",
				"error", readErr.Error())
		}
		onDisk = &PersistedCredentials{}
	}

	pick := func(primary, fallback string) string {
		if primary != "" {
			return primary
		}
		return fallback
	}
	if source == credentialsFromConfig {
		return PersistedCredentials{
			AuthToken:         pick(cfg.AuthToken, onDisk.AuthToken),
			WatchdogAuthToken: pick(cfg.WatchdogAuthToken, onDisk.WatchdogAuthToken),
			HelperAuthToken:   pick(cfg.HelperAuthToken, onDisk.HelperAuthToken),
		}, nil
	}
	return PersistedCredentials{
		AuthToken:         pick(onDisk.AuthToken, cfg.AuthToken),
		WatchdogAuthToken: pick(onDisk.WatchdogAuthToken, cfg.WatchdogAuthToken),
		HelperAuthToken:   pick(onDisk.HelperAuthToken, cfg.HelperAuthToken),
		// Never from cfg: its Pending* fields are the startup snapshot, so they
		// either resurrect a set that was since cleared or replace a newer one.
		PendingAuthToken:         onDisk.PendingAuthToken,
		PendingWatchdogAuthToken: onDisk.PendingWatchdogAuthToken,
		PendingHelperAuthToken:   onDisk.PendingHelperAuthToken,
	}, nil
}

// ResolveSavePath returns the agent.yaml path SaveTo and SaveEnrollment write
// for cfgFile: cfgFile itself, or the default agent.yaml in ConfigDir when the
// --config flag was left empty. Use it wherever a message names the config
// file, so an empty flag never prints as an empty path (#7394).
func ResolveSavePath(cfgFile string) string {
	if cfgFile != "" {
		return cfgFile
	}
	return filepath.Join(configDir(), "agent.yaml")
}

// PrepareSaveDir creates and secures the directory SaveEnrollment will write
// cfgFile's agent.yaml into, exactly as the save itself does first, without
// writing any file. Enrollment calls it before the enroll request so that a
// directory the agent cannot secure fails the enrollment before the server
// creates a device, instead of after (#7394).
func PrepareSaveDir(cfgFile string) error {
	return prepareSaveDir(ResolveSavePath(cfgFile))
}

func prepareSaveDir(cfgPath string) error {
	// Also the first step of every SaveTo / SaveEnrollment, so this one check
	// keeps both inside a registered user workspace (#7629).
	if err := checkConfigTarget(cfgPath); err != nil {
		return err
	}
	dir := filepath.Dir(cfgPath)
	if dir == "." {
		return nil
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	return enforceConfigDirPermissions(dir)
}

// saveToLocked is SaveTo's body; callers must hold persistMu. Paired with
// loadLocked so a read-modify-write of the config file is atomic against every
// other viper user.
func saveToLocked(cfg *Config, cfgFile string, source credentialSource) error {
	identity := identityFromDisk
	if source == credentialsFromConfig {
		identity = identityFromConfig
	}
	return saveToLockedWithIdentity(cfg, cfgFile, source, identity)
}

// identitySource selects who is authoritative for org_id/site_id in a save.
//
// #8317 — they are written by enrollment and by PersistServerIdentity (a
// server-signed reassignment) and by nothing else. Every other save passes a
// *Config the caller loaded at startup — the token-rotation and mTLS paths
// pass the heartbeat's — so between a reassignment and the restart that
// applies it those copies still hold the old pair, and a plain SaveTo would
// write it back over the new one. Same rule as credentials (#2773).
type identitySource int

const (
	identityFromDisk identitySource = iota
	identityFromConfig
)

func saveToLockedWithIdentity(cfg *Config, cfgFile string, source credentialSource, identity identitySource) error {
	cfgPath := ResolveSavePath(cfgFile)
	if err := prepareSaveDir(cfgPath); err != nil {
		return err
	}

	// Resolved BEFORE anything is written, so an unreadable secrets file aborts
	// the save without touching agent.yaml either.
	creds, err := resolveCredentialsForSave(cfg, cfgPath, source)
	if err != nil {
		return err
	}

	orgID, siteID := cfg.OrgID, cfg.SiteID
	if identity == identityFromDisk {
		orgID, siteID = resolveOrgSiteForSave(cfgPath, orgID, siteID)
	}

	viper.Set("agent_id", cfg.AgentID)
	viper.Set("server_url", cfg.ServerURL)
	viper.Set("backup_server_url", cfg.BackupServerURL)
	viper.Set("org_id", orgID)
	viper.Set("site_id", siteID)
	viper.Set("device_id", cfg.DeviceID)
	viper.Set("heartbeat_interval_seconds", cfg.HeartbeatIntervalSeconds)
	viper.Set("metrics_interval_seconds", cfg.MetricsIntervalSeconds)
	viper.Set("enabled_collectors", cfg.EnabledCollectors)
	viper.Set("hardware.tool_dirs", cfg.Hardware.ToolDirs)
	viper.Set("policy_registry_state_probes", cfg.PolicyRegistryStateProbes)
	viper.Set("policy_config_state_probes", cfg.PolicyConfigStateProbes)
	viper.Set("log_level", cfg.LogLevel)
	viper.Set("log_shipping_level", cfg.LogShippingLevel)
	viper.Set("pam_enabled", cfg.PAMEnabled)
	viper.Set("pam_actuator_strategy", cfg.PAMActuatorStrategy)
	viper.Set("auto_update", cfg.AutoUpdate)
	viper.Set("allow_dev_update", cfg.AllowDevUpdate)
	viper.Set("pinned_manifest_pub_keys", cfg.PinnedManifestPubKeys)
	viper.Set("require_manifest_signing_key_id", cfg.RequireManifestSigningKeyID)
	viper.Set("hp_warranty_collection_enabled", cfg.HPWarrantyCollectionEnabled)
	viper.Set("manifest_delegation_epoch", cfg.ManifestDelegationEpoch)
	// helper_auth_token is deliberately NOT set here on any platform: agent.yaml
	// is readable by every local user. It goes to secrets.yaml below; Windows
	// delivers it to the console-session Breeze Assist over IPC, and Unix also
	// writes the group-scoped helper token file (writeHelperTokenFileFor).

	// Serialize via viper (same encoder as WriteConfigAs), strip secrets, then
	// write atomically: tmp file in the same directory → fsync → rename. The
	// fsync + rename pair guards against power-loss leaving agent.yaml
	// zero-length or partially written between O_TRUNC and the final flush.
	cfgYAML, err := yaml.Marshal(viper.AllSettings())
	if err != nil {
		return fmt.Errorf("marshaling agent config: %w", err)
	}
	// Fail closed: if stripping secrets errors, abort BEFORE writing the
	// world-readable agent.yaml so the unstripped buffer can never leak to it.
	cfgYAML, err = stripSecretsFromAgentConfig(cfgYAML)
	if err != nil {
		return fmt.Errorf("writing agent config: %w", err)
	}
	// agent.yaml is world-readable (0644) so the Breeze Helper, running as the
	// logged-in user, can read its server URL and agent id. It carries no
	// tokens; every credential and mTLS key goes to root-only secrets.yaml below.
	if err := atomicWriteFile(cfgPath, cfgYAML, 0644); err != nil {
		return fmt.Errorf("writing agent config: %w", err)
	}

	// Defense-in-depth: ensure permissions are correct even if umask interfered.
	if err := enforceConfigDirPermissions(filepath.Dir(cfgPath)); err != nil {
		log.Warn("failed to enforce config dir permissions", "error", err.Error())
	}
	if err := enforceConfigFilePermissions(cfgPath); err != nil {
		log.Warn("failed to enforce config file permissions", "error", err.Error())
	}

	// Write secrets to a separate root-only file.
	secretsPath := secretsFilePathFor(cfgPath)
	sv := viper.New()

	// Issue #2621 — SaveTo rebuilds the secrets file from scratch, so every
	// credential it does not re-write is DROPPED. creds (resolved above under
	// persistMu — see resolveCredentialsForSave for who wins) carries each one
	// forward. An empty value is not written; it never blanks a real token.
	setCredential := func(key, value string) {
		if value != "" {
			sv.Set(key, value)
		}
	}
	setCredential(secretKeyAuthToken, creds.AuthToken)
	setCredential(secretKeyWatchdogAuthToken, creds.WatchdogAuthToken)
	setCredential(secretKeyHelperAuthToken, creds.HelperAuthToken)

	// Unix only (no-op on Windows): also persist the helper token to its own
	// group-scoped file, from the same resolved value so the copies agree.
	if err := writeHelperTokenFileFor(cfgPath, creds.HelperAuthToken); err != nil {
		return fmt.Errorf("writing helper token file: %w", err)
	}

	setCredential(secretKeyPendingAuthToken, creds.PendingAuthToken)
	setCredential(secretKeyPendingWatchdogAuthToken, creds.PendingWatchdogAuthToken)
	setCredential(secretKeyPendingHelperAuthToken, creds.PendingHelperAuthToken)

	sv.Set("mtls_cert_pem", cfg.MtlsCertPEM)
	sv.Set("mtls_key_pem", cfg.MtlsKeyPEM)
	sv.Set("mtls_cert_expires", cfg.MtlsCertExpires)
	// Wave 5 Task 5 — pending mTLS material persists as a unit with the
	// active fields above: unconditionally taken from cfg (never a
	// preserve-on-disk fallback), exactly like MtlsCertPEM/KeyPEM/Expires.
	// Every mutation site (stage / confirm+promote / expire+clear) keeps
	// cfg's in-memory Pending* fields correct before calling SaveTo, so a
	// single atomic rewrite here both moves pending->active and clears
	// pending in one write when promoting.
	sv.Set("pending_mtls_certificate", cfg.PendingMTLSCertificate)
	sv.Set("pending_mtls_private_key", cfg.PendingMTLSPrivateKey)
	sv.Set("pending_mtls_certificate_id", cfg.PendingMTLSCertificateID)
	sv.Set("pending_mtls_expires_at", cfg.PendingMTLSExpiresAt)
	// Backup S3 credentials are caught by isSecretYAMLKey (suffix _access_key /
	// _secret_key) and stripped from agent.yaml; persist them here so they
	// survive a round-trip through SaveTo → Load. Only write non-empty values
	// for the same reason as auth_token above.
	if cfg.BackupS3AccessKey != "" {
		sv.Set("backup_s3_access_key", cfg.BackupS3AccessKey)
	}
	if cfg.BackupS3SecretKey != "" {
		sv.Set("backup_s3_secret_key", cfg.BackupS3SecretKey)
	}

	// Same atomic-write pattern for the secrets file (0600).
	secretsYAML, err := yaml.Marshal(sv.AllSettings())
	if err != nil {
		return fmt.Errorf("marshaling secrets file: %w", err)
	}
	if err := atomicWriteFile(secretsPath, secretsYAML, 0600); err != nil {
		return fmt.Errorf("writing secrets file: %w", err)
	}

	// Enforce secrets permissions — this is fatal, not just a warning, because
	// leaving secrets.yaml world-readable after a failed chmod is a security
	// breach. agent.yaml/dir chmod failures remain warn-only (see the log.Warn
	// calls right after the agent.yaml write above).
	if err := enforceSecretFilePermissions(secretsPath); err != nil {
		return fmt.Errorf("enforcing secrets file permissions on %s: %w", secretsPath, err)
	}

	return nil
}

// stripSecretsFromAgentConfig removes secret-bearing keys (see isSecretYAMLKey)
// from a serialized agent.yaml buffer. It MUST fail closed: on any
// unmarshal/marshal error it returns a wrapped error and NO data, never the
// original unstripped buffer. The caller (SaveTo) aborts before writing the
// world-readable (0644) agent.yaml, so secrets can never leak to that file.
// stripMarshalForTests lets tests force the post-delete marshal step to fail so
// the fail-closed SaveTo abort path (secrets never written to agent.yaml) can be
// exercised. nil in production => real yaml.Marshal.
var stripMarshalForTests func(any) ([]byte, error)

func stripSecretsFromAgentConfig(data []byte) ([]byte, error) {
	var values map[string]any
	if err := yaml.Unmarshal(data, &values); err != nil {
		return nil, fmt.Errorf("stripping secrets from agent config (unmarshal): %w", err)
	}
	for key := range values {
		if isSecretYAMLKey(key) {
			delete(values, key)
		}
	}
	marshal := yaml.Marshal
	if stripMarshalForTests != nil {
		marshal = stripMarshalForTests
	}
	out, err := marshal(values)
	if err != nil {
		return nil, fmt.Errorf("stripping secrets from agent config (marshal): %w", err)
	}
	return out, nil
}

// Rename retry bounds for atomicWriteFile / writeYAMLFile. A rename-over-
// existing destination can fail transiently — observed in production on
// Windows Server 2022 as Windows Defender real-time protection (zero
// exclusions configured) briefly holding secrets.yaml open during the write.
// A single failed attempt used to be treated as a hard failure:
// StagePendingCredentials aborts the rotation and discards the staged
// credential set on ANY write error, so one transient lock permanently lost
// that rotation attempt. Because the server's staged set then expires and
// token_issued_at never advances, isAgentTokenRotationDue stays true and the
// next heartbeat stages again — the stage→expire→re-stage loop in issue
// #2772 (agent.token.rotate.confirmed has never fired in production).
//
// Mirrors the retry/backoff shape in agent/internal/state/state.go (Write),
// but with a longer schedule: state.go's own comment notes its 4 attempts /
// ~175ms total still lost on the box that reproduced this bug, and the
// credential file is the one write that must not be silently dropped.
const (
	renameAttempts    = 8
	renameBackoffBase = 25 * time.Millisecond
)

// renameFile is a seam for tests to inject rename failures. Defaults to
// os.Rename in production.
var renameFile = os.Rename

// renameRetrySleep is a seam for tests to skip the real backoff delay.
// Defaults to time.Sleep in production; the exhausted-retries test overrides
// it to a no-op so it doesn't burn ~6s of real wall-clock time on every run
// while still exercising the full attempt-count and cleanup logic.
var renameRetrySleep = time.Sleep

// renameWithRetry retries a failing rename with jittered exponential backoff.
// Jitter keeps concurrent callers (the cert-renewal goroutine, the command
// worker pool, and heartbeat's own SetAndPersist/StagePendingCredentials
// calls can all reach a rename around the same time) from retrying against
// the same transient holder in lockstep.
func renameWithRetry(oldpath, newpath string) error {
	var err error
	for attempt := 0; attempt < renameAttempts; attempt++ {
		if attempt > 0 {
			backoff := renameBackoffBase << (attempt - 1)
			sleep := backoff + time.Duration(mathrand.Int63n(int64(backoff)+1))
			renameRetrySleep(sleep)
		}
		if err = renameFile(oldpath, newpath); err == nil {
			return nil
		}
	}
	return fmt.Errorf("rename %s to %s after %d attempts: %w", oldpath, newpath, renameAttempts, err)
}

// atomicWriteFile writes data to path durably: it creates path+".partial" in
// the same directory with perm requested at open time (still subject to umask
// on POSIX — defense-in-depth Chmod happens at the call site), writes data,
// fsyncs the file before close, then renames into place. Best-effort fsync
// on the directory inode follows the rename so the rename itself survives
// power loss on POSIX.
//
// The fsync is what guards against agent.yaml ending up zero-length or
// partially written after an unclean shutdown — kernel write-back can delay
// a dirty page well past when the in-place O_TRUNC write would have returned.
// Issue #642.
//
// Tradeoff vs the previous in-place write: on Windows, MoveFileEx fails with
// ERROR_ACCESS_DENIED if another process holds the destination open without
// FILE_SHARE_DELETE. SaveTo callers may now fail where the old O_TRUNC write
// would have succeeded — but failing loudly is preferable to silent power-loss
// corruption, and the next heartbeat retries.
func atomicWriteFile(path string, data []byte, perm os.FileMode) error {
	tmpPath := path + ".partial"
	// A prior crash mid-write may have left an old tmp behind; remove it so
	// the O_EXCL open below doesn't fail spuriously.
	_ = os.Remove(tmpPath)
	f, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL|os.O_TRUNC, perm)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(tmpPath)
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmpPath)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmpPath)
		return err
	}
	if err := renameWithRetry(tmpPath, path); err != nil {
		os.Remove(tmpPath)
		return err
	}
	// Best-effort directory fsync — durable on POSIX, no-ops or errors on
	// Windows. Log failures so a FS that's lost the ability to fsync metadata
	// (e.g. went read-only, ENOSPC on the inode table) doesn't silently
	// degrade durability across every SaveTo.
	dir := filepath.Dir(path)
	if d, err := os.Open(dir); err == nil {
		if err := d.Sync(); err != nil && runtime.GOOS != "windows" {
			log.Warn("config dir fsync failed", "dir", dir, "error", err.Error())
		}
		d.Close()
	} else if runtime.GOOS != "windows" {
		log.Warn("config dir open for fsync failed", "dir", dir, "error", err.Error())
	}
	return nil
}

// isSecretYAMLKey reports whether key should be kept out of agent.yaml (i.e.
// written only to secrets.yaml). It uses a suffix-based predicate so future
// secret keys like backup_s3_access_key are caught automatically without
// requiring an explicit list update.
//
// There are no exemptions. helper_auth_token in particular is a secret on
// every platform even though the Breeze Helper runs as the logged-in user:
// agent.yaml is readable by every local account, so the Helper gets the token
// over IPC (Windows: console-session Breeze Assist only) or from the
// breeze-group-scoped helper token file (Unix, helpertoken_unix.go). Because
// the rule is suffix-based, FixConfigPermissions' migration also scrubs a
// token an older agent left in agent.yaml.
func isSecretYAMLKey(key string) bool {
	switch key {
	case "auth_token", "watchdog_auth_token",
		"mtls_cert_pem", "mtls_key_pem", "mtls_cert_expires",
		"pending_mtls_certificate", "pending_mtls_private_key",
		"pending_mtls_certificate_id", "pending_mtls_expires_at":
		return true
	}
	return strings.HasSuffix(key, "_token") ||
		strings.HasSuffix(key, "_secret_key") ||
		strings.HasSuffix(key, "_access_key") ||
		strings.HasSuffix(key, "_secret") ||
		strings.HasSuffix(key, "_password")
}

func isSecretConfigKey(key string) bool {
	return isSecretYAMLKey(key)
}

// GetDataDir returns the platform-specific data directory for the agent
func GetDataDir() string {
	// A support session keeps its data (audit log, state stores, the
	// downloaded codec) inside its private folder (#7629).
	if root := registeredUserWorkspace(); root != "" {
		return filepath.Join(root, "data")
	}
	switch runtime.GOOS {
	case "windows":
		return filepath.Join(configDir(), "data")
	case "darwin":
		return "/Library/Application Support/Breeze/data"
	default:
		return "/var/lib/breeze"
	}
}

// FixConfigPermissions loosens the config directory and file permissions so
// the Breeze Helper (running as the logged-in user) can read the main config.
// The secrets file is kept root-only (0600).
// Safe to call on every startup — it is a no-op if permissions are already
// correct or the paths don't exist yet.
func FixConfigPermissions() {
	dir := fixConfigPermissionsDir()
	if info, err := os.Stat(dir); err == nil && info.IsDir() {
		if err := enforceConfigDirPermissions(dir); err != nil {
			log.Warn("Failed to fix config directory permissions", "dir", dir, "error", err.Error())
		}
	}
	cfgPath := filepath.Join(dir, "agent.yaml")
	removeStaleConfigScratchFiles(cfgPath)
	if _, err := os.Stat(cfgPath); err == nil {
		fixAgentYAMLPermissions(cfgPath)
	}
	// An agent started with --config elsewhere reads (and SetAndPersist
	// rewrites) that file instead; scrub it too, exactly as SetAndPersist's
	// own migration would on its first write there.
	if active := viper.ConfigFileUsed(); active != "" && !sameConfigPath(active, cfgPath) {
		if _, err := os.Stat(active); err == nil {
			removeStaleConfigScratchFiles(active)
			fixAgentYAMLPermissions(active)
		}
	}
	// Secrets file must remain root-only.
	sPath := secretsFilePath()
	if _, err := os.Stat(sPath); err == nil {
		if err := enforceSecretFilePermissions(sPath); err != nil {
			log.Warn("Failed to fix secrets file permissions", "path", sPath, "error", err.Error())
		}
	}
	seedHelperTokenFileFromSecretsIfMissing(cfgPath)
	reapplyHelperTokenFilePermissionsFor(cfgPath)
}

// fixConfigPermissionsDir is the default config directory FixConfigPermissions
// works on; a package var so tests can point it at a temp directory.
var fixConfigPermissionsDir = configDir

// fixAgentYAMLPermissions is the path-parameterized core of
// FixConfigPermissions' agent.yaml handling (split out so it can be tested
// against a temp directory instead of the real, OS-specific config
// directory). migrateInlineSecretsToSecretFile can fail partway through —
// e.g. a Windows rename blocked by a concurrent open of agent.yaml — and
// previously that error was only logged, after which the caller
// unconditionally loosened agent.yaml to the Helper-readable mode (0644 /
// BU:FR) regardless of whether inline secret material was still in it. This
// re-checks the file on disk after the migration attempt (success or not)
// and only loosens permissions when it is verifiably clear of secret keys;
// otherwise it locks the file down to the same restrictive mode as
// secrets.yaml until a later, successful migration can loosen it.
func fixAgentYAMLPermissions(cfgPath string) {
	if err := migrateInlineSecretsToSecretFile(cfgPath); err != nil {
		log.Error("Failed to migrate inline config secrets", "path", cfgPath, "error", err.Error())
	}
	hasInline, err := agentYAMLHasInlineSecrets(cfgPath)
	if err != nil {
		log.Warn("Failed to verify agent.yaml is clear of inline secrets; leaving it locked down", "path", cfgPath, "error", err.Error())
		hasInline = true
	}
	if hasInline {
		// Error, not Warn: until a later migration succeeds, the Helper cannot
		// read agent.yaml at all (no server URL or agent id for Breeze Assist).
		log.Error("agent.yaml still contains inline secret material after migration; leaving it locked down instead of widening its permissions", "path", cfgPath)
		if err := enforceSecretFilePermissions(cfgPath); err != nil {
			log.Warn("Failed to lock down config file permissions", "path", cfgPath, "error", err.Error())
		}
		return
	}
	if err := enforceConfigFilePermissions(cfgPath); err != nil {
		log.Warn("Failed to fix config file permissions", "path", cfgPath, "error", err.Error())
	}
}

// agentYAMLHasInlineSecrets reports whether cfgPath still contains any key
// that migrateInlineSecretsToSecretFile is meant to have moved out (see
// isSecretYAMLKey). A read or parse error is reported as "has secrets" (the
// caller fails closed) rather than silently treated as clean.
func agentYAMLHasInlineSecrets(cfgPath string) (bool, error) {
	data, err := os.ReadFile(cfgPath)
	if err != nil {
		return false, err
	}
	var cfgValues map[string]any
	if err := yaml.Unmarshal(data, &cfgValues); err != nil {
		return false, err
	}
	for key, value := range cfgValues {
		if isSecretYAMLKey(key) && !isEmptyYAMLValue(value) {
			return true, nil
		}
	}
	return false, nil
}

// seedHelperTokenFileFromSecretsIfMissing handles the upgrade case: an
// existing install's helper_auth_token was inline in agent.yaml, and the
// migration above (isSecretYAMLKey-driven, shared with every other secret
// key) has just moved it into secrets.yaml — the correct destination for
// every other secret, but not the group-readable one the Helper needs. If
// the dedicated helper token file doesn't exist yet, seed it from whatever
// secrets.yaml now holds. No-op on Windows (writeHelperTokenFile there is a
// no-op) and on a fresh install (SaveTo already writes the file directly, so
// it already exists by the time this runs).
func seedHelperTokenFileFromSecretsIfMissing(cfgPath string) {
	if _, err := os.Stat(helperTokenFilePathFor(cfgPath)); err == nil {
		return // already present — nothing to seed
	}
	creds, err := readPersistedCredentialsAt(cfgPath)
	if err != nil || creds == nil || creds.HelperAuthToken == "" {
		return
	}
	if err := writeHelperTokenFileFor(cfgPath, creds.HelperAuthToken); err != nil {
		log.Warn("failed to seed helper token file from secrets", "error", err.Error())
	}
}

func migrateInlineSecretsToSecretFile(cfgPath string) error {
	data, err := os.ReadFile(cfgPath)
	if err != nil {
		return err
	}

	var cfgValues map[string]any
	if err := yaml.Unmarshal(data, &cfgValues); err != nil {
		if legacyHelperTokenLine.Match(data) {
			recordHelperTokenRotationOwed(cfgPath)
		}
		return err
	}
	// Before anything below rewrites the file: a helper token an older agent
	// left here is rotated, not just moved (see helperTokenRotationMarkerName)
	// — unless a later rotation has already replaced it.
	if inline := cfgValues[secretKeyHelperAuthToken]; !isEmptyYAMLValue(inline) {
		if inlineHelperTokenStillValid(cfgPath, inline) {
			recordHelperTokenRotationOwed(cfgPath)
		} else {
			log.Info("helper token in agent.yaml was already replaced by a rotation; removing it without another rotation", "path", cfgPath)
		}
	}

	hasInlineSecretKeys := false
	for key := range cfgValues {
		if isSecretYAMLKey(key) {
			hasInlineSecretKeys = true
			break
		}
	}
	if !hasInlineSecretKeys {
		return nil
	}

	secretPath := secretsFilePathFor(cfgPath)
	secretValues := map[string]any{}
	secretFileExists := false
	if secretData, err := os.ReadFile(secretPath); err == nil {
		secretFileExists = true
		if err := yaml.Unmarshal(secretData, &secretValues); err != nil {
			return fmt.Errorf("reading existing secrets: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return err
	}

	for key := range cfgValues {
		if isSecretYAMLKey(key) {
			if isEmptyYAMLValue(secretValues[key]) && !isEmptyYAMLValue(cfgValues[key]) {
				secretValues[key] = cfgValues[key]
			}
			delete(cfgValues, key)
		}
	}

	if secretFileExists || len(secretValues) > 0 {
		if err := os.MkdirAll(filepath.Dir(secretPath), 0755); err != nil {
			return err
		}
		if err := enforceConfigDirPermissions(filepath.Dir(secretPath)); err != nil {
			return err
		}
		if err := writeYAMLFile(secretPath, secretValues, 0600); err != nil {
			return err
		}
		if err := enforceSecretFilePermissions(secretPath); err != nil {
			return err
		}
	}
	if err := writeYAMLFile(cfgPath, cfgValues, 0644); err != nil {
		return err
	}
	return enforceConfigFilePermissions(cfgPath)
}

func isEmptyYAMLValue(value any) bool {
	switch v := value.(type) {
	case nil:
		return true
	case string:
		return v == ""
	default:
		return false
	}
}

func writeYAMLFile(path string, values map[string]any, mode os.FileMode) error {
	data, err := yaml.Marshal(values)
	if err != nil {
		return err
	}
	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, data, mode); err != nil {
		return err
	}
	if err := os.Chmod(tmpPath, mode); err != nil {
		os.Remove(tmpPath)
		return err
	}
	if err := renameWithRetry(tmpPath, path); err != nil {
		os.Remove(tmpPath)
		return err
	}
	return os.Chmod(path, mode)
}

func secretsFilePath() string {
	return secretsFilePathFor(viper.ConfigFileUsed())
}

// readSecretsFile reads the secrets file at path into a new viper instance,
// or returns nil when it does not exist. The machine-wide secrets.yaml is
// read only through the trust check.
func readSecretsFile(path string) (*viper.Viper, error) {
	sv := viper.New()
	sv.SetConfigFile(path)
	sv.SetConfigType("yaml")
	if machineConfigFileNeedsTrust(path) {
		data, err := readTrustedMachineConfigFileFn(path)
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		if err := sv.ReadConfig(bytes.NewReader(data)); err != nil {
			return nil, fmt.Errorf("reading secrets file: %w", err)
		}
		return sv, nil
	}
	if _, err := os.Stat(path); err != nil {
		return nil, nil
	}
	if err := sv.ReadInConfig(); err != nil {
		return nil, fmt.Errorf("reading secrets file: %w", err)
	}
	return sv, nil
}

func secretsFilePathFor(cfgFile string) string {
	if cfgFile != "" {
		return filepath.Join(filepath.Dir(cfgFile), "secrets.yaml")
	}
	return filepath.Join(configDir(), "secrets.yaml")
}
