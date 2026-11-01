//go:build windows

package wfp

import (
	"fmt"
	"golang.org/x/sys/windows"
	"runtime"
	"syscall"
	"unsafe"
)

var fwpuclnt = windows.NewLazySystemDLL("fwpuclnt.dll")
var (
	layerEnumCreate  = fwpuclnt.NewProc("FwpmLayerCreateEnumHandle0")
	layerEnum        = fwpuclnt.NewProc("FwpmLayerEnum0")
	layerEnumDestroy = fwpuclnt.NewProc("FwpmLayerDestroyEnumHandle0")
	engineOpen       = fwpuclnt.NewProc("FwpmEngineOpen0")
	engineClose      = fwpuclnt.NewProc("FwpmEngineClose0")
	txBegin          = fwpuclnt.NewProc("FwpmTransactionBegin0")
	txCommit         = fwpuclnt.NewProc("FwpmTransactionCommit0")
	txAbort          = fwpuclnt.NewProc("FwpmTransactionAbort0")
	providerAdd      = fwpuclnt.NewProc("FwpmProviderAdd0")
	providerDelete   = fwpuclnt.NewProc("FwpmProviderDeleteByKey0")
	sublayerAdd      = fwpuclnt.NewProc("FwpmSubLayerAdd0")
	sublayerDelete   = fwpuclnt.NewProc("FwpmSubLayerDeleteByKey0")
	filterAdd        = fwpuclnt.NewProc("FwpmFilterAdd0")
	filterDelete     = fwpuclnt.NewProc("FwpmFilterDeleteByKey0")
	enumCreate       = fwpuclnt.NewProc("FwpmFilterCreateEnumHandle0")
	enumFilters      = fwpuclnt.NewProc("FwpmFilterEnum0")
	enumDestroy      = fwpuclnt.NewProc("FwpmFilterDestroyEnumHandle0")
	freeMemory       = fwpuclnt.NewProc("FwpmFreeMemory0")
	getAppID         = fwpuclnt.NewProc("FwpmGetAppIdFromFileName0")
	engineGetOption  = fwpuclnt.NewProc("FwpmEngineGetOption0")
	engineSetOption  = fwpuclnt.NewProc("FwpmEngineSetOption0")
	netSubscribe     = fwpuclnt.NewProc("FwpmNetEventSubscribe0")
	netUnsubscribe   = fwpuclnt.NewProc("FwpmNetEventUnsubscribe0")
)

//go:uintptrescapes
func invoke(p *windows.LazyProc, args ...uintptr) error {
	if err := p.Find(); err != nil {
		return fmt.Errorf("%s: %w", p.Name, err)
	}
	r, _, _ := p.Call(args...)
	if uint32(r) != 0 {
		return fmt.Errorf("%s (code 0x%08x): %w", p.Name, uint32(r), syscall.Errno(uint32(r)))
	}
	return nil
}
func free(p unsafe.Pointer) {
	if p == nil {
		return
	}
	freeMemory.Call(uintptr(unsafe.Pointer(&p)))
}

// AppIDFromPath asks WFP for its canonical device-path application identifier.
// The returned bytes are Go-owned; the RPC allocation is always released.
func AppIDFromPath(path string) ([]byte, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, fmt.Errorf("FwpmGetAppIdFromFileName0 path: %w", err)
	}
	var blob *nativeBlob
	var pin runtime.Pinner
	pin.Pin(name)
	defer pin.Unpin()
	if err = invoke(getAppID, uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(&blob))); err != nil {
		return nil, err
	}
	defer free(unsafe.Pointer(blob))
	b := copyBlob(blob)
	if len(b) == 0 {
		return nil, fmt.Errorf("FwpmGetAppIdFromFileName0 returned empty app-id")
	}
	return b, nil
}
