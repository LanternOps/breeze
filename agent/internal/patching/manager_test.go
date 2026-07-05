package patching

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

type fakeProvider struct {
	id            string
	scan          []AvailablePatch
	scanErr       error
	installed     []InstalledPatch
	installErr    error
	installResult InstallResult
	uninstallErr  error
	lastInstallID string
	lastUninstID  string
}

func (p *fakeProvider) ID() string { return p.id }

func (p *fakeProvider) Name() string { return p.id }

func (p *fakeProvider) Scan() ([]AvailablePatch, error) { return p.scan, p.scanErr }

func (p *fakeProvider) Install(patchID string) (InstallResult, error) {
	p.lastInstallID = patchID
	if p.installErr != nil {
		return InstallResult{}, p.installErr
	}
	if p.installResult.PatchID == "" {
		p.installResult.PatchID = patchID
	}
	return p.installResult, nil
}

func (p *fakeProvider) Uninstall(patchID string) error {
	p.lastUninstID = patchID
	return p.uninstallErr
}

func (p *fakeProvider) GetInstalled() ([]InstalledPatch, error) { return p.installed, nil }

func TestPatchManagerScanDecoratesProviderPatchIDs(t *testing.T) {
	apt := &fakeProvider{
		id:   "apt",
		scan: []AvailablePatch{{ID: "openssl", Title: "OpenSSL"}},
	}
	yum := &fakeProvider{
		id:   "yum",
		scan: []AvailablePatch{{ID: "kernel", Title: "Kernel"}},
	}

	mgr := NewPatchManager(apt, yum)

	patches, err := mgr.Scan()
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(patches) != 2 {
		t.Fatalf("expected 2 patches, got %d", len(patches))
	}

	if patches[0].ID != "apt:openssl" || patches[0].Provider != "apt" {
		t.Fatalf("unexpected first patch: %+v", patches[0])
	}
	if patches[1].ID != "yum:kernel" || patches[1].Provider != "yum" {
		t.Fatalf("unexpected second patch: %+v", patches[1])
	}
}

func TestPatchManagerScanWithCoverage(t *testing.T) {
	tests := []struct {
		name        string
		providers   []*fakeProvider
		wantPatches int
		wantCovered []string
		wantErr     bool
	}{
		{
			name: "all providers ran",
			providers: []*fakeProvider{
				{id: "windows-update", scan: []AvailablePatch{{ID: "kb1", Title: "KB1"}}},
				{id: "winget", scan: []AvailablePatch{{ID: "Mozilla.Firefox", Title: "Firefox"}}},
			},
			wantPatches: 2,
			wantCovered: []string{"windows-update", "winget"},
		},
		{
			name: "empty result still counts as covered",
			providers: []*fakeProvider{
				{id: "windows-update"},
			},
			wantPatches: 0,
			wantCovered: []string{"windows-update"},
		},
		{
			name: "skipped provider is excluded from coverage without error",
			providers: []*fakeProvider{
				{id: "windows-update", scan: []AvailablePatch{{ID: "kb1", Title: "KB1"}}},
				{id: "winget", scanErr: ErrScanSkipped},
			},
			wantPatches: 1,
			wantCovered: []string{"windows-update"},
		},
		{
			name: "wrapped skip sentinel is still a skip",
			providers: []*fakeProvider{
				{id: "winget", scanErr: fmt.Errorf("no helper session: %w", ErrScanSkipped)},
			},
			wantPatches: 0,
			wantCovered: []string{},
		},
		{
			name: "failed provider is excluded from coverage and surfaces the error",
			providers: []*fakeProvider{
				{id: "windows-update", scan: []AvailablePatch{{ID: "kb1", Title: "KB1"}}},
				{id: "winget", scanErr: errors.New("timeout")},
			},
			wantPatches: 1,
			wantCovered: []string{"windows-update"},
			wantErr:     true,
		},
		{
			name: "all providers skipped yields empty coverage and no error",
			providers: []*fakeProvider{
				{id: "winget", scanErr: ErrScanSkipped},
				{id: "chocolatey", scanErr: ErrScanSkipped},
			},
			wantPatches: 0,
			wantCovered: []string{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			providers := make([]PatchProvider, len(tt.providers))
			for i, p := range tt.providers {
				providers[i] = p
			}
			mgr := NewPatchManager(providers...)

			patches, covered, err := mgr.ScanWithCoverage()
			if tt.wantErr && err == nil {
				t.Fatal("expected error, got nil")
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("expected no error, got %v", err)
			}
			if len(patches) != tt.wantPatches {
				t.Fatalf("expected %d patches, got %d: %+v", tt.wantPatches, len(patches), patches)
			}
			if len(covered) != len(tt.wantCovered) {
				t.Fatalf("covered = %v, want %v", covered, tt.wantCovered)
			}
			for i, id := range tt.wantCovered {
				if covered[i] != id {
					t.Fatalf("covered = %v, want %v", covered, tt.wantCovered)
				}
			}
		})
	}
}

func TestPatchManagerScanIgnoresSkippedProviders(t *testing.T) {
	// Legacy Scan() must not surface ErrScanSkipped as a failure.
	mgr := NewPatchManager(
		&fakeProvider{id: "windows-update", scan: []AvailablePatch{{ID: "kb1", Title: "KB1"}}},
		&fakeProvider{id: "winget", scanErr: ErrScanSkipped},
	)

	patches, err := mgr.Scan()
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(patches) != 1 {
		t.Fatalf("expected 1 patch, got %d", len(patches))
	}
}

func TestPatchManagerInstallUsesOnlyProviderWhenSingleProvider(t *testing.T) {
	apt := &fakeProvider{id: "apt"}
	mgr := NewPatchManager(apt)

	result, err := mgr.Install("openssl")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if apt.lastInstallID != "openssl" {
		t.Fatalf("expected provider install id openssl, got %s", apt.lastInstallID)
	}
	if result.PatchID != "apt:openssl" {
		t.Fatalf("expected formatted patch id apt:openssl, got %s", result.PatchID)
	}
	if result.Provider != "apt" {
		t.Fatalf("expected provider apt, got %s", result.Provider)
	}
}

func TestPatchManagerInstallRequiresProviderPrefixWithMultipleProviders(t *testing.T) {
	mgr := NewPatchManager(&fakeProvider{id: "apt"}, &fakeProvider{id: "yum"})

	_, err := mgr.Install("openssl")
	if err == nil {
		t.Fatal("expected error for unscoped patch id")
	}
	if !strings.Contains(err.Error(), "must be prefixed") {
		t.Fatalf("expected provider-prefix error, got %v", err)
	}
}

func TestPatchManagerInstallReturnsUnknownProviderError(t *testing.T) {
	mgr := NewPatchManager(&fakeProvider{id: "apt"})

	_, err := mgr.Install("yum:kernel")
	if err == nil {
		t.Fatal("expected error for unknown provider")
	}
	if !strings.Contains(err.Error(), "unknown patch provider") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestPatchManagerUninstallPassesLocalPatchIDToProvider(t *testing.T) {
	apt := &fakeProvider{id: "apt"}
	mgr := NewPatchManager(apt)

	err := mgr.Uninstall("apt:openssl")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if apt.lastUninstID != "openssl" {
		t.Fatalf("expected uninstall id openssl, got %s", apt.lastUninstID)
	}
}

func TestPatchManagerInstallReturnsProviderError(t *testing.T) {
	apt := &fakeProvider{id: "apt", installErr: errors.New("boom")}
	mgr := NewPatchManager(apt)

	_, err := mgr.Install("apt:openssl")
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "boom") {
		t.Fatalf("unexpected error: %v", err)
	}
}
