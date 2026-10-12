package pamlifetime

import (
	"errors"
	"strings"
	"testing"
)

func TestTokenInspectionFailureIsFailClosed(t *testing.T) {
	accessDenied := errors.New("access denied")
	err := tokenInspectionFailure(4242, accessDenied)
	if !errors.Is(err, accessDenied) || !strings.Contains(err.Error(), "4242") {
		t.Fatalf("token inspection error = %v, want PID-scoped access denied", err)
	}
	if err := tokenInspectionFailure(4242, nil); err != nil {
		t.Fatalf("successful token inspection = %v", err)
	}
}

func TestKernelSystemIdentityRequiresEveryKernelAttribute(t *testing.T) {
	tests := []struct {
		name        string
		pid, parent uint32
		image       string
		kernel      bool
	}{
		{name: "kernel System", pid: 4, image: "System", kernel: true},
		{name: "user process with matching name", pid: 42, image: "System"},
		{name: "unexpected parent", pid: 4, parent: 1, image: "System"},
		{name: "unexpected image", pid: 4, image: "System.exe"},
		{name: "protected service", pid: 500, image: "lsass.exe"},
		{name: "idle pseudo process", pid: 0, image: "System Idle Process"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isKernelSystemIdentity(tt.pid, tt.parent, tt.image); got != tt.kernel {
				t.Fatalf("kernel identity=%v, want %v", got, tt.kernel)
			}
		})
	}
}
