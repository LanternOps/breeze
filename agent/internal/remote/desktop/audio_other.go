//go:build !windows

package desktop

// NewAudioCapturer returns nil on non-Windows platforms (audio capture not supported).
func NewAudioCapturer() AudioCapturer {
	return nil
}
