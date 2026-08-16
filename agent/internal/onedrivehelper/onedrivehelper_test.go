package onedrivehelper

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParseConfig(t *testing.T) {
	tests := []struct {
		name        string
		raw         any
		ok          bool
		libs        int
		allowedUpns []string
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
					map[string]any{
						"libraryId": "lib-1", "displayName": "Docs", "targetingMode": "everyone", "hiveScope": "hkcu",
						"allowedUpns": []any{"todd@contoso.com", "alex@contoso.com"},
					},
				},
			},
			ok: true, libs: 1, allowedUpns: []string{"todd@contoso.com", "alex@contoso.com"},
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
			if ok && len(tt.allowedUpns) > 0 {
				got := cfg.Libraries[0].AllowedUpns
				if len(got) != len(tt.allowedUpns) {
					t.Fatalf("allowedUpns = %v, want %v", got, tt.allowedUpns)
				}
				for i := range got {
					if got[i] != tt.allowedUpns[i] {
						t.Errorf("allowedUpns[%d] = %q, want %q", i, got[i], tt.allowedUpns[i])
					}
				}
			}
		})
	}

	state := DeviceState{SignedInUpns: []string{"todd@contoso.com"}}
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatalf("marshal DeviceState: %v", err)
	}
	var roundTripped DeviceState
	if err := json.Unmarshal(data, &roundTripped); err != nil {
		t.Fatalf("unmarshal DeviceState: %v", err)
	}
	if len(roundTripped.SignedInUpns) != 1 || roundTripped.SignedInUpns[0] != "todd@contoso.com" {
		t.Errorf("signedInUpns = %v, want [todd@contoso.com]", roundTripped.SignedInUpns)
	}
}

func TestPartitionLibraries(t *testing.T) {
	member := func(name string) bool { return name == "Finance-Users" }
	rules := []LibraryRule{
		{LibraryID: "l-every", TargetingMode: "everyone"},
		{LibraryID: "l-local-yes", TargetingMode: "local_ad_group", GroupName: "Finance-Users"},
		{LibraryID: "l-local-no", TargetingMode: "local_ad_group", GroupName: "HR-Users"},
		{LibraryID: "l-local-noname", TargetingMode: "local_ad_group"},
		{LibraryID: "l-graph-yes", TargetingMode: "graph_group", GroupID: "g-1", AllowedUpns: []string{"Todd@Contoso.com"}},
		{LibraryID: "l-graph-no", TargetingMode: "graph_group", GroupID: "g-1", AllowedUpns: []string{"other@contoso.com"}},
		{LibraryID: "l-graph-untagged", TargetingMode: "graph_group", GroupID: "g-1"},
		{LibraryID: "l-unknown", TargetingMode: "future_mode"},
	}
	apply, pending := PartitionLibraries(rules, member, []string{"todd@contoso.com"})

	wantApply := []string{"l-every", "l-local-yes", "l-graph-yes"}
	if len(apply) != len(wantApply) {
		t.Fatalf("apply = %d rules, want %d", len(apply), len(wantApply))
	}
	for i, id := range wantApply {
		if apply[i].LibraryID != id {
			t.Errorf("apply[%d] = %s, want %s", i, apply[i].LibraryID, id)
		}
	}
	// Unmatched and untagged graph_group rules stay pending; unknown modes are
	// also pending (fail closed — never mount something we can't evaluate).
	wantPending := map[string]bool{"l-graph-no": true, "l-graph-untagged": true, "l-unknown": true}
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

	applyWithoutSession, pendingWithoutSession := PartitionLibraries(rules, member, nil)
	graphRules := map[string]bool{"l-graph-yes": true, "l-graph-no": true, "l-graph-untagged": true}
	for _, r := range applyWithoutSession {
		if graphRules[r.LibraryID] {
			t.Errorf("%s must not be applied without a session UPN", r.LibraryID)
		}
	}
	for _, r := range pendingWithoutSession {
		delete(graphRules, r.LibraryID)
	}
	if len(graphRules) != 0 {
		t.Errorf("graph_group rules not pending without a session UPN: %v", graphRules)
	}

	// Empty (non-nil) slice behaves the same as nil: fail closed.
	applyEmptySlice, pendingEmptySlice := PartitionLibraries(rules, member, []string{})
	if len(applyEmptySlice) != 2 { // l-every, l-local-yes only (no graph rules)
		t.Fatalf("apply with empty session UPN slice = %d rules, want 2", len(applyEmptySlice))
	}
	pendingIDs := map[string]bool{}
	for _, r := range pendingEmptySlice {
		pendingIDs[r.LibraryID] = true
	}
	for _, id := range []string{"l-graph-yes", "l-graph-no", "l-graph-untagged", "l-unknown"} {
		if !pendingIDs[id] {
			t.Errorf("%s must be pending with empty session UPN slice", id)
		}
	}

	// Multiple session UPNs: a rule applies if ANY of them matches.
	multiRules := []LibraryRule{
		{LibraryID: "l-second-match", TargetingMode: "graph_group", AllowedUpns: []string{"second@contoso.com"}},
	}
	applyMulti, pendingMulti := PartitionLibraries(multiRules, member, []string{"first@contoso.com", "Second@Contoso.com"})
	if len(applyMulti) != 1 || applyMulti[0].LibraryID != "l-second-match" {
		t.Errorf("apply with second-of-two matching UPN = %v, want [l-second-match]", applyMulti)
	}
	if len(pendingMulti) != 0 {
		t.Errorf("pending with second-of-two matching UPN = %v, want none", pendingMulti)
	}
}

func TestContainsFold(t *testing.T) {
	tests := []struct {
		name   string
		xs     []string
		x      string
		wanted bool
	}{
		{name: "match", xs: []string{"todd@contoso.com"}, x: "todd@contoso.com", wanted: true},
		{name: "case-fold match", xs: []string{"Todd@Contoso.com"}, x: "todd@contoso.com", wanted: true},
		{name: "miss", xs: []string{"other@contoso.com"}, x: "todd@contoso.com", wanted: false},
		{name: "empty slice", xs: nil, x: "todd@contoso.com", wanted: false},
		{name: "empty needle", xs: []string{""}, x: "", wanted: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := containsFold(tt.xs, tt.x); got != tt.wanted {
				t.Errorf("containsFold(%v, %q) = %v, want %v", tt.xs, tt.x, got, tt.wanted)
			}
		})
	}
}

func TestStaleValueNames(t *testing.T) {
	tests := []struct {
		name     string
		existing []string
		desired  []string
		want     []string
	}{
		{
			name:     "mixed prefixes",
			existing: []string{"Breeze-aaa", "Breeze-bbb", "AdminManaged", "Breeze-ccc"},
			desired:  []string{"Breeze-bbb"},
			want:     []string{"Breeze-aaa", "Breeze-ccc"},
		},
		{
			name:     "empty desired",
			existing: []string{"Breeze-aaa", "Breeze-bbb", "NotOurs"},
			desired:  nil,
			want:     []string{"Breeze-aaa", "Breeze-bbb"},
		},
		{
			name:     "empty existing",
			existing: nil,
			desired:  []string{"Breeze-aaa"},
			want:     nil,
		},
		{
			name:     "exact name kept",
			existing: []string{"Breeze-aaa"},
			desired:  []string{"Breeze-aaa"},
			want:     nil,
		},
		{
			name:     "non-prefixed names never returned",
			existing: []string{"AdminManaged", "IntuneValue"},
			desired:  nil,
			want:     nil,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := StaleValueNames(tt.existing, tt.desired)
			if len(got) != len(tt.want) {
				t.Fatalf("StaleValueNames() = %v, want %v", got, tt.want)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Errorf("StaleValueNames()[%d] = %q, want %q", i, got[i], tt.want[i])
				}
			}
			for _, n := range got {
				if !strings.HasPrefix(n, "Breeze-") {
					t.Errorf("StaleValueNames() returned non-Breeze-prefixed name %q", n)
				}
			}
		})
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

// Two sites can entitle libraries with the SAME display name ("Documents" is
// the default for every SharePoint site). The pre-#2336 substring scan matched
// the name anywhere in the path, so one site's mount suppressed the drift
// report for the other — a false "everything is fine" seen in live QA.
func TestComputeDriftIsSiteQualified(t *testing.T) {
	hr := LibraryRule{LibraryID: "l-hr", DisplayName: "Documents", SiteURL: "https://contoso.sharepoint.com/sites/HR"}
	legal := LibraryRule{LibraryID: "l-legal", DisplayName: "Documents", SiteURL: "https://contoso.sharepoint.com/sites/Legal"}

	tests := []struct {
		name    string
		applied []LibraryRule
		mounted []string
		want    []string
	}{
		{
			name:    "same-named libraries, only one site mounted",
			applied: []LibraryRule{hr, legal},
			mounted: []string{`C:\Users\bob\Contoso HR - Documents`},
			want:    []string{"l-legal"},
		},
		{
			name:    "same-named libraries, both sites mounted",
			applied: []LibraryRule{hr, legal},
			mounted: []string{`C:\Users\bob\Contoso HR - Documents`, `C:\Users\bob\Contoso Legal - Documents`},
			want:    nil,
		},
		{
			name:    "single unambiguous match needs no site hint",
			applied: []LibraryRule{{LibraryID: "l-1", DisplayName: "Documents"}},
			mounted: []string{`C:\Users\bob\Anything At All - Documents`},
			want:    nil,
		},
		{
			// Ambiguous AND no hint to disambiguate with: mounted somewhere is
			// as much as we can prove, so we must not invent drift.
			name:    "ambiguous with no site URL does not claim drift",
			applied: []LibraryRule{{LibraryID: "l-1", DisplayName: "Documents"}},
			mounted: []string{`C:\Users\bob\A - Documents`, `C:\Users\bob\B - Documents`},
			want:    nil,
		},
		{
			// The library name itself contains " - "; a naive split on the
			// separator would compare the wrong halves and report false drift.
			name:    "library name containing the separator",
			applied: []LibraryRule{{LibraryID: "l-1", DisplayName: "Docs - Archive"}},
			mounted: []string{`C:\Users\bob\Contoso HR - Docs - Archive`},
			want:    nil,
		},
		{
			// Unrecognized cache shape (no "<Site> - " prefix at all) must fall
			// back to the legacy substring scan rather than report drift.
			name:    "legacy fallback for an unprefixed folder name",
			applied: []LibraryRule{{LibraryID: "l-1", DisplayName: "Finance"}},
			mounted: []string{`C:\Users\bob\Finance Reports`},
			want:    nil,
		},
		{
			name:    "site mounted under a title unrelated to the URL slug",
			applied: []LibraryRule{{LibraryID: "l-1", DisplayName: "Documents", SiteURL: "https://contoso.sharepoint.com/sites/mktg"}},
			mounted: []string{`C:\Users\bob\Marketing Team - Documents`},
			want:    nil, // single match wins; the hint is never used to create drift
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ComputeDrift(tt.applied, tt.mounted)
			var ids []string
			for _, d := range got {
				ids = append(ids, d.LibraryID)
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

// When same-named libraries can't be told apart — neither site hint matches the
// mounted folder's free-text site title — the assignment is right in COUNT but
// arbitrary in attribution. The reported reason must say so instead of naming
// one library with false confidence.
func TestComputeDriftFlagsAmbiguousAttribution(t *testing.T) {
	hr := LibraryRule{LibraryID: "l-hr", DisplayName: "Documents", SiteURL: "https://contoso.sharepoint.com/sites/hrweb"}
	legal := LibraryRule{LibraryID: "l-legal", DisplayName: "Documents", SiteURL: "https://contoso.sharepoint.com/sites/lgl"}
	// The site title matches NEITHER url slug, so pass 1 resolves nothing.
	mounted := []string{`C:\Users\bob\People Operations - Documents`}

	got := ComputeDrift([]LibraryRule{hr, legal}, mounted)

	// Exactly one library is genuinely unmounted, and that count must survive.
	if len(got) != 1 {
		t.Fatalf("drift = %+v, want exactly 1 entry", got)
	}
	if got[0].Reason != ReasonNotMountedAmbiguous {
		t.Errorf("reason = %q, want %q — attribution was a positional guess", got[0].Reason, ReasonNotMountedAmbiguous)
	}

	// A site-confirmed resolution is NOT a guess and must keep the plain reason.
	confirmedMount := []string{`C:\Users\bob\Contoso hrweb - Documents`}
	confirmed := ComputeDrift([]LibraryRule{hr, legal}, confirmedMount)
	if len(confirmed) != 1 || confirmed[0].LibraryID != "l-legal" {
		t.Fatalf("drift = %+v, want exactly [l-legal]", confirmed)
	}
	if confirmed[0].Reason != ReasonNotMounted {
		t.Errorf("reason = %q, want %q — the pairing was site-confirmed", confirmed[0].Reason, ReasonNotMounted)
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
