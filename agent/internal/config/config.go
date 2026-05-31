package config

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
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
	StandbyTimeout          time.Duration `mapstructure:"standby_timeout" yaml:"standby_timeout"`
	FailoverPollInterval    time.Duration `mapstructure:"failover_poll_interval" yaml:"failover_poll_interval"`
	HealthJournalMaxSizeMB  int           `mapstructure:"health_journal_max_size_mb" yaml:"health_journal_max_size_mb"`
	HealthJournalMaxFiles   int           `mapstructure:"health_journal_max_files" yaml:"health_journal_max_files"`
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
	AgentID                  string   `mapstructure:"agent_id"`
	ServerURL                string   `mapstructure:"server_url"`
	AuthToken                string   `mapstructure:"auth_token"`
	WatchdogAuthToken        string   `mapstructure:"watchdog_auth_token"`
	HelperAuthToken          string   `mapstructure:"helper_auth_token"`
	OrgID                    string   `mapstructure:"org_id"`
	SiteID                   string   `mapstructure:"site_id"`
	HeartbeatIntervalSeconds int      `mapstructure:"heartbeat_interval_seconds"`
	MetricsIntervalSeconds   int      `mapstructure:"metrics_interval_seconds"`
	EnabledCollectors        []string `mapstructure:"enabled_collectors"`
	BackupEnabled            bool     `mapstructure:"backup_enabled"`
	BackupPaths              []string `mapstructure:"backup_paths"`
	BackupSchedule           string   `mapstructure:"backup_schedule"`
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

	// mTLS client certificate (Cloudflare API Shield)
	MtlsCertPEM     string `mapstructure:"mtls_cert_pem"`
	MtlsKeyPEM      string `mapstructure:"mtls_key_pem"`
	MtlsCertExpires string `mapstructure:"mtls_cert_expires"`

	// Watchdog configuration for the breeze-watchdog service.
	Watchdog WatchdogConfig `mapstructure:"watchdog" yaml:"watchdog"`

	// IsService is a runtime flag set when the agent is running as a system service
	// (Windows SCM, macOS launchd, Linux systemd). It is not persisted to config.
	IsService bool `mapstructure:"-"`

	// IsHeadless is a runtime flag set when no console/TTY is attached (launchd
	// daemon, systemd service, etc.). Desktop commands route through IPC when set.
	IsHeadless bool `mapstructure:"-"`
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

func Default() *Config {
	return &Config{
		HeartbeatIntervalSeconds: 60,
		MetricsIntervalSeconds:   30,
		EnabledCollectors:        []string{"hardware", "software", "metrics", "network"},
		LogLevel:                 "info",
		LogFormat:                "text",
		LogFile:                  defaultLogFile(),
		LogMaxSizeMB:             50,
		LogMaxBackups:            3,
		LogShippingLevel:         "warn",
		MaxConcurrentCommands:    10,
		CommandQueueSize:         100,
		AuditEnabled:             true,
		AuditMaxSizeMB:           50,
		AuditMaxBackups:          3,

		AutoUpdate:                 true,
		PatchExcludeFeatureUpdates: true,
		PatchMinDiskSpaceGB:        2.0,
		PatchRequireACPower:        true,
		PatchRebootMaxPerDay:       3,
		PatchAutoAcceptEula:        false,
		PolicyRegistryStateProbes:  []PolicyRegistryStateProbe{},
		PolicyConfigStateProbes:    []PolicyConfigStateProbe{},

		Watchdog: WatchdogConfig{
			Enabled:                    true,
			ProcessCheckInterval:       5 * time.Second,
			IPCProbeInterval:           30 * time.Second,
			HeartbeatStaleThreshold:    3 * time.Minute,
			MaxRecoveryAttempts:        3,
			RecoveryCooldown:           10 * time.Minute,
			StandbyTimeout:             30 * time.Minute,
			FailoverPollInterval:       30 * time.Second,
			HealthJournalMaxSizeMB:     10,
			HealthJournalMaxFiles:      3,
			RestartVerificationGrace:   30 * time.Second,
			RestartVerificationTimeout: 120 * time.Second,
			MaxRestartsPer24h:          5,
		},
	}
}

func Load(cfgFile string) (*Config, error) {
	cfg := Default()

	if cfgFile != "" {
		viper.SetConfigFile(cfgFile)
	} else {
		viper.SetConfigName("agent")
		viper.SetConfigType("yaml")
		viper.AddConfigPath(configDir())
		viper.AddConfigPath(".")
	}

	viper.AutomaticEnv()
	viper.SetEnvPrefix("BREEZE")

	if err := viper.ReadInConfig(); err != nil {
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
	if _, err := os.Stat(secretsPath); err == nil {
		sv := viper.New()
		sv.SetConfigFile(secretsPath)
		if err := sv.ReadInConfig(); err != nil {
			return nil, fmt.Errorf("reading secrets file: %w", err)
		}
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
		if v := sv.GetString("mtls_cert_pem"); v != "" {
			cfg.MtlsCertPEM = v
		}
		if v := sv.GetString("mtls_key_pem"); v != "" {
			cfg.MtlsKeyPEM = v
		}
		if v := sv.GetString("mtls_cert_expires"); v != "" {
			cfg.MtlsCertExpires = v
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

// SetAndPersist updates a single non-secret config key in viper and writes it
// to the existing config file. Any legacy inline secrets are migrated to
// secrets.yaml and scrubbed from agent.yaml after the write.
func SetAndPersist(key string, value any) error {
	if isSecretConfigKey(key) {
		if err := SetSecretAndPersist(key, value); err != nil {
			return err
		}
		viper.Set(key, nil)
	} else {
		viper.Set(key, value)
	}
	if err := viper.WriteConfig(); err != nil {
		return err
	}
	if path := viper.ConfigFileUsed(); path != "" {
		if err := migrateInlineSecretsToSecretFile(path); err != nil {
			return err
		}
		return enforceConfigFilePermissions(path)
	}
	return nil
}

func SetSecretAndPersist(key string, value any) error {
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
	sv.Set(key, value)

	ext := filepath.Ext(path)
	tmpPath := path[:len(path)-len(ext)] + ".tmp" + ext
	if err := sv.WriteConfigAs(tmpPath); err != nil {
		return err
	}
	sf, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		os.Remove(tmpPath)
		return err
	}
	data, err := os.ReadFile(tmpPath)
	if err != nil {
		sf.Close()
		os.Remove(tmpPath)
		return err
	}
	if _, err := sf.Write(data); err != nil {
		sf.Close()
		os.Remove(tmpPath)
		return err
	}
	if err := sf.Close(); err != nil {
		os.Remove(tmpPath)
		return err
	}
	os.Remove(tmpPath)
	return enforceSecretFilePermissions(path)
}

// Reload reloads the currently bound config file, or the default config path
// when no explicit file has been loaded yet.
func Reload() (*Config, error) {
	return Load(viper.ConfigFileUsed())
}

func Save(cfg *Config) error {
	return SaveTo(cfg, "")
}

func SaveTo(cfg *Config, cfgFile string) error {
	viper.Set("agent_id", cfg.AgentID)
	viper.Set("server_url", cfg.ServerURL)
	viper.Set("org_id", cfg.OrgID)
	viper.Set("site_id", cfg.SiteID)
	viper.Set("heartbeat_interval_seconds", cfg.HeartbeatIntervalSeconds)
	viper.Set("metrics_interval_seconds", cfg.MetricsIntervalSeconds)
	viper.Set("enabled_collectors", cfg.EnabledCollectors)
	viper.Set("policy_registry_state_probes", cfg.PolicyRegistryStateProbes)
	viper.Set("policy_config_state_probes", cfg.PolicyConfigStateProbes)
	viper.Set("log_level", cfg.LogLevel)
	viper.Set("log_shipping_level", cfg.LogShippingLevel)
	viper.Set("auto_update", cfg.AutoUpdate)
	viper.Set("allow_dev_update", cfg.AllowDevUpdate)
	viper.Set("pinned_manifest_pub_keys", cfg.PinnedManifestPubKeys)
	// Write only the helper-scoped token to agent.yaml. Full agent and watchdog
	// bearer tokens are persisted below in root-only secrets.yaml.
	if cfg.HelperAuthToken != "" {
		viper.Set("helper_auth_token", cfg.HelperAuthToken)
	}

	var cfgPath string
	if cfgFile != "" {
		cfgPath = cfgFile
		dir := filepath.Dir(cfgPath)
		if dir != "." {
			if err := os.MkdirAll(dir, 0755); err != nil {
				return err
			}
			if err := enforceConfigDirPermissions(dir); err != nil {
				return err
			}
		}
	} else {
		cfgPath = filepath.Join(configDir(), "agent.yaml")
		if err := os.MkdirAll(configDir(), 0755); err != nil {
			return err
		}
		if err := enforceConfigDirPermissions(configDir()); err != nil {
			return err
		}
	}

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
	// logged-in user, can read it. It carries only the helper-scoped token;
	// full tokens and mTLS keys are written to root-only secrets.yaml below.
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
	// Only overwrite auth_token if non-empty. At runtime the token may be
	// cleared from the config struct for security; writing "" would wipe
	// the persisted token and break the agent on next startup.
	if cfg.AuthToken != "" {
		sv.Set("auth_token", cfg.AuthToken)
	}
	if cfg.WatchdogAuthToken != "" {
		sv.Set("watchdog_auth_token", cfg.WatchdogAuthToken)
	}
	if cfg.HelperAuthToken != "" {
		sv.Set("helper_auth_token", cfg.HelperAuthToken)
	}
	sv.Set("mtls_cert_pem", cfg.MtlsCertPEM)
	sv.Set("mtls_key_pem", cfg.MtlsKeyPEM)
	sv.Set("mtls_cert_expires", cfg.MtlsCertExpires)
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
	if err := os.Rename(tmpPath, path); err != nil {
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

// secretKeyAllowedInAgentYAML lists keys that look secret by suffix rules but
// must remain in agent.yaml. The Breeze Helper ("Breeze Assist") runs as the
// logged-in user and reads agent.yaml directly; it needs helper_auth_token.
var secretKeyAllowedInAgentYAML = map[string]bool{
	"helper_auth_token": true,
}

// isSecretYAMLKey reports whether key should be kept out of agent.yaml (i.e.
// written only to secrets.yaml). It uses a suffix-based predicate so future
// secret keys like backup_s3_access_key are caught automatically without
// requiring an explicit list update. Keys in secretKeyAllowedInAgentYAML are
// explicitly exempted regardless of suffix.
func isSecretYAMLKey(key string) bool {
	if secretKeyAllowedInAgentYAML[key] {
		return false
	}
	switch key {
	case "auth_token", "watchdog_auth_token",
		"mtls_cert_pem", "mtls_key_pem", "mtls_cert_expires":
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
	dir := configDir()
	if info, err := os.Stat(dir); err == nil && info.IsDir() {
		if err := enforceConfigDirPermissions(dir); err != nil {
			log.Warn("Failed to fix config directory permissions", "dir", dir, "error", err.Error())
		}
	}
	cfgPath := filepath.Join(dir, "agent.yaml")
	if _, err := os.Stat(cfgPath); err == nil {
		if err := migrateInlineSecretsToSecretFile(cfgPath); err != nil {
			log.Warn("Failed to migrate inline config secrets", "path", cfgPath, "error", err.Error())
		}
		if err := enforceConfigFilePermissions(cfgPath); err != nil {
			log.Warn("Failed to fix config file permissions", "path", cfgPath, "error", err.Error())
		}
	}
	// Secrets file must remain root-only.
	sPath := secretsFilePath()
	if _, err := os.Stat(sPath); err == nil {
		if err := enforceSecretFilePermissions(sPath); err != nil {
			log.Warn("Failed to fix secrets file permissions", "path", sPath, "error", err.Error())
		}
	}
}

func migrateInlineSecretsToSecretFile(cfgPath string) error {
	data, err := os.ReadFile(cfgPath)
	if err != nil {
		return err
	}

	var cfgValues map[string]any
	if err := yaml.Unmarshal(data, &cfgValues); err != nil {
		return err
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
	if err := os.Rename(tmpPath, path); err != nil {
		os.Remove(tmpPath)
		return err
	}
	return os.Chmod(path, mode)
}

func secretsFilePath() string {
	return secretsFilePathFor(viper.ConfigFileUsed())
}

func secretsFilePathFor(cfgFile string) string {
	if cfgFile != "" {
		return filepath.Join(filepath.Dir(cfgFile), "secrets.yaml")
	}
	return filepath.Join(configDir(), "secrets.yaml")
}
