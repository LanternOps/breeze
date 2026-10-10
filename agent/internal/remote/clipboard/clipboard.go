package clipboard

import (
	"crypto/sha256"
	"errors"
	"fmt"
)

type ContentType string

const (
	ContentTypeText  ContentType = "text"
	ContentTypeRTF   ContentType = "rtf"
	ContentTypeImage ContentType = "image"
)

const (
	MaxTextBytes  = 1 * 1024 * 1024
	MaxRTFBytes   = 2 * 1024 * 1024
	MaxImageBytes = 8 * 1024 * 1024
)

type Content struct {
	Type        ContentType
	Text        string
	RTF         []byte
	Image       []byte
	ImageFormat string
}

// ErrNoSupportedFormat: the clipboard is empty or holds only formats the agent
// cannot read. Unlike a failure to open it, this is a lasting state.
var ErrNoSupportedFormat = errors.New("clipboard: no supported format")

type Provider interface {
	GetContent() (Content, error)
	SetContent(content Content) error
}

func ValidateContent(content Content) error {
	if len(content.Text) > MaxTextBytes {
		return fmt.Errorf("clipboard text exceeds maximum %d bytes", MaxTextBytes)
	}
	if len(content.RTF) > MaxRTFBytes {
		return fmt.Errorf("clipboard RTF exceeds maximum %d bytes", MaxRTFBytes)
	}
	if len(content.Image) > MaxImageBytes {
		return fmt.Errorf("clipboard image exceeds maximum %d bytes", MaxImageBytes)
	}
	return nil
}

func fingerprint(content Content) [32]byte {
	hasher := sha256.New()
	hasher.Write([]byte(content.Type))
	hasher.Write([]byte(content.Text))
	hasher.Write(content.RTF)
	hasher.Write(content.Image)
	hasher.Write([]byte(content.ImageFormat))
	var sum [32]byte
	copy(sum[:], hasher.Sum(nil))
	return sum
}
