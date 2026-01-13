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
	if data, err := readClipboardTarget("image/png"); err == nil && len(data) > 0 {
		return Content{Type: ContentTypeImage, Image: data, ImageFormat: "png"}, nil
	}
	if data, err := readClipboardTarget("image/jpeg"); err == nil && len(data) > 0 {
		return Content{Type: ContentTypeImage, Image: data, ImageFormat: "jpeg"}, nil
	}
	if data, err := readClipboardTarget("text/rtf"); err == nil && len(data) > 0 {
		return Content{Type: ContentTypeRTF, RTF: data}, nil
	}
	if data, err := readClipboardTarget("text/plain;charset=utf-8"); err == nil && len(data) > 0 {
		return Content{Type: ContentTypeText, Text: string(data)}, nil
	}

	return Content{}, errors.New("clipboard: no supported format")
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
		return cmd.Output()
	}
	if path, err := exec.LookPath("xsel"); err == nil {
		cmd := exec.Command(path, "-b", "-o", "-t", target)
		return cmd.Output()
	}
	return nil, errors.New("clipboard: xclip or xsel required for X11 clipboard access")
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
