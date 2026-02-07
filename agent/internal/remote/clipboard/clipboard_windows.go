//go:build windows

package clipboard

import (
	"errors"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
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

func (s *SystemClipboard) GetContent() (Content, error) {
	formatInit.Do(initFormats)
	if err := windows.OpenClipboard(0); err != nil {
		return Content{}, err
	}
	defer windows.CloseClipboard()

	if formatPNG != 0 && windows.IsClipboardFormatAvailable(formatPNG) {
		data, err := readClipboardBytes(formatPNG)
		if err == nil {
			return Content{Type: ContentTypeImage, Image: data, ImageFormat: "png"}, nil
		}
	}

	if formatJPEG != 0 && windows.IsClipboardFormatAvailable(formatJPEG) {
		data, err := readClipboardBytes(formatJPEG)
		if err == nil {
			return Content{Type: ContentTypeImage, Image: data, ImageFormat: "jpeg"}, nil
		}
	}

	if formatRTF != 0 && windows.IsClipboardFormatAvailable(formatRTF) {
		data, err := readClipboardBytes(formatRTF)
		if err == nil {
			return Content{Type: ContentTypeRTF, RTF: data}, nil
		}
	}

	if windows.IsClipboardFormatAvailable(windows.CF_UNICODETEXT) {
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
	if err := windows.OpenClipboard(0); err != nil {
		return err
	}
	defer windows.CloseClipboard()

	if err := windows.EmptyClipboard(); err != nil {
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
	formatRTF = windows.RegisterClipboardFormat(windows.StringToUTF16Ptr("Rich Text Format"))
	formatPNG = windows.RegisterClipboardFormat(windows.StringToUTF16Ptr("PNG"))
	formatJPEG = windows.RegisterClipboardFormat(windows.StringToUTF16Ptr("JFIF"))
}

func readClipboardText() (string, error) {
	handle, err := windows.GetClipboardData(windows.CF_UNICODETEXT)
	if err != nil {
		return "", err
	}
	ptr, err := windows.GlobalLock(handle)
	if err != nil {
		return "", err
	}
	defer windows.GlobalUnlock(handle)

	return windows.UTF16PtrToString((*uint16)(unsafe.Pointer(ptr))), nil
}

func readClipboardBytes(format uint32) ([]byte, error) {
	handle, err := windows.GetClipboardData(format)
	if err != nil {
		return nil, err
	}
	ptr, err := windows.GlobalLock(handle)
	if err != nil {
		return nil, err
	}
	defer windows.GlobalUnlock(handle)

	size := windows.GlobalSize(handle)
	if size == 0 {
		return nil, errors.New("clipboard: empty data")
	}

	length := int(size)
	data := unsafe.Slice((*byte)(unsafe.Pointer(ptr)), length)
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
	size := uintptr(length)
	handle, err := windows.GlobalAlloc(windows.GMEM_MOVEABLE, size)
	if err != nil {
		return err
	}
	ptr, err := windows.GlobalLock(handle)
	if err != nil {
		return err
	}
	defer windows.GlobalUnlock(handle)

	data := unsafe.Slice((*byte)(unsafe.Pointer(ptr)), length)
	for i, v := range utf16Text {
		data[i*2] = byte(v)
		data[i*2+1] = byte(v >> 8)
	}

	_, err = windows.SetClipboardData(windows.CF_UNICODETEXT, handle)
	return err
}

func writeClipboardBytes(format uint32, data []byte) error {
	if len(data) == 0 {
		return errors.New("clipboard: empty data")
	}
	handle, err := windows.GlobalAlloc(windows.GMEM_MOVEABLE, uintptr(len(data)))
	if err != nil {
		return err
	}
	ptr, err := windows.GlobalLock(handle)
	if err != nil {
		return err
	}
	defer windows.GlobalUnlock(handle)

	buf := unsafe.Slice((*byte)(unsafe.Pointer(ptr)), len(data))
	copy(buf, data)

	_, err = windows.SetClipboardData(format, handle)
	return err
}
