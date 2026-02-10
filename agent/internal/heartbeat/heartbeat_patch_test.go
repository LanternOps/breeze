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
	if len(refs) != 3 {
		t.Fatalf("expected 3 unique refs, got %d", len(refs))
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
