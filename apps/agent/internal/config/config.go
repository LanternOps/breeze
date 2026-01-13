package config

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/spf13/viper"
)

// Config holds all agent configuration
type Config struct {
	// Server connection
	ServerURL string `mapstructure:"server_url"`
	APIKey    string `mapstructure:"api_key"`

	// Device identification
	DeviceID   string `mapstructure:"device_id"`
	DeviceName string `mapstructure:"device_name"`

	// Organization context
	OrgID  string `mapstructure:"org_id"`
	SiteID string `mapstructure:"site_id"`

	// Intervals
	HeartbeatInterval time.Duration `mapstructure:"heartbeat_interval"`
	MetricsInterval   time.Duration `mapstructure:"metrics_interval"`
	InventoryInterval time.Duration `mapstructure:"inventory_interval"`

	// Features
	EnableMetrics   bool `mapstructure:"enable_metrics"`
	EnableInventory bool `mapstructure:"enable_inventory"`
	EnableRemote    bool `mapstructure:"enable_remote"`

	// Logging
	LogLevel string `mapstructure:"log_level"`
	LogFile  string `mapstructure:"log_file"`

	// TLS
	InsecureSkipVerify bool   `mapstructure:"insecure_skip_verify"`
	CACertPath         string `mapstructure:"ca_cert_path"`
}

// DefaultConfig returns configuration with sensible defaults
func DefaultConfig() *Config {
	return &Config{
		ServerURL:         "https://localhost:3001",
		HeartbeatInterval: 60 * time.Second,
		MetricsInterval:   30 * time.Second,
		InventoryInterval: 6 * time.Hour,
		EnableMetrics:     true,
		EnableInventory:   true,
		EnableRemote:      true,
		LogLevel:          "info",
	}
}

// Load reads configuration from file and environment
func Load() (*Config, error) {
	cfg := DefaultConfig()

	// Set config file locations
	viper.SetConfigName("breeze-agent")
	viper.SetConfigType("yaml")
	viper.AddConfigPath(getConfigDir())
	viper.AddConfigPath(".")

	// Environment variable support
	viper.SetEnvPrefix("BREEZE")
	viper.AutomaticEnv()

	// Read config file (ignore if not found)
	if err := viper.ReadInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			return nil, fmt.Errorf("error reading config: %w", err)
		}
	}

	// Unmarshal into struct
	if err := viper.Unmarshal(cfg); err != nil {
		return nil, fmt.Errorf("error unmarshaling config: %w", err)
	}

	return cfg, nil
}

// Save writes the current configuration to disk
func (c *Config) Save() error {
	configDir := getConfigDir()
	if err := os.MkdirAll(configDir, 0755); err != nil {
		return fmt.Errorf("failed to create config dir: %w", err)
	}

	configPath := filepath.Join(configDir, "breeze-agent.yaml")

	viper.Set("server_url", c.ServerURL)
	viper.Set("api_key", c.APIKey)
	viper.Set("device_id", c.DeviceID)
	viper.Set("device_name", c.DeviceName)
	viper.Set("org_id", c.OrgID)
	viper.Set("site_id", c.SiteID)
	viper.Set("heartbeat_interval", c.HeartbeatInterval)
	viper.Set("metrics_interval", c.MetricsInterval)
	viper.Set("inventory_interval", c.InventoryInterval)
	viper.Set("enable_metrics", c.EnableMetrics)
	viper.Set("enable_inventory", c.EnableInventory)
	viper.Set("enable_remote", c.EnableRemote)
	viper.Set("log_level", c.LogLevel)
	viper.Set("log_file", c.LogFile)
	viper.Set("insecure_skip_verify", c.InsecureSkipVerify)
	viper.Set("ca_cert_path", c.CACertPath)

	return viper.WriteConfigAs(configPath)
}

// getConfigDir returns the platform-specific config directory
func getConfigDir() string {
	switch runtime.GOOS {
	case "windows":
		return filepath.Join(os.Getenv("ProgramData"), "Breeze", "Agent")
	case "darwin":
		return "/Library/Application Support/Breeze/Agent"
	default: // Linux and others
		return "/etc/breeze-agent"
	}
}

// GetDataDir returns the platform-specific data directory
func GetDataDir() string {
	switch runtime.GOOS {
	case "windows":
		return filepath.Join(os.Getenv("ProgramData"), "Breeze", "Agent", "data")
	case "darwin":
		return "/Library/Application Support/Breeze/Agent/data"
	default:
		return "/var/lib/breeze-agent"
	}
}

// GetLogDir returns the platform-specific log directory
func GetLogDir() string {
	switch runtime.GOOS {
	case "windows":
		return filepath.Join(os.Getenv("ProgramData"), "Breeze", "Agent", "logs")
	case "darwin":
		return "/Library/Logs/Breeze"
	default:
		return "/var/log/breeze-agent"
	}
}
