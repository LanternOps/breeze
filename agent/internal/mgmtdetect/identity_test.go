package mgmtdetect

import (
	"runtime"
	"testing"
)

func TestCollectIdentityStatusPublicWrapper(t *testing.T) {
	collect := CollectIdentityStatus
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		return
	}
	got := collect()
	if got.DetectionSupported() {
		t.Fatal("unsupported platform advertised identity detection")
	}
}
