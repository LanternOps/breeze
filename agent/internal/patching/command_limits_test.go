package patching

import (
	"strings"
	"testing"
)

func TestValidatePackageNames(t *testing.T) {
	t.Parallel()

	if err := validateAptPackageName("libc6:i386"); err != nil {
		t.Fatalf("validateAptPackageName(valid) error = %v", err)
	}
	if err := validateYumPackageName("kernel-devel"); err != nil {
		t.Fatalf("validateYumPackageName(valid) error = %v", err)
	}
	if err := validateBrewPackageName("homebrew/cask/google-chrome"); err != nil {
		t.Fatalf("validateBrewPackageName(valid) error = %v", err)
	}

	for _, tc := range []struct {
		name string
		fn   func(string) error
		arg  string
	}{
		{name: "apt", fn: validateAptPackageName, arg: "-bad"},
		{name: "yum", fn: validateYumPackageName, arg: "bad value"},
		{name: "brew", fn: validateBrewPackageName, arg: "../etc/passwd"},
		{name: "brew", fn: validateBrewPackageName, arg: "/absolute/path"},
	} {
		if err := tc.fn(tc.arg); err == nil {
			t.Fatalf("%s validator accepted %q", tc.name, tc.arg)
		}
	}
}

func TestValidateConsoleUsername(t *testing.T) {
	t.Parallel()

	if err := validateConsoleUsername("alice"); err != nil {
		t.Fatalf("validateConsoleUsername(valid) error = %v", err)
	}
	for _, value := range []string{"", "bad user", "bad/user", strings.Repeat("a", 65)} {
		if err := validateConsoleUsername(value); err == nil {
			t.Fatalf("validateConsoleUsername accepted %q", value)
		}
	}
}

func TestTruncatePatchOutputAndFields(t *testing.T) {
	t.Parallel()

	output := truncatePatchOutput([]byte(strings.Repeat("x", patchOutputLimit+10)))
	if !strings.Contains(output, "[truncated]") {
		t.Fatalf("truncatePatchOutput = %q", output)
	}

	field := truncatePatchField(strings.Repeat("y", patchFieldLimit+10))
	if !strings.Contains(field, "[truncated]") {
		t.Fatalf("truncatePatchField = %q", field)
	}

	description := truncatePatchDescription(strings.Repeat("z", patchDescriptionLimit+10))
	if !strings.Contains(description, "[truncated]") {
		t.Fatalf("truncatePatchDescription = %q", description)
	}
}
