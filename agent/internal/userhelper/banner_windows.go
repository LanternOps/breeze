//go:build windows

package userhelper

import (
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// A borderless, always-on-top, non-activating pill window pinned top-center
// showing "Billy from Olive Technology is connected". Pure user32/gdi32
// syscalls — the user-helper ships CGO_ENABLED=0.

var (
	bannerGdi32               = syscall.NewLazyDLL("gdi32.dll")
	procRegisterClassExW      = pamDialogUser32.NewProc("RegisterClassExW")
	procCreateWindowExW       = pamDialogUser32.NewProc("CreateWindowExW")
	procDefWindowProcW        = pamDialogUser32.NewProc("DefWindowProcW")
	procDestroyWindow         = pamDialogUser32.NewProc("DestroyWindow")
	procShowWindow            = pamDialogUser32.NewProc("ShowWindow")
	procGetMessageW           = pamDialogUser32.NewProc("GetMessageW")
	procTranslateMessage      = pamDialogUser32.NewProc("TranslateMessage")
	procDispatchMessageW      = pamDialogUser32.NewProc("DispatchMessageW")
	procPostMessageW          = pamDialogUser32.NewProc("PostMessageW")
	procPostQuitMessage       = pamDialogUser32.NewProc("PostQuitMessage")
	procBeginPaint            = pamDialogUser32.NewProc("BeginPaint")
	procEndPaint              = pamDialogUser32.NewProc("EndPaint")
	procDrawTextW             = pamDialogUser32.NewProc("DrawTextW")
	procGetClientRect         = pamDialogUser32.NewProc("GetClientRect")
	procGetSystemMetrics      = pamDialogUser32.NewProc("GetSystemMetrics")
	procInvalidateRect        = pamDialogUser32.NewProc("InvalidateRect")
	procSetLayeredWindowAttrs = pamDialogUser32.NewProc("SetLayeredWindowAttributes")
	procGetModuleHandleW      = syscall.NewLazyDLL("kernel32.dll").NewProc("GetModuleHandleW")
	procCreateSolidBrush      = bannerGdi32.NewProc("CreateSolidBrush")
	procSetBkMode             = bannerGdi32.NewProc("SetBkMode")
	procSetTextColor          = bannerGdi32.NewProc("SetTextColor")
)

const (
	bwsPopup          = 0x80000000
	bwsExTopmost      = 0x00000008
	bwsExToolwindow   = 0x00000080
	bwsExNoactivate   = 0x08000000
	bwsExLayered      = 0x00080000
	bwmDestroy        = 0x0002
	bwmPaint          = 0x000F
	bwmClose          = 0x0010
	bswShowNoactivate = 4
	bsmCxScreen       = 0
	bdtCenter         = 0x0001
	bdtVCenter        = 0x0004
	bdtSingleline     = 0x0020
	bLWAAlpha         = 0x00000002
	bTransparentBk    = 1

	bannerBgColor   = 0x002D2D2D // COLORREF 0x00BBGGRR — dark grey
	bannerTextColor = 0x00FFFFFF // white
	bannerAlpha     = 230
	bannerWidth     = 460
	bannerHeight    = 34

	// bannerCreateTimeout bounds the wait for bannerWindowLoop to hand back its
	// window handle. showBannerOS is called with bannerOpMu held (see banner.go);
	// without a bound, a hang in native window creation would wedge the banner
	// subsystem forever.
	bannerCreateTimeout = 5 * time.Second
)

var (
	bannerMu       sync.Mutex
	bannerHwnd     uintptr
	bannerLabelU16 []uint16
	bannerClassReg sync.Once
)

type bannerRect struct{ left, top, right, bottom int32 }

type bannerMsg struct {
	hwnd    uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	ptX     int32
	ptY     int32
}

type bannerPaintStruct struct {
	hdc         uintptr
	fErase      int32
	rcPaint     bannerRect
	fRestore    int32
	fIncUpdate  int32
	rgbReserved [32]byte
}

type bannerWndClassEx struct {
	cbSize        uint32
	style         uint32
	lpfnWndProc   uintptr
	cbClsExtra    int32
	cbWndExtra    int32
	hInstance     uintptr
	hIcon         uintptr
	hCursor       uintptr
	hbrBackground uintptr
	lpszMenuName  *uint16
	lpszClassName *uint16
	hIconSm       uintptr
}

func bannerWndProc(hwnd uintptr, msg uint32, wParam, lParam uintptr) uintptr {
	switch msg {
	case bwmPaint:
		var ps bannerPaintStruct
		hdc, _, _ := procBeginPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
		if hdc != 0 {
			var rc bannerRect
			procGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&rc)))
			procSetBkMode.Call(hdc, bTransparentBk)
			procSetTextColor.Call(hdc, bannerTextColor)
			bannerMu.Lock()
			label := bannerLabelU16
			bannerMu.Unlock()
			if len(label) > 0 {
				// -1: exclude the NUL terminator UTF16FromString appends.
				procDrawTextW.Call(hdc, uintptr(unsafe.Pointer(&label[0])), uintptr(len(label)-1),
					uintptr(unsafe.Pointer(&rc)), bdtCenter|bdtVCenter|bdtSingleline)
			}
			procEndPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
		}
		return 0
	case bwmClose:
		procDestroyWindow.Call(hwnd)
		return 0
	case bwmDestroy:
		procPostQuitMessage.Call(0)
		return 0
	}
	ret, _, _ := procDefWindowProcW.Call(hwnd, uintptr(msg), wParam, lParam)
	return ret
}

func registerBannerClass() {
	bannerClassReg.Do(func() {
		hInst, _, _ := procGetModuleHandleW.Call(0)
		brush, _, _ := procCreateSolidBrush.Call(bannerBgColor)
		className, _ := syscall.UTF16PtrFromString("BreezeSessionBanner")
		wc := bannerWndClassEx{
			cbSize:        uint32(unsafe.Sizeof(bannerWndClassEx{})),
			lpfnWndProc:   syscall.NewCallback(bannerWndProc),
			hInstance:     hInst,
			hbrBackground: brush,
			lpszClassName: className,
		}
		procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))
	})
}

// showBannerOS shows (or relabels) the banner window. The window lives on a
// dedicated locked OS thread running its own message loop; hide posts WM_CLOSE.
func showBannerOS(label string) bool {
	u16, err := syscall.UTF16FromString(label)
	if err != nil {
		return false
	}
	bannerMu.Lock()
	bannerLabelU16 = u16
	if bannerHwnd != 0 {
		hwnd := bannerHwnd
		bannerMu.Unlock()
		procInvalidateRect.Call(hwnd, 0, 1)
		return true
	}
	bannerMu.Unlock()

	// ready is unbuffered: bannerWindowLoop's handoff select (see below) only
	// succeeds if showBannerOS is actively receiving, which is what makes the
	// abandon guard atomic with the show — see bannerWindowLoop's doc comment.
	ready := make(chan uintptr)
	abandoned := make(chan struct{})
	go bannerWindowLoop(ready, abandoned)
	var hwnd uintptr
	select {
	case hwnd = <-ready:
	case <-time.After(bannerCreateTimeout):
		log.Warn("banner window creation timed out", "timeout", bannerCreateTimeout)
		close(abandoned)
		return false
	}
	if hwnd == 0 {
		return false
	}
	bannerMu.Lock()
	bannerHwnd = hwnd
	bannerMu.Unlock()
	return true
}

func hideBannerOS() {
	bannerMu.Lock()
	hwnd := bannerHwnd
	bannerHwnd = 0
	bannerMu.Unlock()
	if hwnd != 0 {
		procPostMessageW.Call(hwnd, bwmClose, 0, 0)
	}
}

// bannerWindowLoop creates the banner window and pumps its message loop.
// abandoned is closed by showBannerOS if it gave up waiting on ready (the
// bannerCreateTimeout elapsed). The handle handoff (ready <- hwnd) and the
// abandon check happen in a SINGLE select, and ready is unbuffered — so the
// send only succeeds if showBannerOS is actively receiving. This makes "did
// the caller commit to this window" atomic: the window is only shown (and
// its handle stored in bannerHwnd by showBannerOS) after the caller has
// actually received it, so a late-creating window can never leak as an
// unclosable, unmanaged topmost pill. It's either fully handed off and shown,
// or destroyed here without ever being made visible.
func bannerWindowLoop(ready chan<- uintptr, abandoned <-chan struct{}) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	registerBannerClass()
	screenW, _, _ := procGetSystemMetrics.Call(bsmCxScreen)
	x := (int32(screenW) - bannerWidth) / 2
	if x < 0 {
		x = 0
	}
	className, _ := syscall.UTF16PtrFromString("BreezeSessionBanner")
	title, _ := syscall.UTF16PtrFromString("Remote session active")
	hInst, _, _ := procGetModuleHandleW.Call(0)
	hwnd, _, _ := procCreateWindowExW.Call(
		bwsExTopmost|bwsExToolwindow|bwsExNoactivate|bwsExLayered,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(title)),
		bwsPopup,
		uintptr(x), 0, bannerWidth, bannerHeight,
		0, 0, hInst, 0,
	)
	if hwnd == 0 {
		select {
		case ready <- 0:
		case <-abandoned:
		}
		return
	}

	// Hand off the handle and check for abandonment in one select. Because
	// ready is unbuffered, the "ready <- hwnd" case can only proceed if
	// showBannerOS is still on the receiving end of it; if showBannerOS
	// already took its bannerCreateTimeout branch and closed abandoned, this
	// send permanently blocks and the select takes the <-abandoned case
	// instead. That means the window is destroyed here WITHOUT ever being
	// shown — there's no window between "caller gave up" and "we notice" for
	// a race to slip through.
	select {
	case ready <- hwnd:
		// The caller committed to receiving this handle (and will store it in
		// bannerHwnd), so it's now safe to make the window visible.
	case <-abandoned:
		procDestroyWindow.Call(hwnd)
		return
	}
	procSetLayeredWindowAttrs.Call(hwnd, 0, bannerAlpha, bLWAAlpha)
	procShowWindow.Call(hwnd, bswShowNoactivate)

	var msg bannerMsg
	for {
		ret, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
		if ret == 0 || int32(ret) == -1 { // WM_QUIT or error
			return
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&msg)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&msg)))
	}
}
