//go:build windows

package userhelper

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// TaskDialogIndirect lives in comctl32 v6 only. The user-helper's embedded
// manifest (cmd/breeze-user-helper/rsrc_windows_amd64.syso, `make
// build-winres`, checked by `make build-windows-user-helper`) activates v6;
// without it the call cannot be resolved and the prompt falls back to
// MessageBoxTimeoutW with the safe action as the default.
var (
	promptComctl32         = windows.NewLazySystemDLL("comctl32.dll")
	procTaskDialogIndirect = promptComctl32.NewProc("TaskDialogIndirect")
	taskDialogCallbackOnce sync.Once
	taskDialogCallbackPtr  uintptr
	taskDialogRunsMu       sync.Mutex
	taskDialogRuns         = map[uintptr]*taskDialogRun{}
	taskDialogRunSeq       uintptr
)

const (
	tdfAllowDialogCancellation = 0x0008
	tdfCallbackTimer           = 0x0800
	tdnCreated                 = 0
	tdnTimer                   = 4
	promptWMClose              = 0x0010

	// sizeof(TASKDIALOGCONFIG) and sizeof(TASKDIALOG_BUTTON) on amd64. Both
	// are declared inside #include <pshpack1.h> in commctrl.h: packed, no
	// alignment padding, so they are laid out by hand below.
	taskDialogConfigSize = 160
	taskDialogButtonSize = 12
)

type taskDialogRun struct {
	ctx           context.Context
	deadline      time.Time
	presented     func()
	presentedOnce sync.Once
	timedOut      atomic.Bool
	cancelled     atomic.Bool
}

// taskDialogCallback is the PFTASKDIALOGCALLBACK for every prompt task
// dialog: it reports presentation, and on the 200 ms timer closes the dialog
// when the agent withdrew the prompt or its own countdown ran out. Closing
// sends WM_CLOSE (IDCANCEL); the flags set here say why.
func taskDialogCallback(hwnd, msg, wParam, lParam, ref uintptr) uintptr {
	taskDialogRunsMu.Lock()
	run := taskDialogRuns[ref]
	taskDialogRunsMu.Unlock()
	if run == nil {
		return 0
	}
	switch msg {
	case tdnCreated:
		run.presentedOnce.Do(run.presented)
	case tdnTimer:
		switch {
		case run.ctx.Err() != nil:
			run.cancelled.Store(true)
			_, _, _ = procPostMessageW.Call(hwnd, promptWMClose, 0, 0)
		case !run.deadline.IsZero() && !time.Now().Before(run.deadline):
			run.timedOut.Store(true)
			_, _, _ = procPostMessageW.Call(hwnd, promptWMClose, 0, 0)
		}
	}
	return 0 // S_OK
}

func utf16Ptr(s string, keep *[]any) uintptr {
	p, err := syscall.UTF16PtrFromString(s)
	if err != nil {
		p, _ = syscall.UTF16PtrFromString("")
	}
	*keep = append(*keep, p)
	return uintptr(unsafe.Pointer(p))
}

// showNativePromptOS draws a native prompt: a TaskDialogIndirect with the
// real button labels and the safe action as the default (Esc = the model's
// CancelID), or MessageBoxTimeoutW when comctl32 v6 is not available.
func showNativePromptOS(ctx context.Context, m nativePromptModel, presented func()) nativeOutcome {
	if err := procTaskDialogIndirect.Find(); err != nil {
		log.Warn("TaskDialogIndirect unavailable; using the message box fallback", "error", err.Error())
		return showNativeMessageBox(ctx, m, presented)
	}
	spec := nativeTaskDialogSpecFor(m)
	taskDialogCallbackOnce.Do(func() { taskDialogCallbackPtr = syscall.NewCallback(taskDialogCallback) })

	run := &taskDialogRun{ctx: ctx, presented: presented}
	if t := nativeTimeout(m, time.Now()); t > 0 {
		run.deadline = time.Now().Add(t)
	}
	taskDialogRunsMu.Lock()
	taskDialogRunSeq++
	ref := taskDialogRunSeq
	taskDialogRuns[ref] = run
	taskDialogRunsMu.Unlock()
	defer func() {
		taskDialogRunsMu.Lock()
		delete(taskDialogRuns, ref)
		taskDialogRunsMu.Unlock()
	}()

	var keep []any
	buttons := make([]byte, taskDialogButtonSize*len(spec.Buttons))
	for i, b := range spec.Buttons {
		off := i * taskDialogButtonSize
		binary.LittleEndian.PutUint32(buttons[off:], uint32(b.ControlID))
		binary.LittleEndian.PutUint64(buttons[off+4:], uint64(utf16Ptr(b.Label, &keep)))
	}
	cfg := make([]byte, taskDialogConfigSize)
	put32 := func(off int, v uint32) { binary.LittleEndian.PutUint32(cfg[off:], v) }
	put64 := func(off int, v uintptr) { binary.LittleEndian.PutUint64(cfg[off:], uint64(v)) }
	put32(0, taskDialogConfigSize) // cbSize
	flags := uint32(tdfCallbackTimer)
	if spec.AllowCancel {
		flags |= tdfAllowDialogCancellation
	}
	put32(20, flags)                             // dwFlags
	put64(28, utf16Ptr(spec.Title, &keep))       // pszWindowTitle
	put64(44, utf16Ptr(spec.Instruction, &keep)) // pszMainInstruction
	put64(52, utf16Ptr(spec.Content, &keep))     // pszContent
	put32(60, uint32(len(spec.Buttons)))         // cButtons
	if len(buttons) > 0 {
		put64(64, uintptr(unsafe.Pointer(&buttons[0]))) // pButtons
	}
	put32(72, uint32(spec.DefaultControlID)) // nDefaultButton
	put64(140, taskDialogCallbackPtr)        // pfCallback
	put64(148, ref)                          // lpCallbackData

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	var pressed int32
	hr, _, _ := procTaskDialogIndirect.Call(uintptr(unsafe.Pointer(&cfg[0])), uintptr(unsafe.Pointer(&pressed)), 0, 0)
	runtime.KeepAlive(keep)
	runtime.KeepAlive(buttons)
	runtime.KeepAlive(cfg)
	if int32(hr) < 0 {
		return nativeOutcome{Err: fmt.Errorf("TaskDialogIndirect failed: 0x%08x", uint32(hr))}
	}
	switch {
	case run.cancelled.Load() || ctx.Err() != nil:
		return nativeOutcome{Hidden: true}
	case run.timedOut.Load():
		return classifyNativeResult(m, nativeResultTimeout, "")
	case pressed == nativeIDCancel:
		return classifyNativeResult(m, nativeResultCancel, "")
	}
	if id, ok := spec.actionFor(pressed); ok {
		return classifyNativeResult(m, nativeResultButton, id)
	}
	return nativeOutcome{Err: fmt.Errorf("TaskDialogIndirect returned unknown button %d", pressed)}
}

// showNativeMessageBox is the fallback: MessageBoxTimeoutW, safe default.
func showNativeMessageBox(ctx context.Context, m nativePromptModel, presented func()) nativeOutcome {
	spec := nativeMessageBoxSpecFor(m)
	title, err := syscall.UTF16PtrFromString(spec.Title)
	if err != nil {
		return nativeOutcome{Err: err}
	}
	body, err := syscall.UTF16PtrFromString(spec.Body)
	if err != nil {
		return nativeOutcome{Err: err}
	}
	timeout := uintptr(consentInfiniteMs)
	if t := nativeTimeout(m, time.Now()); t > 0 {
		timeout = uintptr(t / time.Millisecond)
	}
	presented()
	done := make(chan struct{})
	defer close(done)
	go closeNativeBoxOnCancel(ctx, done, title)
	ret, _, _ := procMessageBoxTimeoutW.Call(0, uintptr(unsafe.Pointer(body)), uintptr(unsafe.Pointer(title)), uintptr(spec.Flags), 0, timeout)
	if ctx.Err() != nil {
		return nativeOutcome{Hidden: true}
	}
	switch ret {
	case consentIDYes:
		return classifyNativeResult(m, nativeResultButton, spec.YesID)
	case consentIDNo:
		return classifyNativeResult(m, nativeResultButton, spec.NoID)
	case nativeIDOK:
		return classifyNativeResult(m, nativeResultButton, spec.OKID)
	case consentIDTimeout:
		return classifyNativeResult(m, nativeResultTimeout, "")
	}
	return nativeOutcome{Err: errors.New("MessageBoxTimeoutW failed")}
}

// closeNativeBoxOnCancel dismisses this process's fallback box when the agent
// closes the prompt. The result is discarded (ctx is done), so which button
// the dismissal presses does not matter.
func closeNativeBoxOnCancel(ctx context.Context, done <-chan struct{}, title *uint16) {
	select {
	case <-done:
		return
	case <-ctx.Done():
	}
	dialogClass, _ := syscall.UTF16PtrFromString("#32770")
	self := uint32(os.Getpid())
	for {
		var hwnd uintptr
		for {
			hwnd, _, _ = procFindWindowExW.Call(0, hwnd, uintptr(unsafe.Pointer(dialogClass)), uintptr(unsafe.Pointer(title)))
			if hwnd == 0 {
				break
			}
			var pid uint32
			_, _, _ = procGetWindowThreadProcessId.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
			if pid == self {
				_, _, _ = procPostMessageW.Call(hwnd, consentWMCommand, consentIDNo, 0)
				_, _, _ = procPostMessageW.Call(hwnd, consentWMCommand, nativeIDOK, 0)
			}
		}
		select {
		case <-done:
			return
		case <-time.After(consentDialogPollInterval):
		}
	}
}
