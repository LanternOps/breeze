package obfuscate

import (
	"bytes"
	"testing"
)

// XOR with a fixed key is its own inverse, so DecodeBytes doubles as the
// encoder. These tests pin that round-trip property.
func TestDecodeBytesRoundTrip(t *testing.T) {
	cases := []struct {
		name  string
		input []byte
	}{
		{"empty", []byte{}},
		{"single byte", []byte{0x00}},
		{"key byte itself", []byte{Key}},
		{"ascii text", []byte("hello, world")},
		{"binary with high bytes", []byte{0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			encoded := DecodeBytes(tc.input)
			decoded := DecodeBytes(encoded)
			if !bytes.Equal(decoded, tc.input) {
				t.Fatalf("round trip mismatch: got %v, want %v", decoded, tc.input)
			}
			if len(tc.input) > 0 && bytes.Equal(encoded, tc.input) {
				t.Fatalf("encoding was a no-op for %q", tc.input)
			}
		})
	}
}

func TestDecodeBytesAllByteValues(t *testing.T) {
	input := make([]byte, 256)
	for i := range input {
		input[i] = byte(i)
	}
	if got := DecodeBytes(DecodeBytes(input)); !bytes.Equal(got, input) {
		t.Fatal("round trip over all 256 byte values failed")
	}
}

func TestDecodeMatchesDecodeBytes(t *testing.T) {
	input := []byte("some encoded payload")
	encoded := DecodeBytes(input)
	if got, want := Decode(encoded), string(input); got != want {
		t.Fatalf("Decode = %q, want %q", got, want)
	}
}

func TestDecodeBytesDoesNotMutateInput(t *testing.T) {
	input := []byte{0x01, 0x02, 0x03}
	original := append([]byte(nil), input...)
	_ = DecodeBytes(input)
	if !bytes.Equal(input, original) {
		t.Fatal("DecodeBytes mutated its input slice")
	}
}
