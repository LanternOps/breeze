package userhelper

import (
	"errors"
	"fmt"
	"reflect"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestShowPamDialogOnInputDesktop(t *testing.T) {
	errDesktop := errors.New("desktop operation failed")
	tests := []struct {
		name          string
		configure     func(*fakePamDesktopOps)
		wantCalls     []string
		wantInputName string
	}{
		{
			name:      "current desktop lookup failure falls back",
			configure: func(ops *fakePamDesktopOps) { ops.currentErr = errDesktop },
			wantCalls: []string{"lock", "current", "show", "unlock"},
		},
		{
			name:      "input desktop open failure falls back",
			configure: func(ops *fakePamDesktopOps) { ops.openErr = errDesktop },
			wantCalls: []string{"lock", "current", "open", "show", "unlock"},
		},
		{
			name:      "input desktop name failure closes handle and falls back",
			configure: func(ops *fakePamDesktopOps) { ops.nameErr = errDesktop },
			wantCalls: []string{"lock", "current", "open", "name:2", "close:2", "show", "unlock"},
		},
		{
			name: "input desktop switch failure closes handle and falls back",
			configure: func(ops *fakePamDesktopOps) {
				ops.setErrors[2] = errDesktop
			},
			wantCalls: []string{"lock", "current", "open", "name:2", "set:2", "close:2", "show", "unlock"},
		},
		{
			name:          "success restores original before closing and unlocking",
			configure:     func(*fakePamDesktopOps) {},
			wantCalls:     []string{"lock", "current", "open", "name:2", "set:2", "show", "set:1", "close:2", "unlock"},
			wantInputName: "Winlogon",
		},
		{
			name: "restore failure does not close or unlock attached thread",
			configure: func(ops *fakePamDesktopOps) {
				ops.setErrors[1] = errDesktop
			},
			wantCalls:     []string{"lock", "current", "open", "name:2", "set:2", "show", "set:1"},
			wantInputName: "Winlogon",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ops := newFakePamDesktopOps()
			tc.configure(ops)

			got := showPamDialogOnInputDesktop(ops, func(inputDesktopName string) ipc.PamDialogResult {
				ops.calls = append(ops.calls, "show")
				if inputDesktopName != tc.wantInputName {
					t.Errorf("input desktop name = %q, want %q", inputDesktopName, tc.wantInputName)
				}
				return ipc.PamDialogResult{Approved: true}
			})

			if !got.Approved || got.DismissedByUser {
				t.Fatalf("dialog result = %+v, want approved", got)
			}
			if !reflect.DeepEqual(ops.calls, tc.wantCalls) {
				t.Fatalf("calls = %v, want %v", ops.calls, tc.wantCalls)
			}
		})
	}
}

func TestShowPamDialogOnInputDesktopRestoresAfterDialogPanic(t *testing.T) {
	ops := newFakePamDesktopOps()
	const panicValue = "MessageBoxW panic"

	var recovered any
	func() {
		defer func() { recovered = recover() }()
		showPamDialogOnInputDesktop(ops, func(string) ipc.PamDialogResult {
			ops.calls = append(ops.calls, "show")
			panic(panicValue)
		})
	}()

	if recovered != panicValue {
		t.Fatalf("recovered panic = %v, want %q", recovered, panicValue)
	}
	wantCalls := []string{"lock", "current", "open", "name:2", "set:2", "show", "set:1", "close:2", "unlock"}
	if !reflect.DeepEqual(ops.calls, wantCalls) {
		t.Fatalf("calls after panic = %v, want %v", ops.calls, wantCalls)
	}
}

type fakePamDesktopOps struct {
	calls       []string
	currentErr  error
	openErr     error
	nameErr     error
	setErrors   map[uintptr]error
	closeErrors map[uintptr]error
}

func newFakePamDesktopOps() *fakePamDesktopOps {
	return &fakePamDesktopOps{
		setErrors:   make(map[uintptr]error),
		closeErrors: make(map[uintptr]error),
	}
}

func (f *fakePamDesktopOps) LockOSThread() {
	f.calls = append(f.calls, "lock")
}

func (f *fakePamDesktopOps) UnlockOSThread() {
	f.calls = append(f.calls, "unlock")
}

func (f *fakePamDesktopOps) CurrentThreadDesktop() (uintptr, error) {
	f.calls = append(f.calls, "current")
	return 1, f.currentErr
}

func (f *fakePamDesktopOps) OpenInputDesktop() (uintptr, error) {
	f.calls = append(f.calls, "open")
	return 2, f.openErr
}

func (f *fakePamDesktopOps) DesktopName(handle uintptr) (string, error) {
	f.calls = append(f.calls, fmt.Sprintf("name:%d", handle))
	return "Winlogon", f.nameErr
}

func (f *fakePamDesktopOps) SetThreadDesktop(handle uintptr) error {
	f.calls = append(f.calls, fmt.Sprintf("set:%d", handle))
	return f.setErrors[handle]
}

func (f *fakePamDesktopOps) CloseDesktop(handle uintptr) error {
	f.calls = append(f.calls, fmt.Sprintf("close:%d", handle))
	return f.closeErrors[handle]
}
