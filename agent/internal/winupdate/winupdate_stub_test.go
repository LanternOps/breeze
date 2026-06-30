//go:build !windows

package winupdate

import "testing"

func TestApplyStubUnsupportedOnNonWindows(t *testing.T) {
	res, err := Apply(true)
	if err != nil {
		t.Fatalf("Apply returned error on non-Windows stub: %v", err)
	}
	if res.Supported {
		t.Errorf("stub Apply reported Supported=true on non-Windows")
	}
}
