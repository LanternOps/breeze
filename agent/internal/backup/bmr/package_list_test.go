package bmr

import (
	"strings"
	"testing"
)

func TestValidPackageName(t *testing.T) {
	cases := []struct {
		name string
		want bool
	}{
		{"vim", true},
		{"vim-enhanced-8.2.2637-20.el9.x86_64", true},
		{"libstdc++6", true},
		{"gpg-pubkey-8483c65d-5ccc5b19", true},
		{"python3.11", true},
		{"perl-Test-Harness-1:3.42-461.el9.noarch", true},
		{"pkg~beta1", true},
		{"-y", false},
		{"--installroot=/", false},
		{"--setopt=reposdir=/tmp/x", false},
		{"a b", false},
		{"", false},
		{"vim;rm", false},
		{"$(id)", false},
		{"pkg/../x", false},
		{strings.Repeat("a", 255), true},
		{strings.Repeat("a", 256), false},
	}
	for _, tc := range cases {
		if got := validPackageName(tc.name); got != tc.want {
			t.Errorf("validPackageName(%q) = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestValidDpkgSelectionLine(t *testing.T) {
	cases := []struct {
		line string
		want bool
	}{
		{"vim\tinstall", true},
		{"accountsservice\t\t\t\t\tinstall", true},
		{"libc6:amd64\t\t\t\t\tinstall", true},
		{"linux-image-6.8.0-45-generic\thold", true},
		{"old-pkg deinstall", true},
		{"gone-pkg purge", true},
		{"vim\tremove", false},
		{"Vim\tinstall", false},
		{"-vim\tinstall", false},
		{"vim", false},
		{"vim install extra", false},
		{"vim;reboot\tinstall", false},
	}
	for _, tc := range cases {
		if got := validDpkgSelectionLine(tc.line); got != tc.want {
			t.Errorf("validDpkgSelectionLine(%q) = %v, want %v", tc.line, got, tc.want)
		}
	}
}

func TestDnfInstallArgs(t *testing.T) {
	args, n, skipped := dnfInstallArgs([]byte("vim-8.2.x86_64\n-y\n--installroot=/tmp/x\na b\n\nbash-5.1.x86_64\n"))
	if n != 2 || skipped != 3 {
		t.Fatalf("valid=%d skipped=%d, want 2/3", n, skipped)
	}
	want := []string{"install", "-y", "--", "vim-8.2.x86_64", "bash-5.1.x86_64"}
	if strings.Join(args, "|") != strings.Join(want, "|") {
		t.Fatalf("args = %q, want %q", args, want)
	}
	for i, a := range args {
		if strings.HasPrefix(a, "-") && i > 2 {
			t.Fatalf("option-shaped argument after --: %q", a)
		}
	}
	if _, n, skipped := dnfInstallArgs([]byte("-y\n--nogpgcheck\n")); n != 0 || skipped != 2 {
		t.Fatalf("all-invalid list: valid=%d skipped=%d, want 0/2", n, skipped)
	}
}

func TestInvalidDpkgSelectionLines(t *testing.T) {
	if n := invalidDpkgSelectionLines([]byte("vim\tinstall\nlibc6:amd64\tinstall\n\n")); n != 0 {
		t.Fatalf("valid file: %d invalid lines", n)
	}
	if n := invalidDpkgSelectionLines([]byte("vim\tinstall\n--admindir=/tmp\tinstall\nx y z\n")); n != 2 {
		t.Fatalf("invalid lines = %d, want 2", n)
	}
}
