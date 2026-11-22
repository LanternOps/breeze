package clipboard

import (
	"errors"
	"fmt"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// ErrUserClipboardUnavailable: there is no user-role helper to read the
// clipboard through (login screen, user helper not running). The system
// helper's own read is then the only one there is.
var ErrUserClipboardUnavailable = errors.New("clipboard: no user helper to read through")

// RelayResultFromRead encodes a read made through the user helper for the trip
// back to the system helper (#8393). Errors cross IPC as strings, so the two
// that change what the watcher does travel as flags.
func RelayResultFromRead(content Content, err error) ipc.DesktopClipboardReadResult {
	switch {
	case err == nil:
		return ipc.DesktopClipboardReadResult{
			Type:        string(content.Type),
			Text:        content.Text,
			RTF:         content.RTF,
			Image:       content.Image,
			ImageFormat: content.ImageFormat,
		}
	case errors.Is(err, ErrNoSupportedFormat):
		return ipc.DesktopClipboardReadResult{NoSupportedFormat: true}
	case errors.Is(err, ErrUserClipboardUnavailable):
		return ipc.DesktopClipboardReadResult{Unavailable: true}
	default:
		return ipc.DesktopClipboardReadResult{Error: err.Error()}
	}
}

// ContentFromRelayResult decodes the service's answer. The content crossed two
// IPC hops, so its type and size caps are checked again here.
func ContentFromRelayResult(res ipc.DesktopClipboardReadResult) (Content, error) {
	switch {
	case res.Unavailable:
		return Content{}, ErrUserClipboardUnavailable
	case res.NoSupportedFormat:
		return Content{}, fmt.Errorf("user helper: %w", ErrNoSupportedFormat)
	case res.Error != "":
		return Content{}, fmt.Errorf("clipboard: read through user helper failed: %s", res.Error)
	}
	content := Content{
		Type:        ContentType(res.Type),
		Text:        res.Text,
		RTF:         res.RTF,
		Image:       res.Image,
		ImageFormat: res.ImageFormat,
	}
	switch content.Type {
	case ContentTypeText:
	case ContentTypeRTF:
		if len(content.RTF) == 0 {
			return Content{}, errors.New("clipboard: user helper returned RTF with no data")
		}
	case ContentTypeImage:
		if len(content.Image) == 0 || content.ImageFormat == "" {
			return Content{}, errors.New("clipboard: user helper returned an image with no data or format")
		}
	default:
		return Content{}, fmt.Errorf("clipboard: user helper returned unknown content type %q", res.Type)
	}
	if err := ValidateContent(content); err != nil {
		return Content{}, fmt.Errorf("clipboard: user helper read rejected: %w", err)
	}
	return content, nil
}
