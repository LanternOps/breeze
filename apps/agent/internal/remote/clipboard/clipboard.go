package clipboard

import (
	"crypto/sha256"
)

type ContentType string

const (
	ContentTypeText  ContentType = "text"
	ContentTypeRTF   ContentType = "rtf"
	ContentTypeImage ContentType = "image"
)

type Content struct {
	Type        ContentType
	Text        string
	RTF         []byte
	Image       []byte
	ImageFormat string
}

type Provider interface {
	GetContent() (Content, error)
	SetContent(content Content) error
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
