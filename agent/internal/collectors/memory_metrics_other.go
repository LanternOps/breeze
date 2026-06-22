//go:build !darwin

package collectors

func collectMemoryMetrics(metrics *SystemMetrics) {
	_ = collectGopsutilMemoryMetrics(metrics)
}
