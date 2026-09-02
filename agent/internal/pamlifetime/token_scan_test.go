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
