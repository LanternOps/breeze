//go:build !windows

package vss

import (
	"context"
	"errors"
	"testing"
)

func TestStubProvider_CreateShadowCopy(t *testing.T) {
	p := NewProvider(DefaultConfig())
	session, err := p.CreateShadowCopy(context.Background(), []string{"C:\\"})
	if !errors.Is(err, ErrVSSNotSupported) {
		t.Fatalf("expected ErrVSSNotSupported, got %v", err)
	}
	if session != nil {
		t.Fatal("expected nil session")
	}
}

func TestStubProvider_ReleaseShadowCopy(t *testing.T) {
	p := NewProvider(DefaultConfig())
	err := p.ReleaseShadowCopy(&VSSSession{ID: "test"})
	if !errors.Is(err, ErrVSSNotSupported) {
		t.Fatalf("expected ErrVSSNotSupported, got %v", err)
	}
}

func TestStubProvider_ListWriters(t *testing.T) {
	p := NewProvider(DefaultConfig())
	writers, err := p.ListWriters(context.Background())
	if !errors.Is(err, ErrVSSNotSupported) {
		t.Fatalf("expected ErrVSSNotSupported, got %v", err)
	}
	if writers != nil {
		t.Fatal("expected nil writers")
	}
}

func TestStubProvider_GetShadowPath(t *testing.T) {
	p := NewProvider(DefaultConfig())
	path, err := p.GetShadowPath(&VSSSession{}, "C:\\")
	if !errors.Is(err, ErrVSSNotSupported) {
		t.Fatalf("expected ErrVSSNotSupported, got %v", err)
	}
	if path != "" {
		t.Fatalf("expected empty path, got %q", path)
	}
}

func TestDefaultConfig(t *testing.T) {
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

func TestNewProvider_ReturnsStub(t *testing.T) {
	p := NewProvider(Config{})
	if _, ok := p.(*StubProvider); !ok {
		t.Fatalf("expected *StubProvider on non-windows, got %T", p)
	}
}
