//go:build windows

package mgmtdetect

import (
	"golang.org/x/sys/windows/registry"
)

func collectPolicyDetections() []Detection {
	var detections []Detection

	key, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`SOFTWARE\Microsoft\Windows\CurrentVersion\Group Policy\History`,
		registry.READ)
	if err == nil {
		subkeys, readErr := key.ReadSubKeyNames(-1)
		key.Close()
		if readErr != nil {
			log.Warn("failed to read Group Policy subkeys", "error", readErr)
		}
		if len(subkeys) > 0 {
			detections = append(detections, Detection{
				Name:   "Group Policy",
				Status: StatusActive,
				Details: map[string]any{
					"gpoCount": len(subkeys),
				},
			})
		}
	}

	ccmKey, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\CCM`, registry.READ)
	if err == nil {
		ccmKey.Close()
		detections = append(detections, Detection{
			Name:   "SCCM/MECM",
			Status: StatusActive,
		})
	}

	return detections
}
