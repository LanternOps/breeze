package patching

import (
	"errors"
	"fmt"
	"strings"
)

const patchIDSeparator = ":"

// PatchManager coordinates patch providers.
type PatchManager struct {
	providers     []PatchProvider
	providerIndex map[string]PatchProvider
}

// NewPatchManager creates a PatchManager with the given providers.
func NewPatchManager(providers ...PatchProvider) *PatchManager {
	index := make(map[string]PatchProvider, len(providers))
	for _, provider := range providers {
		index[provider.ID()] = provider
	}

	return &PatchManager{
		providers:     providers,
		providerIndex: index,
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

// GetProvider returns a provider by ID.
func (m *PatchManager) GetProvider(providerID string) (PatchProvider, bool) {
	p, ok := m.providerIndex[providerID]
	return p, ok
}

// DownloadPatches downloads patches by their composite IDs, using DownloadableProvider
// if the underlying provider supports it.
func (m *PatchManager) DownloadPatches(patchIDs []string, progress ProgressCallback) ([]DownloadResult, error) {
	// Group patches by provider
	groups := make(map[string][]string)
	for _, patchID := range patchIDs {
		providerID, localID, err := m.splitPatchID(patchID)
		if err != nil {
			return nil, err
		}
		groups[providerID] = append(groups[providerID], localID)
	}

	var results []DownloadResult
	for providerID, localIDs := range groups {
		provider, ok := m.providerIndex[providerID]
		if !ok {
			for _, id := range localIDs {
				results = append(results, DownloadResult{
					PatchID: m.formatPatchID(providerID, id),
					Success: false,
					Message: fmt.Sprintf("unknown provider: %s", providerID),
				})
			}
			continue
		}

		downloadable, ok := provider.(DownloadableProvider)
		if !ok {
			for _, id := range localIDs {
				results = append(results, DownloadResult{
					PatchID: m.formatPatchID(providerID, id),
					Success: false,
					Message: fmt.Sprintf("provider %s does not support download", providerID),
				})
			}
			continue
		}

		providerResults, err := downloadable.Download(localIDs, progress)
		if err != nil {
			for _, id := range localIDs {
				results = append(results, DownloadResult{
					PatchID: m.formatPatchID(providerID, id),
					Success: false,
					Message: err.Error(),
				})
			}
			continue
		}

		// Decorate results with full patch IDs
		for _, r := range providerResults {
			r.PatchID = m.formatPatchID(providerID, r.PatchID)
			results = append(results, r)
		}
	}

	return results, nil
}

// ProviderIDs returns the registered provider IDs in order.
func (m *PatchManager) ProviderIDs() []string {
	ids := make([]string, 0, len(m.providers))
	for _, provider := range m.providers {
		ids = append(ids, provider.ID())
	}
	return ids
}

// HasProvider reports whether the provider is registered.
func (m *PatchManager) HasProvider(providerID string) bool {
	_, ok := m.providerIndex[providerID]
	return ok
}

// DefaultProviderID returns the first registered provider ID.
func (m *PatchManager) DefaultProviderID() string {
	if len(m.providers) == 0 {
		return ""
	}
	return m.providers[0].ID()
}
