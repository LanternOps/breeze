package collectors

import "github.com/shirou/gopsutil/v3/mem"

const bytesPerMiB = 1024 * 1024

func collectGopsutilMemoryMetrics(metrics *SystemMetrics) error {
	vmem, err := mem.VirtualMemory()
	if err != nil {
		return err
	}
	metrics.RAMPercent = vmem.UsedPercent
	metrics.RAMUsedMB = vmem.Used / bytesPerMiB
	return nil
}
