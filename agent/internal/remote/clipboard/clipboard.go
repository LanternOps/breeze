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

// ErrClipboardEmpty: the clipboard holds nothing at all. It is a kind of
// ErrNoSupportedFormat (errors.Is holds), so the baseline rule treats both
// alike; the change watcher tells them apart, because a remote clipboard that
// holds a file is newer than the viewer's and an empty one has nothing to
// protect. Only providers that can count formats return it.
var ErrClipboardEmpty = fmt.Errorf("%w: clipboard is empty", ErrNoSupportedFormat)

// noContentError is what a provider returns when no format yielded content.
// failure is the first read that failed for another reason than the format
// being absent; it means the clipboard's contents are unknown, not empty.
func noContentError(failure error) error {
	if failure != nil {
		return fmt.Errorf("clipboard: read failed: %w", failure)
	}
	return ErrNoSupportedFormat
}

type Provider interface {
	GetContent() (Content, error)
	SetContent(content Content) error
}

// ChangeCounter is a Provider that can tell, without reading the clipboard,
// whether it changed: Windows GetClipboardSequenceNumber, macOS NSPasteboard
// changeCount. The count moves on every change, including a copy of content
// identical to what the clipboard already held, which a content hash cannot
// see (#11310 row 3). ok is false when the count is unavailable right now;
// the watcher then falls back to comparing content hashes.
type ChangeCounter interface {
	ChangeCount() (count uint64, ok bool)
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
