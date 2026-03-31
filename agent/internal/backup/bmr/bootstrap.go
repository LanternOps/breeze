package bmr

import (
	"encoding/json"
	"fmt"
)

type authenticateEnvelope struct {
	Bootstrap json.RawMessage `json:"bootstrap"`
}

func decodeBootstrapResponse(data []byte) (*BootstrapResponse, error) {
	if bootstrap, err := decodeCanonicalBootstrap(data); err == nil {
		return bootstrap, nil
	}

	var legacy AuthenticateResponse
	if err := json.Unmarshal(data, &legacy); err != nil {
		return nil, fmt.Errorf("bmr: decode authenticate response: %w", err)
	}

	bootstrap := legacyBootstrapResponse(legacy)
	if err := validateBootstrapResponse(bootstrap); err != nil {
		return nil, err
	}
	return bootstrap, nil
}

func decodeCanonicalBootstrap(data []byte) (*BootstrapResponse, error) {
	var envelope authenticateEnvelope
	if err := json.Unmarshal(data, &envelope); err == nil && len(envelope.Bootstrap) > 0 && string(envelope.Bootstrap) != "null" {
		var bootstrap BootstrapResponse
		if err := json.Unmarshal(envelope.Bootstrap, &bootstrap); err != nil {
			return nil, fmt.Errorf("bmr: decode bootstrap response: %w", err)
		}
		if err := validateBootstrapResponse(&bootstrap); err != nil {
			return nil, err
		}
		return &bootstrap, nil
	}

	var bootstrap BootstrapResponse
	if err := json.Unmarshal(data, &bootstrap); err != nil {
		return nil, fmt.Errorf("bmr: decode bootstrap response: %w", err)
	}
	if bootstrap.Version == 0 {
		return nil, fmt.Errorf("bootstrap version missing")
	}
	if err := validateBootstrapResponse(&bootstrap); err != nil {
		return nil, err
	}
	return &bootstrap, nil
}

func legacyBootstrapResponse(legacy AuthenticateResponse) *BootstrapResponse {
	version := BootstrapResponseVersion
	return &BootstrapResponse{
		Version:         version,
		TokenID:         legacy.TokenID,
		DeviceID:        legacy.DeviceID,
		SnapshotID:      legacy.SnapshotID,
		RestoreType:     legacy.RestoreType,
		TargetConfig:    legacy.TargetConfig,
		Device:          legacy.Device,
		Snapshot:        legacy.Snapshot,
		BackupConfig:    legacy.BackupConfig,
		Download:        legacy.Download,
		AuthenticatedAt: legacy.AuthenticatedAt,
	}
}

func validateBootstrapResponse(bootstrap *BootstrapResponse) error {
	if bootstrap == nil {
		return fmt.Errorf("bmr: authenticate response missing bootstrap")
	}
	if bootstrap.Version <= 0 {
		return fmt.Errorf("bmr: authenticate response missing bootstrap version")
	}
	if len(bootstrap.TargetConfig) == 0 && bootstrap.BackupConfig == nil && bootstrap.Download == nil {
		return fmt.Errorf("bmr: authenticate response missing recovery access details")
	}
	if bootstrap.Snapshot == nil || bootstrap.Snapshot.SnapshotID == "" {
		return fmt.Errorf("bmr: authenticate response missing provider snapshot identifier")
	}
	if bootstrap.Download != nil {
		if bootstrap.Download.URL == "" {
			return fmt.Errorf("bmr: authenticate response missing download url")
		}
		if bootstrap.Download.PathPrefix == "" {
			return fmt.Errorf("bmr: authenticate response missing download path prefix")
		}
	}
	return nil
}
