package secmem

import (
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"

	"github.com/breeze-rmm/agent/internal/logging"
)

var log = logging.L("secmem")

// SecureString holds sensitive data with best-effort memory zeroing.
// Go's GC may copy the backing array, so this is defense-in-depth, not a
// guarantee. Call Zero() in shutdown paths to overwrite the token in place.
//
// String() returns [REDACTED] to prevent accidental leaking via fmt.Stringer.
// Use Reveal() to get the plaintext value explicitly.
type SecureString struct {
	mu         sync.Mutex
	data       []byte
	zeroed     atomic.Bool
	warnedOnce atomic.Bool
}

// NewSecureString creates a SecureString from the given string.
func NewSecureString(s string) *SecureString {
	b := make([]byte, len(s))
	copy(b, s)
	return &SecureString{data: b}
}

// Reveal returns the plaintext value. Use only at the point of actual use
// (e.g., constructing an HTTP Authorization header).
// Returns "" if the receiver is nil or the data has been zeroed.
// Logs a warning once after Zero() to aid debugging without log spam.
func (s *SecureString) Reveal() string {
	if s == nil {
		return ""
	}
	s.mu.Lock()
	isZeroed := s.data == nil && s.zeroed.Load()
	val := string(s.data)
	s.mu.Unlock()

	if isZeroed {
		if s.warnedOnce.CompareAndSwap(false, true) {
			log.Warn("Reveal() called after Zero() — token has been wiped")
		}
		return ""
	}
	return val
}

// IsZeroed returns true if Zero() has been called.
func (s *SecureString) IsZeroed() bool {
	if s == nil {
		return false
	}
	return s.zeroed.Load()
}

// String returns [REDACTED] to prevent accidental plaintext leaking via
// fmt.Println(token) or similar fmt.Stringer usage.
func (s *SecureString) String() string {
	return "[REDACTED]"
}

// GoString returns a redacted representation to prevent accidental logging
// via fmt.Printf("%#v", token).
func (s *SecureString) GoString() string {
	return "[REDACTED]"
}

// Format implements fmt.Formatter to ensure all format verbs produce [REDACTED].
func (s *SecureString) Format(f fmt.State, verb rune) {
	fmt.Fprint(f, "[REDACTED]")
}

// MarshalJSON returns "[REDACTED]" to prevent JSON serialization of plaintext.
func (s *SecureString) MarshalJSON() ([]byte, error) {
	return json.Marshal("[REDACTED]")
}

// MarshalText returns [REDACTED] to prevent text serialization of plaintext.
func (s *SecureString) MarshalText() ([]byte, error) {
	return []byte("[REDACTED]"), nil
}

// Zero overwrites the backing byte slice with zeros.
func (s *SecureString) Zero() {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.data {
		s.data[i] = 0
	}
	s.data = nil
	s.zeroed.Store(true)
}

// UnmarshalJSON rejects deserialization to prevent accidentally populating a
// SecureString from untrusted JSON input.
func (s *SecureString) UnmarshalJSON(data []byte) error {
	return fmt.Errorf("secmem: cannot deserialize into SecureString")
}
