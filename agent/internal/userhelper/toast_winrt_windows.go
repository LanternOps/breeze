//go:build windows

package userhelper

import (
	"errors"
	"fmt"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// In-process WinRT toast delivery.
//
// Windows.UI.Notifications is a WinRT API; reaching it from Go means the
// Windows Runtime activation entry points in combase.dll plus raw COM vtable
// calls, in the same pure-syscall style as internal/remote/desktop. Nothing
// here needs cgo, and no child process is created, which is the point: the
// user-helper is a GUI-subsystem binary, so any console child it spawns gets a
// fresh console window that flashes on the interactive desktop (#8876).
//
// Sequence (mirrors the C# ToastNotificationManager sample):
//
//	RoInitialize
//	RoActivateInstance("Windows.Data.Xml.Dom.XmlDocument")  → IXmlDocumentIO::LoadXml
//	RoGetActivationFactory("…ToastNotification")              → IToastNotificationFactory::CreateToastNotification
//	RoGetActivationFactory("…ToastNotificationManager")       → IToastNotificationManagerStatics::CreateToastNotifierWithId
//	IToastNotifier::Show
var (
	modcombase = windows.NewLazySystemDLL("combase.dll")

	procRoInitialize           = modcombase.NewProc("RoInitialize")
	procRoUninitialize         = modcombase.NewProc("RoUninitialize")
	procRoActivateInstance     = modcombase.NewProc("RoActivateInstance")
	procRoGetActivationFactory = modcombase.NewProc("RoGetActivationFactory")
	procWindowsCreateString    = modcombase.NewProc("WindowsCreateString")
	procWindowsDeleteString    = modcombase.NewProc("WindowsDeleteString")
)

const (
	hrOK             = 0x00000000
	hrFalse          = 0x00000001
	hrRPCChangedMode = 0x80010106 // RPC_E_CHANGED_MODE: thread already initialised in the other apartment model

	roInitMultithreaded = 1 // RO_INIT_MULTITHREADED

	// IUnknown / IInspectable vtable layout. Every WinRT interface starts with
	// IInspectable's six slots, so its own methods begin at index 6.
	vtblQueryInterface = 0
	vtblRelease        = 2
	vtblFirstMethod    = 6

	runtimeClassXmlDocument              = "Windows.Data.Xml.Dom.XmlDocument"
	runtimeClassToastNotification        = "Windows.UI.Notifications.ToastNotification"
	runtimeClassToastNotificationManager = "Windows.UI.Notifications.ToastNotificationManager"
)

// Interface IDs from windows.data.xml.dom.h and windows.ui.notifications.h.
var (
	iidIXmlDocument                   = windows.GUID{Data1: 0xf7f3a506, Data2: 0x1e87, Data3: 0x42d6, Data4: [8]byte{0xbc, 0xfb, 0xb8, 0xc8, 0x09, 0xfa, 0x54, 0x94}}
	iidIXmlDocumentIO                 = windows.GUID{Data1: 0x6cd0e74e, Data2: 0xee65, Data3: 0x4489, Data4: [8]byte{0x9e, 0xbf, 0xca, 0x43, 0xe8, 0x7b, 0xa6, 0x37}}
	iidIToastNotificationFactory      = windows.GUID{Data1: 0x04124b20, Data2: 0x82c6, Data3: 0x4229, Data4: [8]byte{0xb1, 0x09, 0xfd, 0x9e, 0xd4, 0x66, 0x2b, 0x53}}
	iidIToastNotificationManagerStats = windows.GUID{Data1: 0x50ac103f, Data2: 0xd235, Data3: 0x4598, Data4: [8]byte{0xbb, 0xef, 0x98, 0xfe, 0x4d, 0x1a, 0x3a, 0xd4}}
)

// Method slots (vtblFirstMethod + declaration order in the IDL).
const (
	methIXmlDocumentIOLoadXml                 = vtblFirstMethod + 0 // LoadXml(HSTRING xml)
	methIToastNotificationFactoryCreate       = vtblFirstMethod + 0 // CreateToastNotification(IXmlDocument*, IToastNotification**)
	methIToastNotificationManagerCreateWithId = vtblFirstMethod + 1 // CreateToastNotifierWithId(HSTRING applicationId, IToastNotifier**)
	methIToastNotifierShow                    = vtblFirstMethod + 0 // Show(IToastNotification*)
)

var errWinRTUnavailable = errors.New("Windows Runtime activation entry points not available")

// comObject is the memory layout every COM interface pointer points at: a
// pointer to a vtable of function pointers. Typing it keeps the vtable reads
// as ordinary pointer dereferences (no uintptr→unsafe.Pointer round trip, which
// go vet rejects). The array bound is an upper limit for indexing only; no
// interface used here has fewer slots than the highest index we read.
type comObject struct {
	vtbl *[16]uintptr
}

// showToastWinRT raises toastXML as a toast under aumid, entirely in-process.
// It returns an error describing the first failing WinRT step so the caller
// can fall back; a nil return means Show() reported success.
func showToastWinRT(aumid, toastXML string) error {
	for _, p := range []*windows.LazyProc{procRoInitialize, procRoUninitialize, procRoActivateInstance,
		procRoGetActivationFactory, procWindowsCreateString, procWindowsDeleteString} {
		if err := p.Find(); err != nil {
			return fmt.Errorf("%w: %v", errWinRTUnavailable, err)
		}
	}

	// RoInitialize is per OS thread and must be paired with RoUninitialize on
	// the same thread; pin the goroutine for the duration.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	hr, _, _ := procRoInitialize.Call(roInitMultithreaded)
	switch uint32(hr) {
	case hrOK, hrFalse:
		defer procRoUninitialize.Call()
	case hrRPCChangedMode:
		// Thread is already an STA (e.g. a UI message loop); activation works
		// there too and the owner of that init owns the uninit.
	default:
		return hresultError("RoInitialize", hr)
	}

	// 1. XmlDocument loaded with the toast payload.
	hClass, err := newHString(runtimeClassXmlDocument)
	if err != nil {
		return err
	}
	defer deleteHString(hClass)
	var xmlDocInspectable *comObject
	if hr, _, _ = procRoActivateInstance.Call(hClass, uintptr(unsafe.Pointer(&xmlDocInspectable))); hr != hrOK {
		return hresultError("RoActivateInstance("+runtimeClassXmlDocument+")", hr)
	}
	defer comRelease(xmlDocInspectable)

	xmlDocIO, err := comQueryInterface(xmlDocInspectable, &iidIXmlDocumentIO)
	if err != nil {
		return fmt.Errorf("QueryInterface(IXmlDocumentIO): %w", err)
	}
	defer comRelease(xmlDocIO)

	hXML, err := newHString(toastXML)
	if err != nil {
		return err
	}
	defer deleteHString(hXML)
	if hr, err = comCall(xmlDocIO, methIXmlDocumentIOLoadXml, hXML); err != nil {
		return fmt.Errorf("IXmlDocumentIO::LoadXml: %w", err)
	}

	xmlDoc, err := comQueryInterface(xmlDocInspectable, &iidIXmlDocument)
	if err != nil {
		return fmt.Errorf("QueryInterface(IXmlDocument): %w", err)
	}
	defer comRelease(xmlDoc)

	// 2. ToastNotification wrapping the document.
	toastFactory, err := roGetActivationFactory(runtimeClassToastNotification, &iidIToastNotificationFactory)
	if err != nil {
		return err
	}
	defer comRelease(toastFactory)
	var toast *comObject
	if _, err = comCall(toastFactory, methIToastNotificationFactoryCreate, uintptr(unsafe.Pointer(xmlDoc)), uintptr(unsafe.Pointer(&toast))); err != nil {
		return fmt.Errorf("IToastNotificationFactory::CreateToastNotification: %w", err)
	}
	defer comRelease(toast)

	// 3. Notifier for our AUMID, then Show.
	managerStatics, err := roGetActivationFactory(runtimeClassToastNotificationManager, &iidIToastNotificationManagerStats)
	if err != nil {
		return err
	}
	defer comRelease(managerStatics)
	hAUMID, err := newHString(aumid)
	if err != nil {
		return err
	}
	defer deleteHString(hAUMID)
	var notifier *comObject
	if _, err = comCall(managerStatics, methIToastNotificationManagerCreateWithId, hAUMID, uintptr(unsafe.Pointer(&notifier))); err != nil {
		return fmt.Errorf("IToastNotificationManagerStatics::CreateToastNotifierWithId: %w", err)
	}
	defer comRelease(notifier)

	if _, err = comCall(notifier, methIToastNotifierShow, uintptr(unsafe.Pointer(toast))); err != nil {
		return fmt.Errorf("IToastNotifier::Show: %w", err)
	}
	return nil
}

// roGetActivationFactory returns the activation factory for runtimeClass cast
// to iid. The caller releases it.
func roGetActivationFactory(runtimeClass string, iid *windows.GUID) (*comObject, error) {
	hClass, err := newHString(runtimeClass)
	if err != nil {
		return nil, err
	}
	defer deleteHString(hClass)
	var factory *comObject
	hr, _, _ := procRoGetActivationFactory.Call(hClass, uintptr(unsafe.Pointer(iid)), uintptr(unsafe.Pointer(&factory)))
	if hr != hrOK {
		return nil, hresultError("RoGetActivationFactory("+runtimeClass+")", hr)
	}
	return factory, nil
}

// newHString allocates a WinRT HSTRING copy of s. WindowsCreateString takes a
// UTF-16 code-unit count, not a rune count, so supplementary-plane characters
// (emoji) are counted correctly. The caller frees it with deleteHString.
func newHString(s string) (uintptr, error) {
	u16, err := windows.UTF16FromString(s)
	if err != nil {
		return 0, fmt.Errorf("HSTRING from %q: %w", s, err)
	}
	var h uintptr
	hr, _, _ := procWindowsCreateString.Call(uintptr(unsafe.Pointer(&u16[0])), uintptr(len(u16)-1), uintptr(unsafe.Pointer(&h)))
	runtime.KeepAlive(u16)
	if hr != hrOK {
		return 0, hresultError("WindowsCreateString", hr)
	}
	return h, nil
}

func deleteHString(h uintptr) {
	if h != 0 {
		procWindowsDeleteString.Call(h)
	}
}

// comCall invokes vtable slot idx on obj and returns the HRESULT; a failing
// HRESULT (negative as int32) is also returned as an error.
//
// Callers pass out-params as uintptr(unsafe.Pointer(&x)). That conversion is
// only safe when the callee is marked uintptrescapes (as syscall.SyscallN and
// LazyProc.Call are): the directive forces the pointed-to variables onto the
// heap and keeps them alive for the call, so a stack growth inside comCall
// cannot move x and leave the COM method writing into a dead stack slot.
//
//go:uintptrescapes
func comCall(obj *comObject, idx int, args ...uintptr) (uintptr, error) {
	if obj == nil || obj.vtbl == nil {
		return 0, fmt.Errorf("COM vtable[%d] called on nil object", idx)
	}
	all := append([]uintptr{uintptr(unsafe.Pointer(obj))}, args...)
	hr, _, _ := syscall.SyscallN(obj.vtbl[idx], all...)
	if int32(hr) < 0 {
		return hr, hresultError(fmt.Sprintf("vtable[%d]", idx), hr)
	}
	return hr, nil
}

// comQueryInterface returns obj cast to iid (AddRef'd; caller releases).
func comQueryInterface(obj *comObject, iid *windows.GUID) (*comObject, error) {
	var out *comObject
	if _, err := comCall(obj, vtblQueryInterface, uintptr(unsafe.Pointer(iid)), uintptr(unsafe.Pointer(&out))); err != nil {
		return nil, err
	}
	if out == nil {
		return nil, errors.New("QueryInterface returned a nil interface")
	}
	return out, nil
}

func comRelease(obj *comObject) {
	if obj != nil {
		comCall(obj, vtblRelease) //nolint:errcheck // Release returns a refcount, not an HRESULT
	}
}

func hresultError(op string, hr uintptr) error {
	return fmt.Errorf("%s: HRESULT 0x%08X (%v)", op, uint32(hr), syscall.Errno(hr))
}
