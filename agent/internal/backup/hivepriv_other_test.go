//go:build !windows

package backup

import "testing"

// Off Windows there is no token to adjust: AcquireHivePrivileges succeeds
// with a callable, idempotent no-op release, so shared code can
// `defer release()` unconditionally.
func TestAcquireHivePrivileges_OffWindowsIsNoop(t *testing.T) {
	release, err := AcquireHivePrivileges()
	if err != nil || release == nil {
		t.Fatalf("AcquireHivePrivileges(): release nil=%v, err=%v; want non-nil release, nil error", release == nil, err)
	}
	release()
	release()
}
