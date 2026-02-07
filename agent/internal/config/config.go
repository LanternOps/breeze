package config

import (
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
}

func Default() *Config {
	return &Config{
		HeartbeatIntervalSeconds: 60,
		MetricsIntervalSeconds:   30,
		EnabledCollectors:        []string{"hardware", "software", "metrics", "network"},
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
