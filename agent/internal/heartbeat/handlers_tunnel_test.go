package heartbeat

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestHandleTunnelDataRejectsOversizedEncodedFrame(t *testing.T) {
	result := handleTunnelData(&Heartbeat{}, Command{
		Payload: map[string]any{
			"tunnelId": "tun-1",
			"data":     strings.Repeat("A", maxTunnelRelayBase64Bytes+1),
		},
	})

	if result.Status != "failed" {
		t.Fatalf("status = %q, want failed", result.Status)
	}
	if !strings.Contains(result.Error, "encoded frame limit") {
		t.Fatalf("error = %q, want encoded frame limit", result.Error)
	}
}

func TestHandleTunnelDataRejectsOversizedDecodedFrame(t *testing.T) {
	payload := base64.StdEncoding.EncodeToString(make([]byte, maxTunnelRelayFrameBytes+1))
	result := handleTunnelData(&Heartbeat{}, Command{
		Payload: map[string]any{
			"tunnelId": "tun-1",
			"data":     payload,
		},
	})

	if result.Status != "failed" {
		t.Fatalf("status = %q, want failed", result.Status)
	}
	if !strings.Contains(result.Error, "decoded frame limit") {
		t.Fatalf("error = %q, want decoded frame limit", result.Error)
	}
}

func TestHandleTunnelDataRejectsWhitespaceBase64(t *testing.T) {
	result := handleTunnelData(&Heartbeat{}, Command{
		Payload: map[string]any{
			"tunnelId": "tun-1",
			"data":     "Zm9v\nYmFy",
		},
	})

	if result.Status != "failed" {
		t.Fatalf("status = %q, want failed", result.Status)
	}
	if !strings.Contains(result.Error, "whitespace not permitted") {
		t.Fatalf("error = %q, want whitespace rejection", result.Error)
	}
}
