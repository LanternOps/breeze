package heartbeat

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/patching"
)

type heartbeatMockProvider struct {
	id           string
	installErr   error
	uninstallErr error
	installIDs   []string
	uninstallIDs []string
}

func (p *heartbeatMockProvider) ID() string { return p.id }

func (p *heartbeatMockProvider) Name() string { return p.id }

func (p *heartbeatMockProvider) Scan() ([]patching.AvailablePatch, error) {
	return []patching.AvailablePatch{}, nil
}

func (p *heartbeatMockProvider) Install(patchID string) (patching.InstallResult, error) {
	p.installIDs = append(p.installIDs, patchID)
	if p.installErr != nil {
		return patching.InstallResult{}, p.installErr
	}
	return patching.InstallResult{PatchID: patchID, Provider: p.id, Message: "ok"}, nil
}

func (p *heartbeatMockProvider) Uninstall(patchID string) error {
	p.uninstallIDs = append(p.uninstallIDs, patchID)
	return p.uninstallErr
}

func (p *heartbeatMockProvider) GetInstalled() ([]patching.InstalledPatch, error) {
	return []patching.InstalledPatch{}, nil
}

func TestPatchRefsFromPayloadDeduplicatesEntries(t *testing.T) {
	h := &Heartbeat{}

	payload := map[string]any{
		"patches": []any{
			map[string]any{"id": "patch-a", "source": "linux", "externalId": "apt:openssl"},
			map[string]any{"id": "patch-a", "source": "linux", "externalId": "apt:openssl"},
		},
		"patchIds": []any{"patch-a", "patch-b", "patch-b"},
	}

	refs := h.patchRefsFromPayload(payload)
	// patch-a appears in both patches and patchIds arrays but is correctly
	// deduplicated by ID. Expected: patch-a (from patches) + patch-b (from patchIds).
	if len(refs) != 2 {
		t.Fatalf("expected 2 unique refs (cross-array dedup), got %d", len(refs))
	}
	// The ref from the patches array should be preserved with richer metadata
	if refs[0].Source != "linux" {
		t.Errorf("expected first ref source=linux, got %q", refs[0].Source)
	}
}

func TestResolvePatchInstallIDUsesScopedIDWhenProvided(t *testing.T) {
	h := &Heartbeat{patchMgr: patching.NewPatchManager(&heartbeatMockProvider{id: "apt"})}

	installID, err := h.resolvePatchInstallID(patchCommandRef{ID: "apt:openssl"})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if installID != "apt:openssl" {
		t.Fatalf("expected apt:openssl, got %s", installID)
	}
}

func TestResolvePatchInstallIDMapsLinuxSourceToApt(t *testing.T) {
	h := &Heartbeat{patchMgr: patching.NewPatchManager(&heartbeatMockProvider{id: "apt"}, &heartbeatMockProvider{id: "yum"})}

	installID, err := h.resolvePatchInstallID(patchCommandRef{
		ID:         "platform-patch-id",
		Source:     "linux",
		ExternalID: "openssl",
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if installID != "apt:openssl" {
		t.Fatalf("expected apt:openssl, got %s", installID)
	}
}

func TestResolvePatchInstallIDUsesPackageIDForVersionedLinuxExternalID(t *testing.T) {
	h := &Heartbeat{patchMgr: patching.NewPatchManager(&heartbeatMockProvider{id: "apt"})}

	installID, err := h.resolvePatchInstallID(patchCommandRef{
		ID:         "platform-patch-id",
		Source:     "linux",
		ExternalID: "apt:openssl@3.0.2-0ubuntu1.20",
		PackageID:  "apt:openssl",
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if installID != "apt:openssl" {
		t.Fatalf("expected apt:openssl, got %s", installID)
	}
}

// A Windows Update install must be selected by the identity THIS device
// observed (patchCommandRef.ExternalID), never by the globally deduplicated
// catalog selector (patchCommandRef.PackageID), which the API fills once from
// whichever device created the row first — possibly in another tenant.
//
// Cases marked "discriminator" fail against the unfixed resolver, which took
// PackageID first via patchLocalID. Cases marked "over-reach guard" already
// passed before the fix; they are here to prove the new Windows-Update branch
// does not capture refs that belong to another provider or shape.
func TestResolvePatchInstallIDUsesDeviceObservedKBForWindowsUpdate(t *testing.T) {
	tests := []struct {
		name       string
		providers  []string
		externalID string
		packageID  string
		want       string
	}{
		{
			// discriminator
			name:       "global selector from another device cannot override KB",
			externalID: "KB5034441",
			packageID:  "windows-update:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			want:       "windows-update:KB5034441",
		},
		{
			// discriminator: driver and feature updates expose no KBArticleIDs,
			// so the agent reports the raw WUA UpdateID as externalId. The KB
			// guard does not fire for those, and the poisoned catalog selector
			// used to win.
			name:       "KB-less driver update resolves the observed UpdateID, not the catalog selector",
			externalID: "aaaaaaaa-1111-2222-3333-444444444444",
			packageID:  "windows-update:99999999-9999-9999-9999-999999999999",
			want:       "windows-update:aaaaaaaa-1111-2222-3333-444444444444",
		},
		{
			// discriminator: a source-qualified externalId is still the
			// device-observed identity.
			name:       "source-qualified KB is not diverted by the catalog selector",
			externalID: "microsoft:KB5034441",
			packageID:  "windows-update:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			want:       "windows-update:KB5034441",
		},
		{
			// over-reach guard (passed before the fix too)
			name:       "qualified update without KB remains exact",
			externalID: "windows-update:11111111-2222-3333-4444-555555555555",
			packageID:  "windows-update:11111111-2222-3333-4444-555555555555",
			want:       "windows-update:11111111-2222-3333-4444-555555555555",
		},
		{
			// over-reach guard: a Microsoft-source row whose external identity
			// is qualified for a real, present package manager must keep its
			// own provider routing.
			name:       "externalId qualified for another provider keeps that provider",
			providers:  []string{"windows-update", "chocolatey"},
			externalID: "chocolatey:googlechrome",
			packageID:  "chocolatey:googlechrome",
			want:       "chocolatey:googlechrome",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			providerIDs := tt.providers
			if providerIDs == nil {
				providerIDs = []string{"windows-update"}
			}
			providers := make([]patching.PatchProvider, 0, len(providerIDs))
			for _, id := range providerIDs {
				providers = append(providers, &heartbeatMockProvider{id: id})
			}

			h := &Heartbeat{patchMgr: patching.NewPatchManager(providers...)}
			installID, err := h.resolvePatchInstallID(patchCommandRef{
				ID:         "platform-patch-id",
				Source:     "microsoft",
				ExternalID: tt.externalID,
				PackageID:  tt.packageID,
			})
			if err != nil {
				t.Fatalf("expected no error, got %v", err)
			}
			if installID != tt.want {
				t.Fatalf("installID = %q, want %q", installID, tt.want)
			}
		})
	}
}

// The device-observed identity is preferred, but it is not mandatory: a ref
// with no externalId at all must still fall back to the catalog selector
// rather than producing an unresolvable install id.
func TestResolvePatchInstallIDFallsBackToPackageIDWhenNoObservedIdentity(t *testing.T) {
	h := &Heartbeat{patchMgr: patching.NewPatchManager(&heartbeatMockProvider{id: "windows-update"})}
	installID, err := h.resolvePatchInstallID(patchCommandRef{
		ID:        "platform-patch-id",
		Source:    "microsoft",
		PackageID: "windows-update:11111111-2222-3333-4444-555555555555",
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if installID != "windows-update:11111111-2222-3333-4444-555555555555" {
		t.Fatalf("installID = %q, want windows-update:11111111-2222-3333-4444-555555555555", installID)
	}
}

func TestExecutePatchInstallCommandReportsPartialFailures(t *testing.T) {
	provider := &heartbeatMockProvider{id: "apt"}
	h := &Heartbeat{patchMgr: patching.NewPatchManager(provider)}

	provider.installErr = errors.New("install failed")
	result := h.executePatchInstallCommand(map[string]any{
		"patchIds": []any{"openssl"},
	}, false)

	if result.Status != "failed" {
		t.Fatalf("expected failed status, got %s", result.Status)
	}
	if result.ExitCode != 1 {
		t.Fatalf("expected exit code 1, got %d", result.ExitCode)
	}
	if !strings.Contains(result.Error, "patch operations failed") {
		t.Fatalf("unexpected error message: %s", result.Error)
	}

	var summary map[string]any
	if err := json.Unmarshal([]byte(result.Stdout), &summary); err != nil {
		t.Fatalf("expected JSON stdout, got parse error: %v", err)
	}
	if summary["failedCount"] != float64(1) {
		t.Fatalf("expected failedCount 1, got %#v", summary["failedCount"])
	}
}

func TestExecutePatchRollbackCommandCallsProviderUninstall(t *testing.T) {
	provider := &heartbeatMockProvider{id: "apt"}
	h := &Heartbeat{patchMgr: patching.NewPatchManager(provider)}

	result := h.executePatchInstallCommand(map[string]any{
		"patchIds": []any{"openssl"},
	}, true)

	if result.Status != "completed" {
		t.Fatalf("expected completed status, got %s", result.Status)
	}
	if len(provider.uninstallIDs) != 1 || provider.uninstallIDs[0] != "openssl" {
		t.Fatalf("expected uninstall of openssl, got %#v", provider.uninstallIDs)
	}

	var summary map[string]any
	if err := json.Unmarshal([]byte(result.Stdout), &summary); err != nil {
		t.Fatalf("expected JSON stdout, got parse error: %v", err)
	}
	if summary["rolledBackCount"] != float64(1) {
		t.Fatalf("expected rolledBackCount 1, got %#v", summary["rolledBackCount"])
	}
}

func TestInstalledPatchesToMapsOmitsUnknownInstalledAt(t *testing.T) {
	h := &Heartbeat{}

	items := h.installedPatchesToMaps([]patching.InstalledPatch{
		{
			ID:       "windows-update:kb5050001",
			Provider: "windows-update",
			Title:    "2026-01 Cumulative Update for Windows 11 (KB5050001)",
			Version:  "10.0.1",
		},
	})

	if len(items) != 1 {
		t.Fatalf("expected 1 mapped item, got %d", len(items))
	}
	if _, ok := items[0]["installedAt"]; ok {
		t.Fatalf("expected installedAt to be omitted when unknown")
	}
}

func TestAvailablePatchesToMapsDerivesHomebrewCaskCategory(t *testing.T) {
	h := &Heartbeat{}

	items := h.availablePatchesToMaps([]patching.AvailablePatch{
		{
			ID:          "homebrew:cask:google-chrome",
			Provider:    "homebrew",
			Title:       "google-chrome",
			Version:     "132.0.1",
			Description: "installed: 131.0.5",
		},
		{
			ID:          "homebrew:wget",
			Provider:    "homebrew",
			Title:       "wget",
			Version:     "1.25.0",
			Description: "installed: 1.24.0",
		},
	})

	if len(items) != 2 {
		t.Fatalf("expected 2 mapped items, got %d", len(items))
	}

	if got := items[0]["category"]; got != "homebrew-cask" {
		t.Fatalf("expected first category homebrew-cask, got %#v", got)
	}
	if got := items[1]["category"]; got != "homebrew" {
		t.Fatalf("expected second category homebrew, got %#v", got)
	}
}
