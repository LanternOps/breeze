package monitoring

import (
	"errors"
	"fmt"
	"testing"

	"github.com/breeze-rmm/agent/internal/svcquery"
)

// A service lookup that failed for any reason other than "the service does not
// exist" must not be reported as not_found (#7967: a running WinDefend was
// reported not_found because the open was denied).
func TestServiceErrorStatus(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want CheckStatus
	}{
		{"sentinel not found", svcquery.ErrServiceNotFound, StatusNotFound},
		{"wrapped not found", fmt.Errorf("svcquery: open service Foo: %w", svcquery.ErrServiceNotFound), StatusNotFound},
		{"access denied", errors.New("svcquery: open service WinDefend: Access is denied."), StatusError},
		{"scm connect failure", errors.New("svcquery: connect to SCM: Access is denied."), StatusError},
		{"query failure", errors.New("svcquery: query Foo: The handle is invalid."), StatusError},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := serviceErrorStatus(tt.err); got != tt.want {
				t.Errorf("serviceErrorStatus(%v) = %q, want %q", tt.err, got, tt.want)
			}
		})
	}
}
