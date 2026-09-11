//go:build windows

package collectors

import (
	"testing"

	"golang.org/x/sys/windows/registry"
)

// TestWindowsCollectRegistryStateCompleteness pins the completeness signal the
// policy-state uploader depends on (#3529).
//
// The uploader sends `replace: true` — which makes the API delete every prior
// row for the device — only when this collector reports a complete batch. So
// the distinction this test guards is load-bearing: a value that is genuinely
// absent must be reported by omission with NO error (so stale server state is
// cleared), while a value that could not be read must mark the batch partial
// (so the server's last good observation survives).
//
// This is the only place the Windows-only branch of the fix executes; the
// collector is build-tagged, so the macOS/Linux suites never reach it.
func TestWindowsCollectRegistryStateCompleteness(t *testing.T) {
	const parentKey = `Software\BreezeAgentTest`
	const subKey = parentKey + `\PolicyStateProbe`

	key, _, err := registry.CreateKey(registry.CURRENT_USER, subKey, registry.ALL_ACCESS)
	if err != nil {
		t.Fatalf("create test key: %v", err)
	}
	t.Cleanup(func() {
		key.Close()
		_ = registry.DeleteKey(registry.CURRENT_USER, subKey)
		_ = registry.DeleteKey(registry.CURRENT_USER, parentKey)
	})

	if err := key.SetStringValue("PolicyValue", "enabled"); err != nil {
		t.Fatalf("set string value: %v", err)
	}
	if err := key.SetDWordValue("PolicyNumber", 7); err != nil {
		t.Fatalf("set dword value: %v", err)
	}

	probePath := `HKCU\` + subKey

	tests := []struct {
		name        string
		probes      []RegistryProbe
		wantEntries int
		wantErr     bool
	}{
		{
			name:        "present string value is reported",
			probes:      []RegistryProbe{{RegistryPath: probePath, ValueName: "PolicyValue"}},
			wantEntries: 1,
		},
		{
			name:        "present dword value is reported",
			probes:      []RegistryProbe{{RegistryPath: probePath, ValueName: "PolicyNumber"}},
			wantEntries: 1,
		},
		{
			name:        "absent value under an existing key is absence, not failure",
			probes:      []RegistryProbe{{RegistryPath: probePath, ValueName: "NoSuchValue"}},
			wantEntries: 0,
		},
		{
			name:        "absent key is absence, not failure",
			probes:      []RegistryProbe{{RegistryPath: probePath + `\NoSuchSubKey`, ValueName: "PolicyValue"}},
			wantEntries: 0,
		},
		{
			name:        "unresolvable hive is skipped without failing the batch",
			probes:      []RegistryProbe{{RegistryPath: `BOGUSHIVE\Whatever`, ValueName: "PolicyValue"}},
			wantEntries: 0,
		},
		{
			name: "a readable probe alongside an absent one keeps the batch complete",
			probes: []RegistryProbe{
				{RegistryPath: probePath, ValueName: "PolicyValue"},
				{RegistryPath: probePath, ValueName: "NoSuchValue"},
			},
			wantEntries: 1,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			col := NewPolicyStateCollector()

			entries, err := col.CollectRegistryState(tc.probes)
			if len(entries) != tc.wantEntries {
				t.Fatalf("entries = %d (%+v), want %d", len(entries), entries, tc.wantEntries)
			}
			if tc.wantErr && err == nil {
				t.Fatal("err = nil, want an incomplete-collection error")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("err = %v, want nil: a complete batch must not be downgraded to replace:false", err)
			}
		})
	}

	// The reported value must be the data, not just the probe echoed back.
	col := NewPolicyStateCollector()
	entries, err := col.CollectRegistryState([]RegistryProbe{{RegistryPath: probePath, ValueName: "PolicyValue"}})
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if len(entries) != 1 || entries[0].ValueData != "enabled" {
		t.Fatalf("entry = %+v, want ValueData \"enabled\"", entries)
	}
}
