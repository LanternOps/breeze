package tools

import "testing"

// TestIsDeniedRegistryTarget exercises the SAM/SECURITY (and LSA-secrets
// subkey) deny-list, robust against hive spelling, path separator, case, and
// "../" traversal within the path string.
func TestIsDeniedRegistryTarget(t *testing.T) {
	cases := []struct {
		name   string
		hive   string
		path   string
		denied bool
	}{
		{"SAM root, short hive", "HKLM", "SAM", true},
		{"SAM root, long hive", "HKEY_LOCAL_MACHINE", "SAM", true},
		{"SAM subkey", "HKLM", `SAM\Domains\Account`, true},
		{"SECURITY root", "HKLM", "SECURITY", true},
		{"LSA secrets subkey", "HKLM", `SECURITY\Policy\Secrets`, true},
		{"LSA secrets nested subkey", "HKLM", `SECURITY\Policy\Secrets\SomeService\CurrVal`, true},
		// Case and separator variants.
		{"lowercase hive and path", "hklm", "sam", true},
		{"forward slashes", "HKLM", "SAM/Domains", true},
		{"mixed slashes", "HKLM", `SAM/Domains\Account`, true},
		{"trailing separator", "HKLM", `SAM\`, true},
		{"leading separator", "HKLM", `\SAM`, true},
		// Traversal collapses onto a denied root.
		{"traversal from sibling", "HKLM", `Software\..\SAM`, true},
		{"traversal from deep sibling", "HKLM", `Software\Vendor\..\..\SECURITY\Policy`, true},

		// Must NOT deny a sibling that merely shares a prefix.
		{"prefix sibling, not SAM", "HKLM", "SAMPLE", false},
		{"prefix sibling, not SECURITY", "HKLM", "SECURITYPOLICY", false},
		{"ordinary HKLM subkey", "HKLM", `SOFTWARE\Microsoft\Windows`, false},

		// Must NOT deny SAM/SECURITY-named keys under a different hive — the
		// real credential store only exists under HKLM.
		{"SAM under HKCU is not the credential store", "HKCU", "SAM", false},
		{"SAM under HKCU, long hive", "HKEY_CURRENT_USER", "SAM", false},
		{"SECURITY under HKU is not the credential store", "HKU", "SECURITY", false},

		// Empty/degenerate paths.
		{"empty path", "HKLM", "", false},
		{"only separators", "HKLM", `\\`, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isDeniedRegistryTarget(tc.hive, tc.path); got != tc.denied {
				t.Fatalf("isDeniedRegistryTarget(%q, %q) = %v, want %v", tc.hive, tc.path, got, tc.denied)
			}
		})
	}
}

func TestCanonicalRegistryHive(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"HKLM", "HKLM"},
		{"hklm", "HKLM"},
		{"HKEY_LOCAL_MACHINE", "HKLM"},
		{" HKEY_LOCAL_MACHINE ", "HKLM"},
		{"HKCU", "HKCU"},
		{"HKEY_CURRENT_USER", "HKCU"},
		{"HKCR", "HKCR"},
		{"HKEY_CLASSES_ROOT", "HKCR"},
		{"HKU", "HKU"},
		{"HKEY_USERS", "HKU"},
		{"HKCC", "HKCC"},
		{"HKEY_CURRENT_CONFIG", "HKCC"},
		{"NOT_A_HIVE", "NOT_A_HIVE"},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			if got := canonicalRegistryHive(tc.in); got != tc.want {
				t.Fatalf("canonicalRegistryHive(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestRegistryPathSegments(t *testing.T) {
	cases := []struct {
		name string
		path string
		want []string
	}{
		{"simple", `SAM\Domains`, []string{"sam", "domains"}},
		{"forward slashes", "SAM/Domains", []string{"sam", "domains"}},
		{"traversal onto root", `Software\..\SAM`, []string{"sam"}},
		{"traversal past root clamps", `..\..\SAM`, []string{"sam"}},
		{"empty", "", nil},
		{"only dot", ".", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := registryPathSegments(tc.path)
			if len(got) != len(tc.want) {
				t.Fatalf("registryPathSegments(%q) = %v, want %v", tc.path, got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("registryPathSegments(%q) = %v, want %v", tc.path, got, tc.want)
				}
			}
		})
	}
}
