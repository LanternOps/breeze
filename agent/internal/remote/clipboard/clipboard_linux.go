//go:build linux

package clipboard

import (
	"bytes"
	"errors"
	"os/exec"
)

type SystemClipboard struct{}

func NewSystemClipboard() *SystemClipboard {
	return &SystemClipboard{}
}

func (s *SystemClipboard) GetContent() (Content, error) {
	// failure is a read that failed for another reason than the target being
	// absent (X unreachable, xclip missing): the clipboard is then unknown,
	// not empty.
	var failure error
	read := func(target string) []byte {
		data, err := readClipboardTarget(target)
		if err != nil {
			if !errors.Is(err, errTargetUnavailable) && failure == nil {
				failure = err
			}
			return nil
		}
		return data
	}
	if data := read("image/png"); len(data) > 0 {
		return Content{Type: ContentTypeImage, Image: data, ImageFormat: "png"}, nil
	}
	if data := read("image/jpeg"); len(data) > 0 {
		return Content{Type: ContentTypeImage, Image: data, ImageFormat: "jpeg"}, nil
	}
	if data := read("text/rtf"); len(data) > 0 {
		return Content{Type: ContentTypeRTF, RTF: data}, nil
	}
	if data := read("text/plain;charset=utf-8"); len(data) > 0 {
		return Content{Type: ContentTypeText, Text: string(data)}, nil
	}

	return Content{}, noContentError(failure)
}

func (s *SystemClipboard) SetContent(content Content) error {
	switch content.Type {
	case ContentTypeText:
		return writeClipboardTarget("text/plain;charset=utf-8", []byte(content.Text))
	case ContentTypeRTF:
		return writeClipboardTarget("text/rtf", content.RTF)
	case ContentTypeImage:
		switch content.ImageFormat {
		case "png":
			return writeClipboardTarget("image/png", content.Image)
		case "jpeg":
			return writeClipboardTarget("image/jpeg", content.Image)
		default:
			return errors.New("clipboard: unsupported image format")
		}
	default:
		return errors.New("clipboard: unsupported content type")
	}
}

func readClipboardTarget(target string) ([]byte, error) {
	if path, err := exec.LookPath("xclip"); err == nil {
		cmd := exec.Command(path, "-selection", "clipboard", "-t", target, "-o")
		out, err := cmd.Output()
		if err != nil {
			return nil, xclipReadError(err)
		}
		return out, nil
	}
	if path, err := exec.LookPath("xsel"); err == nil {
		cmd := exec.Command(path, "-b", "-o", "-t", target)
		return cmd.Output()
	}
	return nil, errors.New("clipboard: xclip or xsel required for X11 clipboard access")
}

// errTargetUnavailable: X answered, and the clipboard holds no data for the
// requested target.
var errTargetUnavailable = errors.New("clipboard: target not available")

// xclipReadError tells "no data for this target" (xclip: "Error: target X
// not available") from a real failure such as an unreachable display. Only
// the first means the clipboard is empty.
func xclipReadError(err error) error {
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && bytes.Contains(exitErr.Stderr, []byte("not available")) {
		return errTargetUnavailable
	}
	return err
}

func writeClipboardTarget(target string, data []byte) error {
	if len(data) == 0 {
		return errors.New("clipboard: empty data")
	}
	if path, err := exec.LookPath("xclip"); err == nil {
		cmd := exec.Command(path, "-selection", "clipboard", "-t", target, "-i")
		cmd.Stdin = bytes.NewReader(data)
		return cmd.Run()
	}
	if path, err := exec.LookPath("xsel"); err == nil {
		cmd := exec.Command(path, "-b", "-i", "-t", target)
		cmd.Stdin = bytes.NewReader(data)
		return cmd.Run()
	}
	return errors.New("clipboard: xclip or xsel required for X11 clipboard access")
}
