//go:build windows

package isolation

import (
	"runtime"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestWindowsSchedulerPlatformWiring(t *testing.T) {
	scheduler, ok := NewPlatformScheduler(t.TempDir()).(*windowsScheduler)
	if !ok {
		t.Fatal("Windows platform scheduler is not schtasks")
	}
	if scheduler.run == nil || scheduler.exists == nil || scheduler.verifySignature == nil || scheduler.selfTest == nil || scheduler.recoveryPath == nil || scheduler.now == nil {
		t.Fatal("missing OS adapter")
	}
	if _, err := scheduler.recoveryPath(); err == nil {
		t.Fatal("missing journal gave a recovery executable")
	}
	if ok, why := scheduler.Ready(); ok || why == "" {
		t.Fatalf("ready without journal: %v %q", ok, why)
	}
	if err := verifyRecoveryAuthenticode("bad\x00path"); err == nil {
		t.Fatal("accepted embedded NUL")
	}
}

func TestWindowsTrustABILayout(t *testing.T) {
	var data windows.WinTrustData
	var file windows.WinTrustFileInfo
	want := []uintptr{88, 40, 48, 56, 64, 80, 32, 8, 16, 24}
	if runtime.GOARCH == "386" {
		want = []uintptr{52, 24, 28, 32, 36, 48, 16, 4, 8, 12}
	}
	got := []uintptr{unsafe.Sizeof(data), unsafe.Offsetof(data.FileOrCatalogOrBlobOrSgnrOrCert), unsafe.Offsetof(data.StateAction), unsafe.Offsetof(data.StateData), unsafe.Offsetof(data.URLReference), unsafe.Offsetof(data.SignatureSettings), unsafe.Sizeof(file), unsafe.Offsetof(file.FilePath), unsafe.Offsetof(file.File), unsafe.Offsetof(file.KnownSubject)}
	for i := range got {
		if got[i] != want[i] {
			t.Errorf("%s trust ABI field %d = %d, want %d", runtime.GOARCH, i, got[i], want[i])
		}
	}
}
