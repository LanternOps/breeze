package patching

import (
	"testing"
)

// hookTestProvider is a minimal provider that records installs.
type hookTestProvider struct {
	id       string
	installs []string
}

func (p *hookTestProvider) ID() string                              { return p.id }
func (p *hookTestProvider) Name() string                            { return p.id }
func (p *hookTestProvider) Scan() ([]AvailablePatch, error)         { return nil, nil }
func (p *hookTestProvider) Uninstall(string) error                  { return nil }
func (p *hookTestProvider) GetInstalled() ([]InstalledPatch, error) { return nil, nil }
func (p *hookTestProvider) Install(id string) (InstallResult, error) {
	p.installs = append(p.installs, id)
	return InstallResult{PatchID: id}, nil
}

// hookedTestProvider calls the hook itself, the way WindowsUpdateProvider
// does after its own skip check and download — or not at all when it skips.
type hookedTestProvider struct {
	hookTestProvider
	skip     bool
	category string
}

func (p *hookedTestProvider) InstallWithHook(id string, before BeforeInstallFunc) (InstallResult, error) {
	if p.skip {
		return InstallResult{PatchID: id, Skipped: true, SkipReason: "already_installed"}, nil
	}
	if before != nil {
		before(p.category)
	}
	return p.Install(id)
}

func TestInstallWithHookCallsTheHookBeforeAPlainProviderInstalls(t *testing.T) {
	p := &hookTestProvider{id: "apt"}
	m := NewPatchManager(p)
	var installsAtHook = -1
	var gotCategory = "unset"
	res, err := m.InstallWithHook("apt:openssl", func(category string) {
		installsAtHook = len(p.installs)
		gotCategory = category
	})
	if err != nil {
		t.Fatal(err)
	}
	if installsAtHook != 0 {
		t.Fatalf("hook ran after %d install(s); it must precede the install", installsAtHook)
	}
	if gotCategory != "" {
		t.Fatalf("category = %q, want \"\" (a plain provider knows none)", gotCategory)
	}
	if res.PatchID != "apt:openssl" || len(p.installs) != 1 {
		t.Fatalf("result = %+v, installs = %v", res, p.installs)
	}
}

func TestInstallWithHookLetsAHookedProviderDecideWhen(t *testing.T) {
	p := &hookedTestProvider{hookTestProvider: hookTestProvider{id: "windows-update"}, category: "security"}
	m := NewPatchManager(p)
	var got []string
	if _, err := m.InstallWithHook("windows-update:KB1", func(c string) { got = append(got, c) }); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0] != "security" {
		t.Fatalf("hook calls = %v, want exactly one with the provider's category", got)
	}
}

func TestInstallWithHookNotCalledWhenTheProviderSkips(t *testing.T) {
	// "Already installed / no longer offered" is decided inside the provider,
	// before any mutation: no hook, so no checkpoint for a no-op.
	p := &hookedTestProvider{hookTestProvider: hookTestProvider{id: "windows-update"}, skip: true}
	m := NewPatchManager(p)
	called := false
	res, err := m.InstallWithHook("windows-update:KB1", func(string) { called = true })
	if err != nil {
		t.Fatal(err)
	}
	if called || !res.Skipped {
		t.Fatalf("called = %v, result = %+v", called, res)
	}
	if res.Provider != "windows-update" || res.PatchID != "windows-update:KB1" {
		t.Fatalf("result identity not normalized like Install: %+v", res)
	}
}

func TestInstallWithHookNotCalledForAnUnknownProvider(t *testing.T) {
	m := NewPatchManager(&hookTestProvider{id: "apt"})
	called := false
	if _, err := m.InstallWithHook("yum:openssl", func(string) { called = true }); err == nil {
		t.Fatal("expected an unknown-provider error")
	}
	if called {
		t.Fatal("hook ran for a patch that could not be installed")
	}
}

func TestInstallWithNilHookMatchesInstall(t *testing.T) {
	p := &hookTestProvider{id: "apt"}
	m := NewPatchManager(p)
	res, err := m.InstallWithHook("apt:openssl", nil)
	if err != nil || res.PatchID != "apt:openssl" || res.Provider != "apt" {
		t.Fatalf("res = %+v, err = %v", res, err)
	}
}
