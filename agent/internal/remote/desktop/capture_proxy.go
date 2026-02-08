package desktop

import (
	"encoding/json"
	"fmt"
	"image"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

var proxyLog = logging.L("desktop.proxy")

// proxyCapturer implements ScreenCapturer by delegating to a user helper via IPC.
// This allows screen capture from a user's graphical session even when the root
// daemon doesn't have access to the display server (X11/Wayland/Quartz).
type proxyCapturer struct {
	session *sessionbroker.Session
	config  CaptureConfig
}

// NewProxyCapturer creates a screen capturer that delegates via IPC to a user helper.
func NewProxyCapturer(session *sessionbroker.Session, config CaptureConfig) ScreenCapturer {
	return &proxyCapturer{
		session: session,
		config:  config,
	}
}

func (p *proxyCapturer) Capture() (*image.RGBA, error) {
	return p.captureViaIPC(0, 0, 0, 0)
}

func (p *proxyCapturer) CaptureRegion(x, y, width, height int) (*image.RGBA, error) {
	return p.captureViaIPC(x, y, width, height)
}

func (p *proxyCapturer) GetScreenBounds() (width, height int, err error) {
	payload := map[string]any{
		"action": "get_bounds",
	}

	resp, err := p.session.SendCommand(
		fmt.Sprintf("desktop-bounds-%d", time.Now().UnixNano()),
		ipc.TypeDesktopStart,
		payload,
		5*time.Second,
	)
	if err != nil {
		return 0, 0, fmt.Errorf("proxy: get screen bounds: %w", err)
	}

	var result map[string]any
	if err := json.Unmarshal(resp.Payload, &result); err != nil {
		return 0, 0, fmt.Errorf("proxy: unmarshal bounds: %w", err)
	}

	w, _ := result["width"].(float64)
	h, _ := result["height"].(float64)
	return int(w), int(h), nil
}

func (p *proxyCapturer) Close() error {
	return nil
}

func (p *proxyCapturer) captureViaIPC(x, y, width, height int) (*image.RGBA, error) {
	payload := map[string]any{
		"action":       "capture",
		"x":            x,
		"y":            y,
		"width":        width,
		"height":       height,
		"quality":      p.config.Quality,
		"scaleFactor":  p.config.ScaleFactor,
		"displayIndex": p.config.DisplayIndex,
	}

	resp, err := p.session.SendCommand(
		fmt.Sprintf("desktop-capture-%d", time.Now().UnixNano()),
		ipc.TypeDesktopStart,
		payload,
		5*time.Second,
	)
	if err != nil {
		return nil, fmt.Errorf("proxy: capture via IPC: %w", err)
	}

	if resp.Error != "" {
		return nil, fmt.Errorf("proxy: user helper error: %s", resp.Error)
	}

	// The response payload contains the raw RGBA image data and dimensions.
	// For production, this would use the binary streaming channel to avoid
	// base64 overhead. For now, decode from the JSON envelope.
	var frameData struct {
		Width  int    `json:"width"`
		Height int    `json:"height"`
		Data   []byte `json:"data"`
	}
	if err := json.Unmarshal(resp.Payload, &frameData); err != nil {
		return nil, fmt.Errorf("proxy: unmarshal frame: %w", err)
	}

	img := image.NewRGBA(image.Rect(0, 0, frameData.Width, frameData.Height))
	copy(img.Pix, frameData.Data)
	return img, nil
}
