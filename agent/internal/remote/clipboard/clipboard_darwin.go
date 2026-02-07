//go:build darwin

package clipboard

/*
#cgo darwin CFLAGS: -x objective-c -fobjc-arc
#cgo darwin LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>

static int clipboard_get_text(char **out, int *length) {
	@autoreleasepool {
		NSPasteboard *pb = [NSPasteboard generalPasteboard];
		NSString *value = [pb stringForType:NSPasteboardTypeString];
		if (!value) {
			return 0;
		}
		const char *utf8 = [value UTF8String];
		if (!utf8) {
			return 0;
		}
		int len = (int)strlen(utf8);
		char *buffer = (char *)malloc(len);
		memcpy(buffer, utf8, len);
		*out = buffer;
		*length = len;
		return 1;
	}
}

static int clipboard_get_data(const char *type, void **out, int *length) {
	@autoreleasepool {
		NSPasteboard *pb = [NSPasteboard generalPasteboard];
		NSString *typeString = [NSString stringWithUTF8String:type];
		NSData *data = [pb dataForType:typeString];
		if (!data) {
			return 0;
		}
		int len = (int)[data length];
		void *buffer = malloc(len);
		memcpy(buffer, [data bytes], len);
		*out = buffer;
		*length = len;
		return 1;
	}
}

static int clipboard_set_text(const char *text, int length) {
	@autoreleasepool {
		NSPasteboard *pb = [NSPasteboard generalPasteboard];
		[pb clearContents];
		NSString *value = [[NSString alloc] initWithBytes:text length:length encoding:NSUTF8StringEncoding];
		if (!value) {
			return 0;
		}
		return [pb setString:value forType:NSPasteboardTypeString] ? 1 : 0;
	}
}

static int clipboard_set_data(const char *type, const void *data, int length) {
	@autoreleasepool {
		NSPasteboard *pb = [NSPasteboard generalPasteboard];
		[pb clearContents];
		NSString *typeString = [NSString stringWithUTF8String:type];
		NSData *payload = [NSData dataWithBytes:data length:length];
		return [pb setData:payload forType:typeString] ? 1 : 0;
	}
}
*/
import "C"

import (
	"errors"
	"unsafe"
)

type SystemClipboard struct{}

func NewSystemClipboard() *SystemClipboard {
	return &SystemClipboard{}
}

func (s *SystemClipboard) GetContent() (Content, error) {
	if data, ok := readClipboardData("public.png"); ok {
		return Content{Type: ContentTypeImage, Image: data, ImageFormat: "png"}, nil
	}
	if data, ok := readClipboardData("public.jpeg"); ok {
		return Content{Type: ContentTypeImage, Image: data, ImageFormat: "jpeg"}, nil
	}
	if data, ok := readClipboardData("public.rtf"); ok {
		return Content{Type: ContentTypeRTF, RTF: data}, nil
	}
	if text, ok := readClipboardText(); ok {
		return Content{Type: ContentTypeText, Text: text}, nil
	}

	return Content{}, errors.New("clipboard: no supported format")
}

func (s *SystemClipboard) SetContent(content Content) error {
	switch content.Type {
	case ContentTypeText:
		if len(content.Text) == 0 {
			return errors.New("clipboard: empty text")
		}
		if ok := writeClipboardText(content.Text); !ok {
			return errors.New("clipboard: failed to set text")
		}
		return nil
	case ContentTypeRTF:
		if len(content.RTF) == 0 {
			return errors.New("clipboard: empty rtf")
		}
		if ok := writeClipboardData("public.rtf", content.RTF); !ok {
			return errors.New("clipboard: failed to set rtf")
		}
		return nil
	case ContentTypeImage:
		if len(content.Image) == 0 {
			return errors.New("clipboard: empty image")
		}
		format := content.ImageFormat
		switch format {
		case "png":
			if ok := writeClipboardData("public.png", content.Image); !ok {
				return errors.New("clipboard: failed to set png")
			}
			return nil
		case "jpeg":
			if ok := writeClipboardData("public.jpeg", content.Image); !ok {
				return errors.New("clipboard: failed to set jpeg")
			}
			return nil
		default:
			return errors.New("clipboard: unsupported image format")
		}
	default:
		return errors.New("clipboard: unsupported content type")
	}
}

func readClipboardText() (string, bool) {
	var out *C.char
	var length C.int
	if C.clipboard_get_text(&out, &length) == 0 {
		return "", false
	}
	defer C.free(unsafe.Pointer(out))
	return C.GoStringN(out, length), true
}

func readClipboardData(uti string) ([]byte, bool) {
	cType := C.CString(uti)
	defer C.free(unsafe.Pointer(cType))

	var out unsafe.Pointer
	var length C.int
	if C.clipboard_get_data(cType, &out, &length) == 0 {
		return nil, false
	}
	defer C.free(out)

	data := C.GoBytes(out, length)
	return data, true
}

func writeClipboardText(text string) bool {
	cText := C.CString(text)
	defer C.free(unsafe.Pointer(cText))
	length := C.int(len(text))
	return C.clipboard_set_text(cText, length) != 0
}

func writeClipboardData(uti string, data []byte) bool {
	cType := C.CString(uti)
	defer C.free(unsafe.Pointer(cType))
	return C.clipboard_set_data(cType, unsafe.Pointer(&data[0]), C.int(len(data))) != 0
}
