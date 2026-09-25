package helper

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

// #6927 Lab Run C: with breeze-helper.exe deleted but the MSI product still
// registered, `msiexec /i` fails with 1603 on every attempt. The installer
// must remove the orphaned registration before a fresh install.

type fakeMSI struct {
	binaryPresent bool
	productCode   string
	findErr       error
	uninstallErr  error
	installErr    error
	calls         []string
}

func (f *fakeMSI) ops() msiOps {
	return msiOps{
		binaryExists: func(string) bool { f.calls = append(f.calls, "stat"); return f.binaryPresent },
		findProductCode: func() (string, error) {
			f.calls = append(f.calls, "find")
			return f.productCode, f.findErr
		},
		uninstall: func(code string) error { f.calls = append(f.calls, "uninstall:"+code); return f.uninstallErr },
		install:   func(p string) error { f.calls = append(f.calls, "install:"+p); return f.installErr },
	}
}

func TestInstallMSIRemovesOrphanedProductBeforeInstall(t *testing.T) {
	f := &fakeMSI{productCode: "{ABC}"}
	if err := installMSI("pkg.msi", `C:\bin\breeze-helper.exe`, f.ops()); err != nil {
		t.Fatalf("installMSI: %v", err)
	}
	want := []string{"stat", "find", "uninstall:{ABC}", "install:pkg.msi"}
	if !reflect.DeepEqual(f.calls, want) {
		t.Fatalf("calls=%v, want %v", f.calls, want)
	}
}

func TestInstallMSIPlainInstallWhenBinaryPresent(t *testing.T) {
	f := &fakeMSI{binaryPresent: true, productCode: "{ABC}"}
	if err := installMSI("pkg.msi", "bin", f.ops()); err != nil {
		t.Fatalf("installMSI: %v", err)
	}
	want := []string{"stat", "install:pkg.msi"}
	if !reflect.DeepEqual(f.calls, want) {
		t.Fatalf("calls=%v, want %v (an in-place upgrade must never uninstall first)", f.calls, want)
	}
}

func TestInstallMSIPlainInstallWhenNothingRegistered(t *testing.T) {
	f := &fakeMSI{}
	if err := installMSI("pkg.msi", "bin", f.ops()); err != nil {
		t.Fatalf("installMSI: %v", err)
	}
	want := []string{"stat", "find", "install:pkg.msi"}
	if !reflect.DeepEqual(f.calls, want) {
		t.Fatalf("calls=%v, want %v", f.calls, want)
	}
}

func TestInstallMSIStopsWhenOrphanRemovalFails(t *testing.T) {
	f := &fakeMSI{productCode: "{ABC}", uninstallErr: errors.New("exit status 1603")}
	err := installMSI("pkg.msi", "bin", f.ops())
	if err == nil || !strings.Contains(err.Error(), "{ABC}") {
		t.Fatalf("err=%v, want an error naming the orphaned product", err)
	}
	for _, c := range f.calls {
		if strings.HasPrefix(c, "install:") {
			t.Fatalf("install ran after orphan removal failed: %v", f.calls)
		}
	}
}

func TestInstallMSIInstallsAnywayWhenRegistryLookupFails(t *testing.T) {
	f := &fakeMSI{findErr: errors.New("access denied")}
	if err := installMSI("pkg.msi", "bin", f.ops()); err != nil {
		t.Fatalf("installMSI: %v", err)
	}
	want := []string{"stat", "find", "install:pkg.msi"}
	if !reflect.DeepEqual(f.calls, want) {
		t.Fatalf("calls=%v, want %v", f.calls, want)
	}
}
