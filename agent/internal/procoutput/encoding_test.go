package procoutput

import (
	"encoding/json"
	"runtime"
	"strings"
	"testing"
)

func TestBytesToUTF8Empty(t *testing.T) {
	if got := BytesToUTF8(nil); got != "" {
		t.Fatalf("expected empty string, got %q", got)
	}
	if got := BytesToUTF8([]byte{}); got != "" {
		t.Fatalf("expected empty string, got %q", got)
	}
}

func TestBytesToUTF8ValidUTF8Passthrough(t *testing.T) {
	input := []byte("café résumé naïve 日本語 привет")
	got := BytesToUTF8(input)
	if got != string(input) {
		t.Fatalf("expected passthrough, got %q want %q", got, string(input))
	}

	payload, err := json.Marshal(map[string]string{"stdout": got})
	if err != nil {
		t.Fatalf("json.Marshal failed: %v", err)
	}
	if string(payload) == "" {
		t.Fatal("expected non-empty JSON payload")
	}
}

func TestDecodeFromWindowsCodePageCP850(t *testing.T) {
	raw := []byte{0x63, 0x61, 0x66, 0x82} // "caf" + é
	got, ok := decodeFromWindowsCodePage(raw, 850)
	if !ok {
		t.Fatal("expected CP850 decode to succeed")
	}
	if got != "café" {
		t.Fatalf("got %q, want %q", got, "café")
	}
}

func TestDecodeFromWindowsCodePageCP1252(t *testing.T) {
	raw := []byte{0x63, 0x61, 0x66, 0xE9}
	got, ok := decodeFromWindowsCodePage(raw, 1252)
	if !ok {
		t.Fatal("expected CP1252 decode to succeed")
	}
	if got != "café" {
		t.Fatalf("got %q, want %q", got, "café")
	}
}

func TestDecodeFromWindowsCodePageCP866(t *testing.T) {
	raw := []byte{0xE2, 0xA5, 0xE1, 0xE2} // "тест" in CP866
	got, ok := decodeFromWindowsCodePage(raw, 866)
	if !ok {
		t.Fatal("expected CP866 decode to succeed")
	}
	if got != "тест" {
		t.Fatalf("got %q, want %q", got, "тест")
	}
}

func TestDecodeFromWindowsCodePageUnmapped(t *testing.T) {
	raw := []byte{0x63, 0x61, 0x66, 0x82}
	if _, ok := decodeFromWindowsCodePage(raw, 999); ok {
		t.Fatal("expected unmapped code page to fail decoding")
	}
	if enc := charmapForCodePage(999); enc != nil {
		t.Fatal("expected unmapped code page to return nil encoder")
	}
}

func TestBytesToUTF8UnmappedCodePageFallsBackGracefully(t *testing.T) {
	raw := []byte{0x63, 0x61, 0x66, 0x82}
	got, ok := decodeFromWindowsCodePage(raw, 999)
	if ok {
		t.Fatalf("expected decode failure for unmapped CP, got %q", got)
	}

	fallback := BytesToUTF8(raw)
	if fallback == string(raw) {
		t.Fatal("expected invalid bytes to be sanitized on non-Windows")
	}
	if !strings.Contains(fallback, "\uFFFD") {
		t.Fatalf("expected replacement character in fallback, got %q", fallback)
	}
}

func TestBytesToUTF8InvalidBytesUseReplacementOnNonWindows(t *testing.T) {
	raw := []byte{0xFF, 0xFE, 0xFD}
	got := BytesToUTF8(raw)
	if got == string(raw) {
		t.Fatal("expected invalid bytes to be sanitized")
	}
}

func TestWindowsScriptCommandPowerShell(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows script bootstrap is platform-specific")
	}
	shellCmd, args := WindowsScriptCommand("powershell.exe", []string{"-NoProfile", "-File"}, `C:\scripts\test.ps1`)
	if shellCmd != "powershell.exe" {
		t.Fatalf("shellCmd = %q", shellCmd)
	}
	if len(args) < 4 || args[0] != "-NoProfile" || args[2] != "-Command" {
		t.Fatalf("unexpected args: %#v", args)
	}
	if args[len(args)-1] == "" {
		t.Fatal("expected bootstrap command")
	}
}

func TestWindowsScriptCommandCmd(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows script bootstrap is platform-specific")
	}
	shellCmd, args := WindowsScriptCommand("cmd.exe", []string{"/C"}, `C:\scripts\test.bat`)
	if shellCmd != "cmd.exe" {
		t.Fatalf("shellCmd = %q", shellCmd)
	}
	if len(args) != 2 || args[0] != "/C" {
		t.Fatalf("unexpected args: %#v", args)
	}
	if args[1] != "chcp 65001 >nul & C:\\scripts\\test.bat" {
		t.Fatalf("unexpected cmd bootstrap: %q", args[1])
	}
}
