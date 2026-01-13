// Package collector provides system information collection capabilities
// for the Breeze agent. It includes collectors for hardware info,
// real-time metrics, and software inventory.
package collector

import (
	"go.uber.org/zap"
)

// Collector is the interface that all system collectors must implement.
// Each collector is responsible for gathering a specific type of system
// information and returning it in a structured format.
type Collector interface {
	// Collect gathers the system information and returns it.
	// The returned interface{} should be type-asserted to the appropriate
	// model type (e.g., models.HardwareInfo, models.Metrics, []models.SoftwareInfo).
	// Returns an error if collection fails completely; partial failures
	// may still return data with logged warnings.
	Collect() (interface{}, error)

	// Name returns a human-readable name for the collector,
	// useful for logging and identification.
	Name() string
}

// BaseCollector provides common functionality for all collectors
type BaseCollector struct {
	logger *zap.Logger
}

// NewBaseCollector creates a new BaseCollector with the given logger
func NewBaseCollector(logger *zap.Logger) BaseCollector {
	if logger == nil {
		logger, _ = zap.NewProduction()
	}
	return BaseCollector{logger: logger}
}

// Logger returns the collector's logger
func (b *BaseCollector) Logger() *zap.Logger {
	return b.logger
}

// LogWarning logs a warning message for partial failures during collection
func (b *BaseCollector) LogWarning(msg string, fields ...zap.Field) {
	b.logger.Warn(msg, fields...)
}

// LogError logs an error message
func (b *BaseCollector) LogError(msg string, fields ...zap.Field) {
	b.logger.Error(msg, fields...)
}

// LogDebug logs a debug message
func (b *BaseCollector) LogDebug(msg string, fields ...zap.Field) {
	b.logger.Debug(msg, fields...)
}
