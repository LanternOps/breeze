package patching

import (
	"errors"
	"fmt"
	"strings"

	"go.uber.org/zap"
)

const patchIDSeparator = ":"

// PatchManager coordinates patch providers.
type PatchManager struct {
	providers     []PatchProvider
	providerIndex map[string]PatchProvider
	logger        *zap.Logger
}

// NewPatchManager creates a PatchManager with the given providers.
func NewPatchManager(logger *zap.Logger, providers ...PatchProvider) *PatchManager {
	index := make(map[string]PatchProvider, len(providers))
	for _, provider := range providers {
		index[provider.ID()] = provider
	}

	return &PatchManager{
		providers:     providers,
		providerIndex: index,
		logger:        logger,
	}
}

// Scan aggregates available patches from all providers.
func (m *PatchManager) Scan() ([]AvailablePatch, error) {
	var patches []AvailablePatch
	var errs []error

	for _, provider := range m.providers {
		providerPatches, err := provider.Scan()
		if err != nil {
			errs = append(errs, fmt.Errorf("%s scan failed: %w", provider.ID(), err))
			m.logWarn("Patch scan failed", zap.String("provider", provider.ID()), zap.Error(err))
			continue
		}

		patches = append(patches, m.decorateAvailable(provider.ID(), providerPatches)...)
	}

	if len(patches) == 0 && len(errs) > 0 {
		return nil, errors.Join(errs...)
	}

	return patches, errors.Join(errs...)
}

// Install installs a patch by ID.
func (m *PatchManager) Install(patchID string) (InstallResult, error) {
	providerID, localID, err := m.splitPatchID(patchID)
	if err != nil {
		return InstallResult{}, err
	}

	provider, ok := m.providerIndex[providerID]
	if !ok {
		return InstallResult{}, fmt.Errorf("unknown patch provider: %s", providerID)
	}

	result, err := provider.Install(localID)
	if err != nil {
		return InstallResult{}, err
	}

	if result.Provider == "" {
		result.Provider = providerID
	}
	if result.PatchID == "" {
		result.PatchID = m.formatPatchID(providerID, localID)
	} else if !strings.HasPrefix(result.PatchID, providerID+patchIDSeparator) {
		result.PatchID = m.formatPatchID(providerID, result.PatchID)
	}

	return result, nil
}

// Uninstall removes a patch by ID.
func (m *PatchManager) Uninstall(patchID string) error {
	providerID, localID, err := m.splitPatchID(patchID)
	if err != nil {
		return err
	}

	provider, ok := m.providerIndex[providerID]
	if !ok {
		return fmt.Errorf("unknown patch provider: %s", providerID)
	}

	return provider.Uninstall(localID)
}

// GetInstalled aggregates installed patches from all providers.
func (m *PatchManager) GetInstalled() ([]InstalledPatch, error) {
	var installed []InstalledPatch
	var errs []error

	for _, provider := range m.providers {
		providerInstalled, err := provider.GetInstalled()
		if err != nil {
			errs = append(errs, fmt.Errorf("%s installed scan failed: %w", provider.ID(), err))
			m.logWarn("Installed patch scan failed", zap.String("provider", provider.ID()), zap.Error(err))
			continue
		}

		installed = append(installed, m.decorateInstalled(provider.ID(), providerInstalled)...)
	}

	if len(installed) == 0 && len(errs) > 0 {
		return nil, errors.Join(errs...)
	}

	return installed, errors.Join(errs...)
}

func (m *PatchManager) splitPatchID(patchID string) (string, string, error) {
	if patchID == "" {
		return "", "", fmt.Errorf("patch ID is required")
	}

	if strings.Contains(patchID, patchIDSeparator) {
		parts := strings.SplitN(patchID, patchIDSeparator, 2)
		if len(parts) == 2 && parts[0] != "" && parts[1] != "" {
			return parts[0], parts[1], nil
		}
	}

	if len(m.providers) == 1 {
		return m.providers[0].ID(), patchID, nil
	}

	return "", "", fmt.Errorf("patch ID %q must be prefixed with provider ID", patchID)
}

func (m *PatchManager) decorateAvailable(providerID string, patches []AvailablePatch) []AvailablePatch {
	decorated := make([]AvailablePatch, 0, len(patches))
	for _, patch := range patches {
		patch.Provider = providerID
		patch.ID = m.formatPatchID(providerID, patch.ID)
		decorated = append(decorated, patch)
	}
	return decorated
}

func (m *PatchManager) decorateInstalled(providerID string, patches []InstalledPatch) []InstalledPatch {
	decorated := make([]InstalledPatch, 0, len(patches))
	for _, patch := range patches {
		patch.Provider = providerID
		patch.ID = m.formatPatchID(providerID, patch.ID)
		decorated = append(decorated, patch)
	}
	return decorated
}

func (m *PatchManager) formatPatchID(providerID, patchID string) string {
	if patchID == "" {
		return ""
	}
	if strings.HasPrefix(patchID, providerID+patchIDSeparator) {
		return patchID
	}
	return providerID + patchIDSeparator + patchID
}

func (m *PatchManager) logWarn(msg string, fields ...zap.Field) {
	if m.logger != nil {
		m.logger.Warn(msg, fields...)
	}
}
