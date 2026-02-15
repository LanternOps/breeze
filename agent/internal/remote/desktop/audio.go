package desktop

// AudioCapturer captures system audio for streaming to the viewer.
type AudioCapturer interface {
	// Start begins capturing audio. Calls the callback with μ-law encoded
	// 8kHz mono frames (160 bytes = 20ms at 8000Hz).
	Start(callback func([]byte)) error
	// Stop stops the audio capture.
	Stop()
}
