//go:build windows

package userhelper

import (
	"fmt"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// A borderless, always-on-top, non-activating, click-through pill pinned
// top-center showing "● Billy from Olive Technology is connected · 12:04".
// Pure user32/gdi32 syscalls — the user-helper ships CGO_ENABLED=0. Segoe UI
// text, a green live dot, and an elapsed-session clock (1s repaint timer);
// the pill is sized to its label and DPI-scaled, with fully rounded ends via
// a window region. WS_EX_TRANSPARENT makes it hit-test invisible so it can
// never swallow clicks on whatever sits underneath it.

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
	procBannerSetWindowPos    = pamDialogUser32.NewProc("SetWindowPos")
	procBannerSetWindowRgn    = pamDialogUser32.NewProc("SetWindowRgn")
	procBannerGetDC           = pamDialogUser32.NewProc("GetDC")
	procBannerReleaseDC       = pamDialogUser32.NewProc("ReleaseDC")
	procBannerSetTimer        = pamDialogUser32.NewProc("SetTimer")
	procGetModuleHandleW      = syscall.NewLazyDLL("kernel32.dll").NewProc("GetModuleHandleW")

	procCreateSolidBrush      = bannerGdi32.NewProc("CreateSolidBrush")
	procSetBkMode             = bannerGdi32.NewProc("SetBkMode")
	procSetTextColor          = bannerGdi32.NewProc("SetTextColor")
	procBannerCreateFontW     = bannerGdi32.NewProc("CreateFontW")
	procBannerSelectObject    = bannerGdi32.NewProc("SelectObject")
	procBannerDeleteObject    = bannerGdi32.NewProc("DeleteObject")
	procBannerEllipse         = bannerGdi32.NewProc("Ellipse")
	procBannerGetStockObject  = bannerGdi32.NewProc("GetStockObject")
	procBannerCreateRoundRgn  = bannerGdi32.NewProc("CreateRoundRectRgn")
)

const (
	bwsPopup          = 0x80000000
	bwsExTopmost      = 0x00000008
	bwsExToolwindow   = 0x00000080
	bwsExNoactivate   = 0x08000000
	bwsExLayered      = 0x00080000
	bwsExTransparent  = 0x00000020 // hit-test invisible: clicks pass through
	bwmDestroy        = 0x0002
	bwmPaint          = 0x000F
	bwmClose          = 0x0010
	bwmTimer          = 0x0113
	bswShowNoactivate = 4
	bsmCxScreen       = 0
	bdtVCenter        = 0x0004
	bdtSingleline     = 0x0020
	bdtNoPrefix       = 0x0800
	bdtCalcRect       = 0x0400
	bLWAAlpha         = 0x00000002
	bTransparentBk    = 1
	bNullPen          = 8 // GetStockObject(NULL_PEN)
	bSwpNoactivate    = 0x0010
	bSwpNozorder      = 0x0004

	// Colors are COLORREF 0x00BBGGRR.
	bannerBgColor   = 0x00261C18 // charcoal RGB(24,28,38)
	bannerTextColor = 0x00F6F4EE // near-white RGB(238,244,246)
	bannerTimeColor = 0x00BEAEA8 // muted RGB(168,174,190)
	bannerDotColor  = 0x0059C734 // live green RGB(52,199,89)
	bannerAlpha     = 235

	bannerTimerID     = 1
	bannerTimerTickMs = 1000

	// bannerCreateTimeout bounds the wait for bannerWindowLoop to hand back its
	// window handle. showBannerOS is called with bannerOpMu held (see banner.go);
	// without a bound, a hang in native window creation would wedge the banner
	// subsystem forever.
	bannerCreateTimeout = 5 * time.Second
)

var (
	bannerMu        sync.Mutex
	bannerHwnd      uintptr
	bannerLabelU16  []uint16
	bannerStartedMs int64 // session start (unix ms); 0 hides the elapsed clock
	bannerFont      uintptr
	bannerClassReg  sync.Once
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

// bannerScale converts 96-dpi design units into device pixels.
func bannerScale(v int32) int32 {
	return int32((int(v)*pamSystemDPI() + 48) / 96)
}

// bannerElapsed renders the elapsed session time as M:SS / H:MM:SS.
func bannerElapsed(startedMs int64) string {
	if startedMs <= 0 {
		return ""
	}
	d := time.Since(time.UnixMilli(startedMs))
	if d < 0 {
		d = 0
	}
	total := int(d / time.Second)
	if total >= 3600 {
		return fmt.Sprintf("%d:%02d:%02d", total/3600, (total%3600)/60, total%60)
	}
	return fmt.Sprintf("%d:%02d", total/60, total%60)
}

func bannerEnsureFont() uintptr {
	bannerMu.Lock()
	font := bannerFont
	bannerMu.Unlock()
	if font != 0 {
		return font
	}
	// 10pt Segoe UI semibold-ish (600) reads clearly at the pill's size.
	height := -int32((10*pamSystemDPI() + 36) / 72)
	face, _ := syscall.UTF16FromString("Segoe UI")
	font, _, _ = procBannerCreateFontW.Call(
		uintptr(height), 0, 0, 0,
		600,           // weight
		0, 0, 0,
		1, 0, 0,       // DEFAULT_CHARSET
		5, 0,          // CLEARTYPE_QUALITY
		uintptr(unsafe.Pointer(&face[0])),
	)
	bannerMu.Lock()
	bannerFont = font
	bannerMu.Unlock()
	return font
}

// bannerMeasureLabel returns the pixel width of the label in the banner font.
func bannerMeasureLabel(hwnd uintptr, label []uint16) int32 {
	if len(label) <= 1 {
		return 0
	}
	hdc, _, _ := procBannerGetDC.Call(hwnd)
	if hdc == 0 {
		return 0
	}
	defer procBannerReleaseDC.Call(hwnd, hdc)
	prev, _, _ := procBannerSelectObject.Call(hdc, bannerEnsureFont())
	defer procBannerSelectObject.Call(hdc, prev)
	rc := bannerRect{0, 0, 0, 0}
	procPamDrawTextW.Call(hdc, uintptr(unsafe.Pointer(&label[0])), uintptr(len(label)-1),
		uintptr(unsafe.Pointer(&rc)), bdtCalcRect|bdtSingleline|bdtNoPrefix)
	return rc.right - rc.left
}

// bannerDesiredWidth computes the pill width for a label: dot + gaps + label +
// room for the elapsed clock, clamped to [min, 60% of screen].
func bannerDesiredWidth(hwnd uintptr, label []uint16) int32 {
	pad := bannerScale(16)
	dot := bannerScale(8)
	gap := bannerScale(9)
	clock := bannerScale(64) // " · 0:00:00" budget
	w := pad + dot + gap + bannerMeasureLabel(hwnd, label) + clock + pad
	minW := bannerScale(280)
	if w < minW {
		w = minW
	}
	screenW, _, _ := procGetSystemMetrics.Call(bsmCxScreen)
	maxW := int32(screenW) * 6 / 10
	if maxW > 0 && w > maxW {
		w = maxW
	}
	return w
}

// bannerApplyBounds sizes/positions the pill top-center and rounds its ends.
func bannerApplyBounds(hwnd uintptr, width, height int32) {
	screenW, _, _ := procGetSystemMetrics.Call(bsmCxScreen)
	x := (int32(screenW) - width) / 2
	if x < 0 {
		x = 0
	}
	y := bannerScale(8)
	procBannerSetWindowPos.Call(hwnd, 0, uintptr(x), uintptr(y), uintptr(width), uintptr(height),
		bSwpNozorder|bSwpNoactivate)
	// Full-pill region: corner diameter = height. The window owns the region
	// handle after SetWindowRgn, so no DeleteObject here.
	rgn, _, _ := procBannerCreateRoundRgn.Call(0, 0, uintptr(width+1), uintptr(height+1),
		uintptr(height), uintptr(height))
	if rgn != 0 {
		procBannerSetWindowRgn.Call(hwnd, rgn, 1)
	}
}

func bannerWndProc(hwnd uintptr, msg uint32, wParam, lParam uintptr) uintptr {
	switch msg {
	case bwmPaint:
		bannerPaint(hwnd)
		return 0
	case bwmTimer:
		bannerMu.Lock()
		ticking := bannerStartedMs > 0
		bannerMu.Unlock()
		if ticking {
			procInvalidateRect.Call(hwnd, 0, 1)
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

func bannerPaint(hwnd uintptr) {
	var ps bannerPaintStruct
	hdc, _, _ := procBeginPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
	if hdc == 0 {
		return
	}
	defer procEndPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))

	var rc bannerRect
	procGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&rc)))
	procSetBkMode.Call(hdc, bTransparentBk)

	bannerMu.Lock()
	label := bannerLabelU16
	startedMs := bannerStartedMs
	bannerMu.Unlock()

	prevFont, _, _ := procBannerSelectObject.Call(hdc, bannerEnsureFont())
	defer procBannerSelectObject.Call(hdc, prevFont)

	pad := bannerScale(16)
	dot := bannerScale(8)
	gap := bannerScale(9)
	midY := (rc.bottom - rc.top) / 2

	// Live dot — filled ellipse, no outline.
	dotBrush, _, _ := procCreateSolidBrush.Call(bannerDotColor)
	if dotBrush != 0 {
		nullPen, _, _ := procBannerGetStockObject.Call(bNullPen)
		prevPen, _, _ := procBannerSelectObject.Call(hdc, nullPen)
		prevBrush, _, _ := procBannerSelectObject.Call(hdc, dotBrush)
		procBannerEllipse.Call(hdc, uintptr(pad), uintptr(midY-dot/2), uintptr(pad+dot+1), uintptr(midY+dot/2+1))
		procBannerSelectObject.Call(hdc, prevBrush)
		procBannerSelectObject.Call(hdc, prevPen)
		procBannerDeleteObject.Call(dotBrush)
	}

	// Label, left-aligned after the dot; ellipsized against the clock area.
	clockW := bannerScale(64)
	if len(label) > 0 {
		procSetTextColor.Call(hdc, bannerTextColor)
		textRect := bannerRect{pad + dot + gap, rc.top, rc.right - pad - clockW, rc.bottom}
		procDrawTextW.Call(hdc, uintptr(unsafe.Pointer(&label[0])), uintptr(len(label)-1),
			uintptr(unsafe.Pointer(&textRect)), bdtVCenter|bdtSingleline|bdtNoPrefix|0x8000 /* DT_END_ELLIPSIS */)
	}

	// Elapsed clock, right-aligned and muted.
	if elapsed := bannerElapsed(startedMs); elapsed != "" {
		if u16, err := syscall.UTF16FromString(elapsed); err == nil {
			procSetTextColor.Call(hdc, bannerTimeColor)
			timeRect := bannerRect{rc.right - pad - clockW, rc.top, rc.right - pad, rc.bottom}
			procDrawTextW.Call(hdc, uintptr(unsafe.Pointer(&u16[0])), uintptr(len(u16)-1),
				uintptr(unsafe.Pointer(&timeRect)), bdtVCenter|bdtSingleline|bdtNoPrefix|0x0002 /* DT_RIGHT */)
		}
	}
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
func showBannerOS(label string, startedAtUnixMs int64) bool {
	u16, err := syscall.UTF16FromString(label)
	if err != nil {
		return false
	}
	bannerMu.Lock()
	bannerLabelU16 = u16
	bannerStartedMs = startedAtUnixMs
	if bannerHwnd != 0 {
		hwnd := bannerHwnd
		bannerMu.Unlock()
		// Relabel: re-fit the pill to the new text, then repaint.
		bannerApplyBounds(hwnd, bannerDesiredWidth(hwnd, u16), bannerScale(36))
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
	bannerStartedMs = 0
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
	bannerMu.Lock()
	label := bannerLabelU16
	bannerMu.Unlock()
	height := bannerScale(36)
	width := bannerDesiredWidth(0, label)
	screenW, _, _ := procGetSystemMetrics.Call(bsmCxScreen)
	x := (int32(screenW) - width) / 2
	if x < 0 {
		x = 0
	}
	className, _ := syscall.UTF16PtrFromString("BreezeSessionBanner")
	title, _ := syscall.UTF16PtrFromString("Remote session active")
	hInst, _, _ := procGetModuleHandleW.Call(0)
	hwnd, _, _ := procCreateWindowExW.Call(
		bwsExTopmost|bwsExToolwindow|bwsExNoactivate|bwsExLayered|bwsExTransparent,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(title)),
		bwsPopup,
		uintptr(x), uintptr(bannerScale(8)), uintptr(width), uintptr(height),
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
	// Re-measure with a real DC now that the window exists (the pre-create
	// width used a null-DC measurement that can undershoot).
	bannerApplyBounds(hwnd, bannerDesiredWidth(hwnd, label), height)
	procSetLayeredWindowAttrs.Call(hwnd, 0, bannerAlpha, bLWAAlpha)
	procShowWindow.Call(hwnd, bswShowNoactivate)
	procBannerSetTimer.Call(hwnd, bannerTimerID, bannerTimerTickMs, 0)

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
