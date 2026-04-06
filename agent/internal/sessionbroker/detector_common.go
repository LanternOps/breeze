package sessionbroker

import (
	"bufio"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	detectorCommandTimeout  = 5 * time.Second
	maxDetectedSessions     = 256
	maxDetectedFieldBytes   = 256
	maxDetectorScannerBytes = 1024 * 1024
)

func newDetectorScanner(input string) *bufio.Scanner {
	scanner := bufio.NewScanner(strings.NewReader(input))
	scanner.Buffer(make([]byte, 0, 64*1024), maxDetectorScannerBytes)
	return scanner
}

func sanitizeDetectedField(value string, required bool) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		if required {
			return "", fmt.Errorf("required detected-session field is empty")
		}
		return "", nil
	}
	if len(value) > maxDetectedFieldBytes {
		return "", fmt.Errorf("detected-session field exceeds %d bytes", maxDetectedFieldBytes)
	}
	for _, r := range value {
		if r < 0x20 || r == 0x7f || !utf8.ValidRune(r) {
			return "", fmt.Errorf("detected-session field contains control characters")
		}
	}
	return value, nil
}

func sanitizeDetectedSession(session DetectedSession) (DetectedSession, error) {
	var err error
	if session.Username, err = sanitizeDetectedField(session.Username, true); err != nil {
		return DetectedSession{}, fmt.Errorf("invalid username: %w", err)
	}
	if session.Session, err = sanitizeDetectedField(session.Session, true); err != nil {
		return DetectedSession{}, fmt.Errorf("invalid session: %w", err)
	}
	if session.Display, err = sanitizeDetectedField(session.Display, false); err != nil {
		return DetectedSession{}, fmt.Errorf("invalid display: %w", err)
	}
	if session.Seat, err = sanitizeDetectedField(session.Seat, false); err != nil {
		return DetectedSession{}, fmt.Errorf("invalid seat: %w", err)
	}
	if session.State, err = sanitizeDetectedField(session.State, false); err != nil {
		return DetectedSession{}, fmt.Errorf("invalid state: %w", err)
	}
	if session.Type, err = sanitizeDetectedField(session.Type, false); err != nil {
		return DetectedSession{}, fmt.Errorf("invalid type: %w", err)
	}
	return session, nil
}
