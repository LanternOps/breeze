//go:build windows

package clipboard

import (
	"errors"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32                       = syscall.NewLazyDLL("user32.dll")
	kernel32                     = syscall.NewLazyDLL("kernel32.dll")
	procOpenClipboard            = user32.NewProc("OpenClipboard")
	procCloseClipboard           = user32.NewProc("CloseClipboard")
	procEmptyClipboard           = user32.NewProc("EmptyClipboard")
	procIsClipboardFormatAvail   = user32.NewProc("IsClipboardFormatAvailable")
	procGetClipboardData         = user32.NewProc("GetClipboardData")
	procSetClipboardData         = user32.NewProc("SetClipboardData")
	procRegisterClipboardFormatW = user32.NewProc("RegisterClipboardFormatW")
	procGlobalAlloc              = kernel32.NewProc("GlobalAlloc")
	procGlobalLock               = kernel32.NewProc("GlobalLock")
	procGlobalUnlock             = kernel32.NewProc("GlobalUnlock")
	procGlobalSize               = kernel32.NewProc("GlobalSize")
)

const (
	cfUnicodeText = 13
	gmemMoveable  = 0x0002
)

type SystemClipboard struct{}

var (
	formatInit sync.Once
	formatRTF  uint32
	formatPNG  uint32
	formatJPEG uint32
)

func NewSystemClipboard() *SystemClipboard {
	return &SystemClipboard{}
}

func openClipboard() error {
	r, _, err := procOpenClipboard.Call(0)
	if r == 0 {
		return err
	}
	return nil
}

func closeClipboard() {
	procCloseClipboard.Call()
}

func emptyClipboard() error {
	r, _, err := procEmptyClipboard.Call()
	if r == 0 {
		return err
	}
	return nil
}

func isClipboardFormatAvailable(format uint32) bool {
	r, _, _ := procIsClipboardFormatAvail.Call(uintptr(format))
	return r != 0
}

func getClipboardData(format uint32) (windows.Handle, error) {
	r, _, err := procGetClipboardData.Call(uintptr(format))
	if r == 0 {
		return 0, err
	}
	return windows.Handle(r), nil
}

func setClipboardData(format uint32, handle windows.Handle) error {
	r, _, err := procSetClipboardData.Call(uintptr(format), uintptr(handle))
	if r == 0 {
		return err
	}
	return nil
}

func registerClipboardFormat(name string) uint32 {
	ptr, _ := windows.UTF16PtrFromString(name)
	r, _, _ := procRegisterClipboardFormatW.Call(uintptr(unsafe.Pointer(ptr)))
	return uint32(r)
}

func globalAlloc(flags uint32, size uintptr) (windows.Handle, error) {
	r, _, err := procGlobalAlloc.Call(uintptr(flags), size)
	if r == 0 {
		return 0, err
	}
	return windows.Handle(r), nil
}

func globalLock(handle windows.Handle) (unsafe.Pointer, error) {
	r, _, err := procGlobalLock.Call(uintptr(handle))
	if r == 0 {
		return nil, err
	}
	return unsafe.Pointer(r), nil
}

func globalUnlock(handle windows.Handle) {
	procGlobalUnlock.Call(uintptr(handle))
}

func globalSize(handle windows.Handle) uintptr {
	r, _, _ := procGlobalSize.Call(uintptr(handle))
	return r
}

func (s *SystemClipboard) GetContent() (Content, error) {
	formatInit.Do(initFormats)
	if err := openClipboard(); err != nil {
		return Content{}, err
	}
	defer closeClipboard()

	if formatPNG != 0 && isClipboardFormatAvailable(formatPNG) {
		data, err := readClipboardBytes(formatPNG)
		if err == nil {
			return Content{Type: ContentTypeImage, Image: data, ImageFormat: "png"}, nil
		}
	}

	if formatJPEG != 0 && isClipboardFormatAvailable(formatJPEG) {
		data, err := readClipboardBytes(formatJPEG)
		if err == nil {
			return Content{Type: ContentTypeImage, Image: data, ImageFormat: "jpeg"}, nil
		}
	}

	if formatRTF != 0 && isClipboardFormatAvailable(formatRTF) {
		data, err := readClipboardBytes(formatRTF)
		if err == nil {
			return Content{Type: ContentTypeRTF, RTF: data}, nil
		}
	}

	if isClipboardFormatAvailable(cfUnicodeText) {
		text, err := readClipboardText()
		if err != nil {
			return Content{}, err
		}
		return Content{Type: ContentTypeText, Text: text}, nil
	}

	return Content{}, errors.New("clipboard: no supported format")
}

func (s *SystemClipboard) SetContent(content Content) error {
	formatInit.Do(initFormats)
	if err := openClipboard(); err != nil {
		return err
	}
	defer closeClipboard()

	if err := emptyClipboard(); err != nil {
		return err
	}

	switch content.Type {
	case ContentTypeText:
		return writeClipboardText(content.Text)
	case ContentTypeRTF:
		if formatRTF == 0 {
			return errors.New("clipboard: RTF format unavailable")
		}
		return writeClipboardBytes(formatRTF, content.RTF)
	case ContentTypeImage:
		if content.ImageFormat == "png" && formatPNG != 0 {
			return writeClipboardBytes(formatPNG, content.Image)
		}
		if content.ImageFormat == "jpeg" && formatJPEG != 0 {
			return writeClipboardBytes(formatJPEG, content.Image)
		}
		return errors.New("clipboard: unsupported image format")
	default:
		return errors.New("clipboard: unsupported content type")
	}
}

func initFormats() {
	formatRTF = registerClipboardFormat("Rich Text Format")
	formatPNG = registerClipboardFormat("PNG")
	formatJPEG = registerClipboardFormat("JFIF")
}

func readClipboardText() (string, error) {
	handle, err := getClipboardData(cfUnicodeText)
	if err != nil {
		return "", err
	}
	ptr, err := globalLock(handle)
	if err != nil {
		return "", err
	}
	defer globalUnlock(handle)

	return windows.UTF16PtrToString((*uint16)(ptr)), nil
}

func readClipboardBytes(format uint32) ([]byte, error) {
	handle, err := getClipboardData(format)
	if err != nil {
		return nil, err
	}
	ptr, err := globalLock(handle)
	if err != nil {
		return nil, err
	}
	defer globalUnlock(handle)

	size := globalSize(handle)
	if size == 0 {
		return nil, errors.New("clipboard: empty data")
	}

	data := unsafe.Slice((*byte)(ptr), int(size))
	copyBytes := make([]byte, len(data))
	copy(copyBytes, data)
	return copyBytes, nil
}

func writeClipboardText(text string) error {
	utf16Text, err := windows.UTF16FromString(text)
	if err != nil {
		return err
	}
	length := len(utf16Text) * 2
	handle, err := globalAlloc(gmemMoveable, uintptr(length))
	if err != nil {
		return err
	}
	ptr, err := globalLock(handle)
	if err != nil {
		return err
	}
	defer globalUnlock(handle)

	data := unsafe.Slice((*byte)(ptr), length)
	for i, v := range utf16Text {
		data[i*2] = byte(v)
		data[i*2+1] = byte(v >> 8)
	}

	return setClipboardData(cfUnicodeText, handle)
}

func writeClipboardBytes(format uint32, data []byte) error {
	if len(data) == 0 {
		return errors.New("clipboard: empty data")
	}
	handle, err := globalAlloc(gmemMoveable, uintptr(len(data)))
	if err != nil {
		return err
	}
	ptr, err := globalLock(handle)
	if err != nil {
		return err
	}
	defer globalUnlock(handle)

	buf := unsafe.Slice((*byte)(ptr), len(data))
	copy(buf, data)

	return setClipboardData(format, handle)
}
