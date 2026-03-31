package userhelper

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

func TestHashReaderSHA256(t *testing.T) {
	t.Parallel()

	input := "breeze-user-helper"
	got, err := hashReaderSHA256(strings.NewReader(input))
	if err != nil {
		t.Fatalf("hashReaderSHA256: %v", err)
	}
	sum := sha256.Sum256([]byte(input))
	want := hex.EncodeToString(sum[:])
	if got != want {
		t.Fatalf("hashReaderSHA256 = %q, want %q", got, want)
	}
}
