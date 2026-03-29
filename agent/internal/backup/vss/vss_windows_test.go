//go:build windows

package vss

import (
	"testing"
)

func TestNewProvider_ReturnsWindowsProvider(t *testing.T) {
	p := NewProvider(DefaultConfig())
	if p == nil {
		t.Fatal("expected non-nil provider")
	}
	if _, ok := p.(*WindowsProvider); !ok {
		t.Fatalf("expected *WindowsProvider, got %T", p)
	}
}

func TestDefaultConfig_Values(t *testing.T) {
	cfg := DefaultConfig()
	if !cfg.Enabled {
		t.Fatal("expected Enabled=true")
	}
	if cfg.TimeoutSeconds != 600 {
		t.Fatalf("expected TimeoutSeconds=600, got %d", cfg.TimeoutSeconds)
	}
	if !cfg.RetryOnFailure {
		t.Fatal("expected RetryOnFailure=true")
	}
}

func TestWriterStatus_Fields(t *testing.T) {
	ws := WriterStatus{
		Name:      "SQL Writer",
		ID:        "abc-123",
		State:     "stable",
		LastError: "",
	}
	if ws.Name != "SQL Writer" {
		t.Fatalf("expected Name='SQL Writer', got %q", ws.Name)
	}
	if ws.State != "stable" {
		t.Fatalf("expected State='stable', got %q", ws.State)
	}
}

func TestVSSSession_ShadowPaths(t *testing.T) {
	session := &VSSSession{
		ID:      "test-session",
		Volumes: []string{"C:\\", "D:\\"},
		ShadowPaths: map[string]string{
			"C:\\": `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1`,
			"D:\\": `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy2`,
		},
	}

	p := &WindowsProvider{config: DefaultConfig()}

	path, err := p.GetShadowPath(session, "C:\\")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if path != `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1` {
		t.Fatalf("unexpected path: %q", path)
	}

	_, err = p.GetShadowPath(session, "E:\\")
	if err == nil {
		t.Fatal("expected error for missing volume")
	}

	_, err = p.GetShadowPath(nil, "C:\\")
	if err == nil {
		t.Fatal("expected error for nil session")
	}
}
