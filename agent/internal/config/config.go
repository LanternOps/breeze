package config

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"github.com/spf13/viper"
)

type Config struct {
	AgentID                  string   `mapstructure:"agent_id"`
	ServerURL                string   `mapstructure:"server_url"`
	AuthToken                string   `mapstructure:"auth_token"`
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

	// Logging configuration
	LogLevel      string `mapstructure:"log_level"`
	LogFormat     string `mapstructure:"log_format"`
	LogFile       string `mapstructure:"log_file"`
	LogMaxSizeMB  int    `mapstructure:"log_max_size_mb"`
	LogMaxBackups int    `mapstructure:"log_max_backups"`

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
}

func Default() *Config {
	return &Config{
		HeartbeatIntervalSeconds: 60,
		MetricsIntervalSeconds:   30,
		EnabledCollectors:        []string{"hardware", "software", "metrics", "network"},
		LogLevel:                 "info",
		LogFormat:                "text",
		LogMaxSizeMB:             50,
		LogMaxBackups:            3,
		MaxConcurrentCommands:    10,
		CommandQueueSize:         100,
		AuditEnabled:             true,
		AuditMaxSizeMB:           50,
		AuditMaxBackups:          3,

		PatchExcludeFeatureUpdates: true,
		PatchMinDiskSpaceGB:        2.0,
		PatchRequireACPower:        true,
		PatchRebootMaxPerDay:       3,
		PatchAutoAcceptEula:        true,
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

func Save(cfg *Config) error {
	return SaveTo(cfg, "")
}

func SaveTo(cfg *Config, cfgFile string) error {
	viper.Set("agent_id", cfg.AgentID)
	viper.Set("server_url", cfg.ServerURL)
	viper.Set("auth_token", cfg.AuthToken)
	viper.Set("org_id", cfg.OrgID)
	viper.Set("site_id", cfg.SiteID)
	viper.Set("heartbeat_interval_seconds", cfg.HeartbeatIntervalSeconds)
	viper.Set("metrics_interval_seconds", cfg.MetricsIntervalSeconds)
	viper.Set("enabled_collectors", cfg.EnabledCollectors)

	var cfgPath string
	if cfgFile != "" {
		cfgPath = cfgFile
		dir := filepath.Dir(cfgPath)
		if dir != "." {
			if err := os.MkdirAll(dir, 0700); err != nil {
				return err
			}
		}
	} else {
		cfgPath = filepath.Join(configDir(), "agent.yaml")
		if err := os.MkdirAll(configDir(), 0700); err != nil {
			return err
		}
	}

	if err := viper.WriteConfigAs(cfgPath); err != nil {
		return err
	}

	// Restrict config file to owner-only access (contains auth token)
	return os.Chmod(cfgPath, 0600)
}

// GetDataDir returns the platform-specific data directory for the agent
func GetDataDir() string {
	switch runtime.GOOS {
	case "windows":
		return filepath.Join(os.Getenv("ProgramData"), "Breeze", "data")
	case "darwin":
		return "/Library/Application Support/Breeze/data"
	default:
		return "/var/lib/breeze"
	}
}

func configDir() string {
	switch runtime.GOOS {
	case "windows":
		return filepath.Join(os.Getenv("ProgramData"), "Breeze")
	case "darwin":
		return "/Library/Application Support/Breeze"
	default:
		return "/etc/breeze"
	}
}
