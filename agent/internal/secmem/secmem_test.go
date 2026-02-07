package secmem

import (
	"encoding/json"
	"fmt"
	"sync"
	"testing"
)

func TestRevealReturnsOriginalValue(t *testing.T) {
	s := NewSecureString("hunter2")
	if got := s.Reveal(); got != "hunter2" {
		t.Fatalf("Reveal() = %q, want %q", got, "hunter2")
	}
}

func TestRevealOnNilReturnsEmpty(t *testing.T) {
	var s *SecureString
	if got := s.Reveal(); got != "" {
		t.Fatalf("nil Reveal() = %q, want empty", got)
	}
}

func TestRevealAfterZeroReturnsEmpty(t *testing.T) {
	s := NewSecureString("secret")
	s.Zero()
	if got := s.Reveal(); got != "" {
		t.Fatalf("Reveal() after Zero() = %q, want empty", got)
	}
}

func TestIsZeroed(t *testing.T) {
	s := NewSecureString("token")
	if s.IsZeroed() {
		t.Fatal("IsZeroed() = true before Zero()")
	}
	s.Zero()
	if !s.IsZeroed() {
		t.Fatal("IsZeroed() = false after Zero()")
	}
}

func TestIsZeroedOnNil(t *testing.T) {
	var s *SecureString
	if s.IsZeroed() {
		t.Fatal("nil IsZeroed() = true, want false")
	}
}

func TestStringReturnsRedacted(t *testing.T) {
	s := NewSecureString("secret")
	if got := s.String(); got != "[REDACTED]" {
		t.Fatalf("String() = %q, want [REDACTED]", got)
	}
}

func TestGoStringReturnsRedacted(t *testing.T) {
	s := NewSecureString("secret")
	if got := s.GoString(); got != "[REDACTED]" {
		t.Fatalf("GoString() = %q, want [REDACTED]", got)
	}
}

func TestFormatAllVerbsRedacted(t *testing.T) {
	s := NewSecureString("secret")

	tests := []struct {
		format string
		name   string
	}{
		{"%s", "percent-s"},
		{"%v", "percent-v"},
		{"%+v", "percent-plus-v"},
		{"%#v", "percent-hash-v"},
		{"%q", "percent-q"},
	}

	for _, tt := range tests {
		got := fmt.Sprintf(tt.format, s)
		if got != "[REDACTED]" {
			t.Errorf("fmt.Sprintf(%q, s) = %q, want [REDACTED]", tt.format, got)
		}
	}
}

func TestMarshalJSONReturnsRedacted(t *testing.T) {
	s := NewSecureString("secret")
	data, err := json.Marshal(s)
	if err != nil {
		t.Fatalf("MarshalJSON error: %v", err)
	}
	if string(data) != `"[REDACTED]"` {
		t.Fatalf("MarshalJSON = %s, want %q", data, "[REDACTED]")
	}
}

func TestMarshalTextReturnsRedacted(t *testing.T) {
	s := NewSecureString("secret")
	data, err := s.MarshalText()
	if err != nil {
		t.Fatalf("MarshalText error: %v", err)
	}
	if string(data) != "[REDACTED]" {
		t.Fatalf("MarshalText = %q, want [REDACTED]", data)
	}
}

func TestUnmarshalJSONRejects(t *testing.T) {
	var s SecureString
	err := json.Unmarshal([]byte(`"should-fail"`), &s)
	if err == nil {
		t.Fatal("UnmarshalJSON should return an error")
	}
}

func TestZeroOnNilDoesNotPanic(t *testing.T) {
	var s *SecureString
	s.Zero() // should not panic
}

func TestZeroWipesData(t *testing.T) {
	s := NewSecureString("abc")
	s.Zero()

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data != nil {
		t.Fatalf("data should be nil after Zero(), got %v", s.data)
	}
}

func TestConcurrentRevealAndZero(t *testing.T) {
	s := NewSecureString("concurrent-test")
	var wg sync.WaitGroup

	// Concurrent Reveal calls
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = s.Reveal()
		}()
	}

	// Concurrent Zero call
	wg.Add(1)
	go func() {
		defer wg.Done()
		s.Zero()
	}()

	wg.Wait()

	// After all goroutines complete, Reveal should return ""
	if got := s.Reveal(); got != "" {
		t.Fatalf("Reveal() after concurrent Zero = %q, want empty", got)
	}
}

func TestRevealAfterZeroWarnsOnce(t *testing.T) {
	s := NewSecureString("secret")
	s.Zero()

	// First Reveal after Zero should set warnedOnce
	_ = s.Reveal()
	if !s.warnedOnce.Load() {
		t.Fatal("warnedOnce should be true after first Reveal post-Zero")
	}

	// warnedOnce should remain true (no repeated warnings)
	_ = s.Reveal()
	if !s.warnedOnce.Load() {
		t.Fatal("warnedOnce should remain true")
	}
}

func TestWarnedOnceNotSetBeforeZero(t *testing.T) {
	s := NewSecureString("secret")
	_ = s.Reveal()
	if s.warnedOnce.Load() {
		t.Fatal("warnedOnce should be false when token is still alive")
	}
}

func TestMarshalJSONInStruct(t *testing.T) {
	type Config struct {
		Token *SecureString `json:"token"`
		URL   string        `json:"url"`
	}
	cfg := Config{Token: NewSecureString("secret"), URL: "http://example.com"}
	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("Marshal error: %v", err)
	}
	// The token should be redacted, URL should be present
	var parsed map[string]any
	json.Unmarshal(data, &parsed)
	if parsed["token"] != "[REDACTED]" {
		t.Fatalf("token in JSON = %v, want [REDACTED]", parsed["token"])
	}
	if parsed["url"] != "http://example.com" {
		t.Fatalf("url in JSON = %v, want http://example.com", parsed["url"])
	}
}
