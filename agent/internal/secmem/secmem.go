package secmem

// SecureString holds sensitive data with best-effort memory zeroing.
// Go's GC may copy the backing array, so this is defense-in-depth, not a
// guarantee. Call Zero() in shutdown paths to overwrite the token in place.
type SecureString struct {
	data []byte
}

// NewSecureString creates a SecureString from the given string.
func NewSecureString(s string) *SecureString {
	b := make([]byte, len(s))
	copy(b, s)
	return &SecureString{data: b}
}

// String returns the plaintext value.
func (s *SecureString) String() string {
	if s == nil || s.data == nil {
		return ""
	}
	return string(s.data)
}

// GoString returns a redacted representation to prevent accidental logging
// via fmt.Printf("%#v", token).
func (s *SecureString) GoString() string {
	return "[REDACTED]"
}

// Zero overwrites the backing byte slice with zeros.
func (s *SecureString) Zero() {
	if s == nil || s.data == nil {
		return
	}
	for i := range s.data {
		s.data[i] = 0
	}
	s.data = nil
}
