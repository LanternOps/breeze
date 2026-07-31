// Package obfuscate provides trivial XOR encoding for string literals that
// must not appear in plaintext inside shipped agent binaries.
//
// WHY THIS EXISTS (issue #2797): the threat-signature table in
// internal/security and the command blocklist in internal/executor reference
// well-known malware names and test strings (e.g. the standard 68-byte AV
// test-file pattern). When those are plain Go string/[]byte literals they are
// compiled verbatim into the binary's data section, and antivirus engines then
// flag breeze-agent.exe / breeze-user-helper.exe as malware (confirmed on
// VirusTotal). Storing the literals XOR-encoded and
// decoding them at runtime keeps them out of the binary image while leaving
// behavior unchanged. The CI guard
// scripts/security/check-agent-binary-signatures.sh verifies built binaries
// contain none of the plaintext tokens.
//
// This is NOT a security or secrecy mechanism — it is a single-byte XOR whose
// only job is to keep byte-for-byte token matches out of the on-disk binary.
//
// Regenerating encoded literals: XOR each byte of the plaintext with Key
// (0x5A). One-liner (do not commit the plaintext anywhere in the repo):
//
//	go run - <<'EOF'
//	package main
//	import "fmt"
//	func main() {
//		s := "plaintext-token-here"
//		for i := 0; i < len(s); i++ { fmt.Printf("0x%02x, ", s[i]^0x5a) }
//		fmt.Println()
//	}
//	EOF
package obfuscate

// Key is the single-byte XOR key applied to every encoded literal.
const Key = 0x5A

// DecodeBytes returns a new slice with every byte of b XORed with Key.
// Because XOR is its own inverse, the same function encodes plaintext.
func DecodeBytes(b []byte) []byte {
	out := make([]byte, len(b))
	for i, c := range b {
		out[i] = c ^ Key
	}
	return out
}

// Decode returns the decoded form of b as a string.
func Decode(b []byte) string {
	return string(DecodeBytes(b))
}
