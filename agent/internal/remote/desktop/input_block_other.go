//go:build !windows && !darwin

package desktop

// otherInputBlockBackend is a no-op for Linux and any other platform.
//
// Linux local-input blocking is explicitly out of scope for v1 (issue #966).
// A future X11 implementation could XGrabKeyboard/XGrabPointer (or evdev
// EVIOCGRAB on the underlying devices for Wayland), but the grab/ungrab
// lifecycle and Wayland compositor differences warrant their own design.
type otherInputBlockBackend struct{}

func newInputBlockBackend() inputBlockBackend {
	return &otherInputBlockBackend{}
}

func (b *otherInputBlockBackend) Supported() bool { return false }
func (b *otherInputBlockBackend) Block() error    { return nil }
func (b *otherInputBlockBackend) Unblock() error  { return nil }
