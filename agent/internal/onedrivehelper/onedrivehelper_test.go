package onedrivehelper

import (
	"strings"
	"testing"
)

func TestParseConfig(t *testing.T) {
	tests := []struct {
		name string
		raw  any
		ok   bool
		libs int
	}{
		{
			name: "valid full payload",
			raw: map[string]any{
				"base": map[string]any{
					"silentAccountConfig": true, "filesOnDemand": true,
					"kfmSilentOptIn": true, "kfmFolders": []any{"Documents"},
					"kfmBlockOptOut": false, "tenantAssociationId": "tid-1", "restartOnChange": true,
				},
				"libraries": []any{
					map[string]any{"libraryId": "lib-1", "displayName": "Docs", "targetingMode": "everyone", "hiveScope": "hkcu"},
				},
			},
			ok: true, libs: 1,
		},
		{name: "null tenantAssociationId tolerated", raw: map[string]any{"base": map[string]any{"tenantAssociationId": nil}, "libraries": []any{}}, ok: true, libs: 0},
		{name: "not an object", raw: "nope", ok: false},
		{name: "nil", raw: nil, ok: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg, ok := ParseConfig(tt.raw)
			if ok != tt.ok {
				t.Fatalf("ok = %v, want %v", ok, tt.ok)
			}
			if ok && len(cfg.Libraries) != tt.libs {
				t.Fatalf("libraries = %d, want %d", len(cfg.Libraries), tt.libs)
			}
		})
	}
}

func TestPartitionLibraries(t *testing.T) {
	member := func(name string) bool { return name == "Finance-Users" }
	rules := []LibraryRule{
		{LibraryID: "l-every", TargetingMode: "everyone"},
		{LibraryID: "l-local-yes", TargetingMode: "local_ad_group", GroupName: "Finance-Users"},
		{LibraryID: "l-local-no", TargetingMode: "local_ad_group", GroupName: "HR-Users"},
		{LibraryID: "l-local-noname", TargetingMode: "local_ad_group"},
		{LibraryID: "l-graph", TargetingMode: "graph_group", GroupID: "g-1"},
		{LibraryID: "l-unknown", TargetingMode: "future_mode"},
	}
	apply, pending := PartitionLibraries(rules, member)

	wantApply := []string{"l-every", "l-local-yes"}
	if len(apply) != len(wantApply) {
		t.Fatalf("apply = %d rules, want %d", len(apply), len(wantApply))
	}
	for i, id := range wantApply {
		if apply[i].LibraryID != id {
			t.Errorf("apply[%d] = %s, want %s", i, apply[i].LibraryID, id)
		}
	}
	// graph_group is pending (Phase 4 evaluates it); unknown modes are pending
	// (fail closed — never mount something we can't evaluate).
	wantPending := map[string]bool{"l-graph": true, "l-unknown": true}
	for _, r := range pending {
		if !wantPending[r.LibraryID] {
			t.Errorf("unexpected pending rule %s", r.LibraryID)
		}
	}
	if len(pending) != len(wantPending) {
		t.Fatalf("pending = %d rules, want %d", len(pending), len(wantPending))
	}
	// local_ad_group misses (no-match, no groupName) are neither applied nor
	// pending: the user is simply not entitled.
	for _, r := range apply {
		if r.LibraryID == "l-local-no" || r.LibraryID == "l-local-noname" {
			t.Errorf("%s must not be applied", r.LibraryID)
		}
	}
}

func TestValueName(t *testing.T) {
	a := ValueName("tenantId=t&siteId={s}&…")
	b := ValueName("tenantId=t&siteId={s}&…")
	c := ValueName("different")
	if a != b {
		t.Error("ValueName must be deterministic")
	}
	if a == c {
		t.Error("distinct libraries must get distinct names")
	}
	if !strings.HasPrefix(a, "Breeze-") {
		t.Errorf("name %q must be Breeze-prefixed (ownership marker)", a)
	}
	if len(a) > 40 {
		t.Errorf("name %q too long for a registry value name", a)
	}
}

func TestTenantIDFromComposite(t *testing.T) {
	tests := []struct{ in, want string }{
		{"tenantId=02ad5f9c-3696-477b-8cb3-9ba4e0a9ac9c&siteId={x}&version=1", "02ad5f9c-3696-477b-8cb3-9ba4e0a9ac9c"},
		{"siteId={x}&tenantId=abc&version=1", "abc"},
		{"no-tenant-here", ""},
		{"", ""},
	}
	for _, tt := range tests {
		if got := TenantIDFromComposite(tt.in); got != tt.want {
			t.Errorf("TenantIDFromComposite(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

// A "go:build !windows" tag is not needed here — this test file has no build
// tag, and on Windows dev boxes the windows Apply also satisfies the signature.
func TestApplySignature(t *testing.T) {
	// Compile-time check that Apply exists with the cross-platform signature.
	var _ func(Config) (*DeviceState, error) = Apply
}

func TestComputeDrift(t *testing.T) {
	applied := []LibraryRule{
		{LibraryID: "l-1", DisplayName: "Finance Docs"},
		{LibraryID: "l-2", DisplayName: "Company"},
	}
	tests := []struct {
		name    string
		mounted []string
		want    []string // drifted library ids
	}{
		{
			name:    "all mounted",
			mounted: []string{`C:\Users\bob\Contoso\Contoso - Finance Docs`, `C:\Users\bob\Contoso\Contoso - Company`},
			want:    nil,
		},
		{
			name:    "one missing",
			mounted: []string{`C:\Users\bob\Contoso\Contoso - Company`},
			want:    []string{"l-1"},
		},
		{
			name:    "case-insensitive match",
			mounted: []string{`c:\users\bob\contoso\contoso - FINANCE DOCS`, `c:\x\contoso - company`},
			want:    nil,
		},
		{name: "nothing mounted", mounted: nil, want: []string{"l-1", "l-2"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ComputeDrift(applied, tt.mounted)
			if got == nil {
				t.Error("ComputeDrift must never return nil (wire contract: driftEntries is always an array)")
			}
			var ids []string
			for _, d := range got {
				ids = append(ids, d.LibraryID)
				if d.Reason != "not_mounted" {
					t.Errorf("reason = %q, want not_mounted", d.Reason)
				}
			}
			if len(ids) != len(tt.want) {
				t.Fatalf("drift ids = %v, want %v", ids, tt.want)
			}
			for i := range ids {
				if ids[i] != tt.want[i] {
					t.Errorf("drift[%d] = %s, want %s", i, ids[i], tt.want[i])
				}
			}
		})
	}
}

func TestFolderRedirectionState(t *testing.T) {
	tests := []struct{ raw, want string }{
		{`C:\Users\bob\OneDrive - Contoso\Documents`, "redirected"},
		{`%USERPROFILE%\Documents`, "not_redirected"},
		{`D:\Docs`, "not_redirected"},
		{"", "unknown"},
	}
	for _, tt := range tests {
		if got := FolderRedirectionState(tt.raw); got != tt.want {
			t.Errorf("FolderRedirectionState(%q) = %q, want %q", tt.raw, got, tt.want)
		}
	}
}
