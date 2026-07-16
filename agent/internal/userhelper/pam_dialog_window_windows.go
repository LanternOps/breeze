//go:build windows

package userhelper

import (
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// Custom Win32 elevation prompt. Replaces the bare MessageBoxW with a
// purpose-built window: shield icon + headline, an aligned field grid
// (program / signer / user / command line), a live expiry countdown with a
// progress bar, and Deny (default) / Approve buttons. Rendering is raw
// user32/gdi32 only — no WebView, no COM — so it stays legal on the Winlogon
// secure desktop, where the caller has already attached this OS thread
// (showPamDialogOnInputDesktop). Every failure path returns ok=false so the
// caller can fall back to the MessageBox rendering.

var (
	pamDialogGdi32 = syscall.NewLazyDLL("gdi32.dll")

	procPamRegisterClassExW    = pamDialogUser32.NewProc("RegisterClassExW")
	procPamCreateWindowExW     = pamDialogUser32.NewProc("CreateWindowExW")
	procPamDefWindowProcW      = pamDialogUser32.NewProc("DefWindowProcW")
	procPamDestroyWindow       = pamDialogUser32.NewProc("DestroyWindow")
	procPamGetMessageW         = pamDialogUser32.NewProc("GetMessageW")
	procPamTranslateMessage    = pamDialogUser32.NewProc("TranslateMessage")
	procPamDispatchMessageW    = pamDialogUser32.NewProc("DispatchMessageW")
	procPamPostQuitMessage     = pamDialogUser32.NewProc("PostQuitMessage")
	procPamIsDialogMessageW    = pamDialogUser32.NewProc("IsDialogMessageW")
	procPamSetTimer            = pamDialogUser32.NewProc("SetTimer")
	procPamKillTimer           = pamDialogUser32.NewProc("KillTimer")
	procPamInvalidateRect      = pamDialogUser32.NewProc("InvalidateRect")
	procPamBeginPaint          = pamDialogUser32.NewProc("BeginPaint")
	procPamEndPaint            = pamDialogUser32.NewProc("EndPaint")
	procPamDrawTextW           = pamDialogUser32.NewProc("DrawTextW")
	procPamFillRect            = pamDialogUser32.NewProc("FillRect")
	procPamSetFocus            = pamDialogUser32.NewProc("SetFocus")
	procPamGetSystemMetrics    = pamDialogUser32.NewProc("GetSystemMetrics")
	procPamLoadCursorW         = pamDialogUser32.NewProc("LoadCursorW")
	procPamLoadIconW           = pamDialogUser32.NewProc("LoadIconW")
	procPamDrawIconEx          = pamDialogUser32.NewProc("DrawIconEx")
	procPamSendMessageW        = pamDialogUser32.NewProc("SendMessageW")
	procPamSetWindowLongPtrW   = pamDialogUser32.NewProc("SetWindowLongPtrW")
	procPamGetWindowLongPtrW   = pamDialogUser32.NewProc("GetWindowLongPtrW")
	procPamSetForegroundWindow = pamDialogUser32.NewProc("SetForegroundWindow")
	procPamShowWindow          = pamDialogUser32.NewProc("ShowWindow")
	procPamAdjustWindowRectEx  = pamDialogUser32.NewProc("AdjustWindowRectEx")
	procPamGetDpiForSystem     = pamDialogUser32.NewProc("GetDpiForSystem")
	procPamGetDC               = pamDialogUser32.NewProc("GetDC")
	procPamReleaseDC           = pamDialogUser32.NewProc("ReleaseDC")
	procPamGetModuleHandleW    = pamDialogKernel32.NewProc("GetModuleHandleW")

	procPamCreateSolidBrush = pamDialogGdi32.NewProc("CreateSolidBrush")
	procPamDeleteObject     = pamDialogGdi32.NewProc("DeleteObject")
	procPamCreateFontW      = pamDialogGdi32.NewProc("CreateFontW")
	procPamSelectObject     = pamDialogGdi32.NewProc("SelectObject")
	procPamSetBkMode        = pamDialogGdi32.NewProc("SetBkMode")
	procPamSetTextColor     = pamDialogGdi32.NewProc("SetTextColor")
	procPamGetDeviceCaps    = pamDialogGdi32.NewProc("GetDeviceCaps")
)

const (
	pamWndClassName = "BreezePamElevationDialog"

	pamWSVisible       = 0x10000000
	pamWSChild         = 0x40000000
	pamWSTabStop       = 0x00010000
	pamWSCaption       = 0x00C00000
	pamWSSysMenu       = 0x00080000
	pamWSPopup         = 0x80000000
	pamWSExTopMost     = 0x00000008
	pamWSExDlgModal    = 0x00000001 // WS_EX_DLGMODALFRAME
	pamBSDefPushButton = 0x00000001

	pamWMDestroy    = 0x0002
	pamWMClose      = 0x0010
	pamWMPaint      = 0x000F
	pamWMCommand    = 0x0111
	pamWMTimer      = 0x0113
	pamWMSetFont    = 0x0030
	pamDMGetDefID   = 0x0400 // WM_USER + 0
	pamDCHasDefID   = 0x534B
	pamGWLPUserData = ^uintptr(21) + 1 // -21 as uintptr (GWLP_USERDATA)

	pamIDDeny    = 100
	pamIDApprove = 101
	pamIDCancel  = 2 // IDCANCEL, synthesized by IsDialogMessageW on Esc

	pamCountdownTimerID = 1
	pamCountdownTickMs  = 200

	pamDTSingleLine  = 0x0020
	pamDTVCenter     = 0x0004
	pamDTEndEllipsis = 0x8000
	pamDTNoPrefix    = 0x0800

	pamTransparent = 1

	pamColorWindowBrush = 6 // COLOR_WINDOW + 1 class background

	pamSMCxScreen = 0
	pamSMCyScreen = 1

	pamIDCArrow  = 32512
	pamIDIShield = 32518 // IDI_SHIELD

	pamDINormal      = 3
	pamLogPixelsY    = 90
	pamClearTypeQual = 5
	pamDefaultChar   = 1

	pamErrorClassAlreadyExists = 1410
)

type pamRect struct{ left, top, right, bottom int32 }

type pamPoint struct{ x, y int32 }

type pamMsg struct {
	hwnd    uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      pamPoint
}

type pamWndClassExW struct {
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

type pamPaintStruct struct {
	hdc         uintptr
	fErase      int32
	rcPaint     pamRect
	fRestore    int32
	fIncUpdate  int32
	rgbReserved [32]byte
}

// pamDialogState carries everything the wndproc needs. States are registered
// in a package map keyed by a small integer id (passed through CREATESTRUCT
// and stashed in GWLP_USERDATA) so no Go pointer ever round-trips through
// Win32 memory.
type pamDialogState struct {
	result   ipc.PamDialogResult
	decided  bool
	deadline time.Time
	total    time.Duration

	headline []uint16
	subline  []uint16
	fields   []pamDialogField

	dpi        int
	width      int32
	height     int32
	fieldTop   int32
	countTop   int32
	hasCount   bool
	labelWidth int32
	margin     int32

	fontTitle uintptr
	fontBody  uintptr
	fontLabel uintptr
	shield    uintptr

	hwndDeny    uintptr
	hwndApprove uintptr
}

var (
	pamDialogStatesMu sync.Mutex
	pamDialogStates   = map[uintptr]*pamDialogState{}
	pamDialogNextID   uintptr = 1

	pamWndProcCallback uintptr
	pamWndProcOnce     sync.Once
	pamClassRegistered atomic.Bool
)

func pamRegisterState(state *pamDialogState) uintptr {
	pamDialogStatesMu.Lock()
	defer pamDialogStatesMu.Unlock()
	id := pamDialogNextID
	pamDialogNextID++
	pamDialogStates[id] = state
	return id
}

func pamLookupState(hwnd uintptr) *pamDialogState {
	id, _, _ := procPamGetWindowLongPtrW.Call(hwnd, pamGWLPUserData)
	if id == 0 {
		return nil
	}
	pamDialogStatesMu.Lock()
	defer pamDialogStatesMu.Unlock()
	return pamDialogStates[id]
}

func pamReleaseState(id uintptr) {
	pamDialogStatesMu.Lock()
	defer pamDialogStatesMu.Unlock()
	delete(pamDialogStates, id)
}

// pamScale converts 96-dpi design units into device pixels.
func (s *pamDialogState) scale(v int32) int32 {
	return int32((int(v)*s.dpi + 48) / 96)
}

func pamSystemDPI() int {
	if err := procPamGetDpiForSystem.Find(); err == nil {
		if dpi, _, _ := procPamGetDpiForSystem.Call(); dpi != 0 {
			return int(dpi)
		}
	}
	hdc, _, _ := procPamGetDC.Call(0)
	if hdc != 0 {
		defer procPamReleaseDC.Call(0, hdc)
		if dpi, _, _ := procPamGetDeviceCaps.Call(hdc, pamLogPixelsY); dpi != 0 {
			return int(dpi)
		}
	}
	return 96
}

func pamRGB(r, g, b uint32) uintptr {
	return uintptr(r | g<<8 | b<<16)
}

// Palette: white surface, near-black ink, gray secondary, Breeze slate-blue
// accent (matches the web console primary), light gray hairlines.
var (
	pamColInk    = pamRGB(24, 30, 46)
	pamColGray   = pamRGB(101, 109, 126)
	pamColAccent = pamRGB(46, 82, 199)
	pamColTrack  = pamRGB(229, 231, 235)
)

func pamUTF16(s string) []uint16 {
	u, err := syscall.UTF16FromString(s)
	if err != nil {
		u, _ = syscall.UTF16FromString("Unknown")
	}
	return u
}

func pamCreateFont(pt int32, weight int32, dpi int) uintptr {
	height := -int32((int(pt)*dpi + 36) / 72)
	face := pamUTF16("Segoe UI")
	font, _, _ := procPamCreateFontW.Call(
		uintptr(height), 0, 0, 0,
		uintptr(weight),
		0, 0, 0,
		pamDefaultChar, 0, 0,
		pamClearTypeQual, 0,
		uintptr(unsafe.Pointer(&face[0])),
	)
	return font
}

func pamEnsureWndProc() uintptr {
	pamWndProcOnce.Do(func() {
		pamWndProcCallback = syscall.NewCallback(pamWndProc)
	})
	return pamWndProcCallback
}

func pamEnsureClass(hInstance uintptr) bool {
	if pamClassRegistered.Load() {
		return true
	}
	cursor, _, _ := procPamLoadCursorW.Call(0, pamIDCArrow)
	className := pamUTF16(pamWndClassName)
	wc := pamWndClassExW{
		cbSize:        uint32(unsafe.Sizeof(pamWndClassExW{})),
		lpfnWndProc:   pamEnsureWndProc(),
		hInstance:     hInstance,
		hCursor:       cursor,
		hbrBackground: pamColorWindowBrush,
		lpszClassName: &className[0],
	}
	atom, _, callErr := procPamRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))
	if atom == 0 {
		if errno, ok := callErr.(syscall.Errno); ok && errno == pamErrorClassAlreadyExists {
			pamClassRegistered.Store(true)
			return true
		}
		log.Warn("pam: RegisterClassExW failed", "error", callErr.Error())
		return false
	}
	pamClassRegistered.Store(true)
	return true
}

// showPamDialogWindow renders the custom elevation prompt on the calling
// thread's current desktop. ok=false means the window could not be created
// and the caller should fall back to the MessageBox rendering.
func showPamDialogWindow(req ipc.PamRequestDialog) (result ipc.PamDialogResult, ok bool) {
	defer func() {
		if r := recover(); r != nil {
			log.Error("pam: custom elevation dialog panicked; falling back to MessageBox", "panic", r)
			result, ok = ipc.PamDialogResult{}, false
		}
	}()

	hInstance, _, _ := procPamGetModuleHandleW.Call(0)
	if hInstance == 0 || !pamEnsureClass(hInstance) {
		return ipc.PamDialogResult{}, false
	}

	state := &pamDialogState{
		dpi:      pamSystemDPI(),
		headline: pamUTF16(pamDialogHeadline(req)),
		subline:  pamUTF16("Breeze intercepted an elevation request on this device."),
		fields:   pamDialogFields(req),
		hasCount: req.TimeoutSeconds > 0,
	}
	if state.hasCount {
		state.total = time.Duration(req.TimeoutSeconds) * time.Second
		state.deadline = time.Now().Add(state.total)
	}
	// Deny is the safe default for any exit that never reaches WM_COMMAND.
	state.result = ipc.PamDialogResult{Approved: false, DismissedByUser: true}

	// Layout (96-dpi units, scaled at draw/create time).
	const (
		designWidth  = 520
		margin       = 24
		headerH      = 56 // icon + headline + subline block
		fieldRowH    = 26
		countBlockH  = 34 // countdown text + progress bar
		buttonH      = 30
		buttonW      = 104
		footerGap    = 20
		sectionGap   = 14
	)
	state.margin = state.scale(margin)
	state.labelWidth = state.scale(110)
	state.width = state.scale(designWidth)
	state.fieldTop = state.scale(margin + headerH + sectionGap)
	fieldsH := int32(len(state.fields)) * state.scale(fieldRowH)
	state.countTop = state.fieldTop + fieldsH + state.scale(sectionGap)
	clientH := state.countTop + state.scale(footerGap) + state.scale(buttonH) + state.scale(margin)
	if state.hasCount {
		clientH += state.scale(countBlockH)
	}
	state.height = clientH

	state.fontTitle = pamCreateFont(13, 600, state.dpi)
	state.fontBody = pamCreateFont(9, 400, state.dpi)
	state.fontLabel = pamCreateFont(9, 600, state.dpi)
	defer func() {
		procPamDeleteObject.Call(state.fontTitle)
		procPamDeleteObject.Call(state.fontBody)
		procPamDeleteObject.Call(state.fontLabel)
	}()
	state.shield, _, _ = procPamLoadIconW.Call(0, pamIDIShield)

	stateID := pamRegisterState(state)
	defer pamReleaseState(stateID)

	// Compute the outer window size for the desired client area and center it.
	rect := pamRect{0, 0, state.width, clientH}
	style := uintptr(pamWSPopup | pamWSCaption | pamWSSysMenu)
	exStyle := uintptr(pamWSExTopMost | pamWSExDlgModal)
	procPamAdjustWindowRectEx.Call(uintptr(unsafe.Pointer(&rect)), style, 0, exStyle)
	outerW := rect.right - rect.left
	outerH := rect.bottom - rect.top
	screenW, _, _ := procPamGetSystemMetrics.Call(pamSMCxScreen)
	screenH, _, _ := procPamGetSystemMetrics.Call(pamSMCyScreen)
	x := (int32(screenW) - outerW) / 2
	y := (int32(screenH) - outerH) / 2
	if x < 0 {
		x = 0
	}
	if y < 0 {
		y = 0
	}

	className := pamUTF16(pamWndClassName)
	title := pamUTF16(pamDialogTitle)
	hwnd, _, callErr := procPamCreateWindowExW.Call(
		exStyle,
		uintptr(unsafe.Pointer(&className[0])),
		uintptr(unsafe.Pointer(&title[0])),
		style,
		uintptr(x), uintptr(y), uintptr(outerW), uintptr(outerH),
		0, 0, hInstance,
		0,
	)
	if hwnd == 0 {
		log.Warn("pam: CreateWindowExW failed for elevation dialog", "error", callErr.Error())
		return ipc.PamDialogResult{}, false
	}
	// Attach the state id before any message that needs it can arrive: the
	// window is not yet visible, the buttons/timer don't exist yet, and the
	// wndproc treats a missing state as DefWindowProc.
	procPamSetWindowLongPtrW.Call(hwnd, pamGWLPUserData, stateID)

	if !pamCreateButtons(hwnd, hInstance, state) {
		procPamDestroyWindow.Call(hwnd)
		return ipc.PamDialogResult{}, false
	}

	if state.hasCount {
		procPamSetTimer.Call(hwnd, pamCountdownTimerID, pamCountdownTickMs, 0)
	}

	procPamShowWindow.Call(hwnd, 5 /* SW_SHOW */)
	procPamSetForegroundWindow.Call(hwnd)
	procPamSetFocus.Call(state.hwndDeny)

	var msg pamMsg
	for {
		r, _, _ := procPamGetMessageW.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
		if r == 0 || r == ^uintptr(0) { // WM_QUIT or error
			break
		}
		if isDlg, _, _ := procPamIsDialogMessageW.Call(hwnd, uintptr(unsafe.Pointer(&msg))); isDlg != 0 {
			continue
		}
		procPamTranslateMessage.Call(uintptr(unsafe.Pointer(&msg)))
		procPamDispatchMessageW.Call(uintptr(unsafe.Pointer(&msg)))
	}

	return state.result, true
}

func pamCreateButtons(hwnd, hInstance uintptr, state *pamDialogState) bool {
	buttonW := state.scale(104)
	buttonH := state.scale(30)
	gap := state.scale(8)
	y := state.height - state.margin - buttonH
	approveX := state.width - state.margin - buttonW
	denyX := approveX - gap - buttonW

	buttonClass := pamUTF16("BUTTON")
	denyLabel := pamUTF16("&Deny")
	approveLabel := pamUTF16("&Approve")

	deny, _, _ := procPamCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(&buttonClass[0])),
		uintptr(unsafe.Pointer(&denyLabel[0])),
		pamWSChild|pamWSVisible|pamWSTabStop|pamBSDefPushButton,
		uintptr(denyX), uintptr(y), uintptr(buttonW), uintptr(buttonH),
		hwnd, pamIDDeny, hInstance, 0,
	)
	approve, _, _ := procPamCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(&buttonClass[0])),
		uintptr(unsafe.Pointer(&approveLabel[0])),
		pamWSChild|pamWSVisible|pamWSTabStop,
		uintptr(approveX), uintptr(y), uintptr(buttonW), uintptr(buttonH),
		hwnd, pamIDApprove, hInstance, 0,
	)
	if deny == 0 || approve == 0 {
		log.Warn("pam: failed to create elevation dialog buttons")
		return false
	}
	procPamSendMessageW.Call(deny, pamWMSetFont, state.fontBody, 1)
	procPamSendMessageW.Call(approve, pamWMSetFont, state.fontBody, 1)
	state.hwndDeny = deny
	state.hwndApprove = approve
	return true
}

func pamWndProc(hwnd, msg, wparam, lparam uintptr) uintptr {
	switch msg {
	case pamWMCommand:
		state := pamLookupState(hwnd)
		if state == nil {
			return 0
		}
		switch wparam & 0xFFFF {
		case pamIDApprove:
			state.setResult(ipc.PamDialogResult{Approved: true})
			procPamDestroyWindow.Call(hwnd)
		case pamIDDeny, pamIDCancel:
			state.setResult(ipc.PamDialogResult{Approved: false, DismissedByUser: true})
			procPamDestroyWindow.Call(hwnd)
		}
		return 0

	case pamWMClose:
		if state := pamLookupState(hwnd); state != nil {
			state.setResult(ipc.PamDialogResult{Approved: false, DismissedByUser: true})
		}
		procPamDestroyWindow.Call(hwnd)
		return 0

	case pamWMTimer:
		state := pamLookupState(hwnd)
		if state == nil || !state.hasCount {
			return 0
		}
		if time.Until(state.deadline) <= 0 {
			// Broker-side the request is already being denied on timeout;
			// DismissedByUser=false records that no human answered.
			state.setResult(ipc.PamDialogResult{Approved: false, DismissedByUser: false})
			procPamDestroyWindow.Call(hwnd)
			return 0
		}
		rect := pamRect{state.margin, state.countTop, state.width - state.margin, state.countTop + state.scale(34)}
		procPamInvalidateRect.Call(hwnd, uintptr(unsafe.Pointer(&rect)), 1)
		return 0

	case pamDMGetDefID:
		return pamDCHasDefID<<16 | pamIDDeny

	case pamWMPaint:
		if state := pamLookupState(hwnd); state != nil {
			pamPaint(hwnd, state)
			return 0
		}

	case pamWMDestroy:
		procPamKillTimer.Call(hwnd, pamCountdownTimerID)
		procPamPostQuitMessage.Call(0)
		return 0
	}
	ret, _, _ := procPamDefWindowProcW.Call(hwnd, msg, wparam, lparam)
	return ret
}

func (s *pamDialogState) setResult(result ipc.PamDialogResult) {
	if s.decided {
		return
	}
	s.decided = true
	s.result = result
}

func pamDrawText(hdc uintptr, text []uint16, rect *pamRect, font uintptr, color uintptr, flags uintptr) {
	if len(text) == 0 {
		return
	}
	procPamSelectObject.Call(hdc, font)
	procPamSetTextColor.Call(hdc, color)
	procPamDrawTextW.Call(hdc, uintptr(unsafe.Pointer(&text[0])), uintptr(len(text)-1), uintptr(unsafe.Pointer(rect)), flags)
}

func pamFill(hdc uintptr, rect pamRect, color uintptr) {
	brush, _, _ := procPamCreateSolidBrush.Call(color)
	if brush == 0 {
		return
	}
	procPamFillRect.Call(hdc, uintptr(unsafe.Pointer(&rect)), brush)
	procPamDeleteObject.Call(brush)
}

func pamPaint(hwnd uintptr, state *pamDialogState) {
	var ps pamPaintStruct
	hdc, _, _ := procPamBeginPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
	if hdc == 0 {
		return
	}
	defer procPamEndPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))

	procPamSetBkMode.Call(hdc, pamTransparent)

	m := state.margin
	iconSize := state.scale(32)
	textX := m + iconSize + state.scale(14)

	// Shield icon + headline + subline.
	if state.shield != 0 {
		procPamDrawIconEx.Call(hdc, uintptr(m), uintptr(m), state.shield, uintptr(iconSize), uintptr(iconSize), 0, 0, pamDINormal)
	}
	headRect := pamRect{textX, m - state.scale(2), state.width - m, m + state.scale(24)}
	pamDrawText(hdc, state.headline, &headRect, state.fontTitle, pamColInk, pamDTSingleLine|pamDTEndEllipsis|pamDTNoPrefix)
	subRect := pamRect{textX, m + state.scale(26), state.width - m, m + state.scale(46)}
	pamDrawText(hdc, state.subline, &subRect, state.fontBody, pamColGray, pamDTSingleLine|pamDTEndEllipsis|pamDTNoPrefix)

	// Hairline between header and fields.
	sepY := state.fieldTop - state.scale(8)
	pamFill(hdc, pamRect{m, sepY, state.width - m, sepY + 1}, pamColTrack)

	// Field grid: gray label column, ink value column with ellipsis.
	rowH := state.scale(26)
	for i, field := range state.fields {
		top := state.fieldTop + int32(i)*rowH
		labelRect := pamRect{m, top, m + state.labelWidth, top + rowH}
		valueRect := pamRect{m + state.labelWidth, top, state.width - m, top + rowH}
		label := pamUTF16(field.Label)
		value := pamUTF16(field.Value)
		pamDrawText(hdc, label, &labelRect, state.fontLabel, pamColGray, pamDTSingleLine|pamDTVCenter|pamDTNoPrefix)
		pamDrawText(hdc, value, &valueRect, state.fontBody, pamColInk, pamDTSingleLine|pamDTVCenter|pamDTEndEllipsis|pamDTNoPrefix)
	}

	// Countdown text + proportional progress bar.
	if state.hasCount {
		remaining := time.Until(state.deadline)
		if remaining < 0 {
			remaining = 0
		}
		countRect := pamRect{m, state.countTop, state.width - m, state.countTop + state.scale(18)}
		countdown := pamUTF16("Expires in " + formatPamCountdown(remaining))
		pamDrawText(hdc, countdown, &countRect, state.fontBody, pamColGray, pamDTSingleLine|pamDTNoPrefix)

		barTop := state.countTop + state.scale(22)
		barRect := pamRect{m, barTop, state.width - m, barTop + state.scale(6)}
		pamFill(hdc, barRect, pamColTrack)
		if state.total > 0 {
			frac := float64(remaining) / float64(state.total)
			if frac < 0 {
				frac = 0
			}
			if frac > 1 {
				frac = 1
			}
			fillRect := barRect
			fillRect.right = barRect.left + int32(float64(barRect.right-barRect.left)*frac)
			pamFill(hdc, fillRect, pamColAccent)
		}
	}
}
