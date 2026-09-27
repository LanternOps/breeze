package ipc

import (
	"errors"
	"fmt"
	"testing"
)

func TestVerifyServerSID(t *testing.T) {
	cases := []struct {
		name string
		sid  string
		want bool
	}{
		{"local system", "S-1-5-18", true},
		{"empty", "", false},
		{"standard user", "S-1-5-21-111111111-222222222-333333333-1001", false},
		{"local service", "S-1-5-19", false},
		{"network service", "S-1-5-20", false},
		{"case-sensitive prefix match rejected", "s-1-5-18", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := VerifyServerSID(tc.sid); got != tc.want {
				t.Errorf("VerifyServerSID(%q) = %v, want %v", tc.sid, got, tc.want)
			}
		})
	}
}

func TestVerifyServerBinaryPath(t *testing.T) {
	cases := []struct {
		name     string
		actual   string
		expected string
		want     bool
	}{
		{
			name:     "exact match",
			actual:   `C:\Program Files\Breeze\breeze-agent.exe`,
			expected: `C:\Program Files\Breeze\breeze-agent.exe`,
			want:     true,
		},
		{
			name:     "case-insensitive match",
			actual:   `c:\program files\breeze\breeze-agent.exe`,
			expected: `C:\Program Files\Breeze\breeze-agent.exe`,
			want:     true,
		},
		{
			name:     "different directory",
			actual:   `C:\Users\eve\AppData\Local\Temp\breeze-agent.exe`,
			expected: `C:\Program Files\Breeze\breeze-agent.exe`,
			want:     false,
		},
		{
			name:     "different binary name in the same directory",
			actual:   `C:\Program Files\Breeze\other.exe`,
			expected: `C:\Program Files\Breeze\breeze-agent.exe`,
			want:     false,
		},
		{
			name:     "empty actual",
			actual:   "",
			expected: `C:\Program Files\Breeze\breeze-agent.exe`,
			want:     false,
		},
		{
			name:     "empty expected",
			actual:   `C:\Program Files\Breeze\breeze-agent.exe`,
			expected: "",
			want:     false,
		},
		{
			name:     "both empty",
			actual:   "",
			expected: "",
			want:     false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := VerifyServerBinaryPath(tc.actual, tc.expected); got != tc.want {
				t.Errorf("VerifyServerBinaryPath(%q, %q) = %v, want %v", tc.actual, tc.expected, got, tc.want)
			}
		})
	}
}

func TestCheckServerIdentity(t *testing.T) {
	const agent = `C:\Program Files\Breeze\breeze-agent.exe`
	const user = "S-1-5-21-111111111-222222222-333333333-1001"
	cases := []struct {
		name    string
		ev      ServerIdentityEvidence
		wantErr bool
	}{
		{"system owner, process queried, system + path match", ServerIdentityEvidence{PipeOwnerSID: SystemSID, ProcessQueried: true, ProcessSID: SystemSID, ProcessPath: agent, ExpectedPath: agent}, false},
		{"system owner, process not queryable (unprivileged client)", ServerIdentityEvidence{PipeOwnerSID: SystemSID}, false},
		{"system owner, process queried, no expected path", ServerIdentityEvidence{PipeOwnerSID: SystemSID, ProcessQueried: true, ProcessSID: SystemSID, ProcessPath: agent}, false},
		{"user-owned pipe, process not queryable", ServerIdentityEvidence{PipeOwnerSID: user}, true},
		{"user-owned pipe, process queried as system", ServerIdentityEvidence{PipeOwnerSID: user, ProcessQueried: true, ProcessSID: SystemSID, ProcessPath: agent, ExpectedPath: agent}, true},
		{"administrators-owned pipe", ServerIdentityEvidence{PipeOwnerSID: "S-1-5-32-544"}, true},
		{"empty owner", ServerIdentityEvidence{}, true},
		{"system owner, process is a user process", ServerIdentityEvidence{PipeOwnerSID: SystemSID, ProcessQueried: true, ProcessSID: user, ProcessPath: agent, ExpectedPath: agent}, true},
		{"system owner, process is another system binary", ServerIdentityEvidence{PipeOwnerSID: SystemSID, ProcessQueried: true, ProcessSID: SystemSID, ProcessPath: `C:\Windows\System32\svchost.exe`, ExpectedPath: agent}, true},
		{"system owner, process queried with empty path", ServerIdentityEvidence{PipeOwnerSID: SystemSID, ProcessQueried: true, ProcessSID: SystemSID, ExpectedPath: agent}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := CheckServerIdentity(tc.ev)
			if (err != nil) != tc.wantErr {
				t.Fatalf("CheckServerIdentity(%+v) err = %v, wantErr %v", tc.ev, err, tc.wantErr)
			}
		})
	}
}

func TestServerProcessNotQueryable(t *testing.T) {
	denied := fmt.Errorf("ipc: OpenProcess(4): %w: %w", ErrServerProcessNotQueryable, errors.New("Access is denied."))
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"open process denied", denied, true},
		{"wrapped again", fmt.Errorf("ipc: resolve: %w", denied), true},
		// A denial from a later query (image path, token) is not the
		// "cannot open the process" case and must not skip the checks.
		{"other denial", errors.New("ipc: OpenProcessToken: Access is denied."), false},
		{"unrelated", errors.New("ipc: GetNamedPipeServerProcessId: failed"), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := serverProcessNotQueryable(tc.err); got != tc.want {
				t.Fatalf("serverProcessNotQueryable(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}
