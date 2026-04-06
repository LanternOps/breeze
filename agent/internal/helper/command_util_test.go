package helper

import (
	"strings"
	"testing"
)

func TestParseConsoleUIDOutput(t *testing.T) {
	t.Parallel()

	uid, err := parseConsoleUIDOutput([]byte("501\n"))
	if err != nil {
		t.Fatalf("parseConsoleUIDOutput(valid) error = %v", err)
	}
	if uid != "501" {
		t.Fatalf("uid = %q, want 501", uid)
	}

	for _, input := range [][]byte{
		[]byte(""),
		[]byte("abc"),
		[]byte("50 1"),
		[]byte(strings.Repeat("1", maxHelperSessionKeyLen+1)),
	} {
		if _, err := parseConsoleUIDOutput(input); err == nil {
			t.Fatalf("expected parseConsoleUIDOutput(%q) to fail", string(input))
		}
	}
}

func TestParseProcessPathOutput(t *testing.T) {
	t.Parallel()

	path, err := parseProcessPathOutput([]byte("/Applications/Breeze Helper.app/Contents/MacOS/breeze-helper\n"))
	if err != nil {
		t.Fatalf("parseProcessPathOutput(valid) error = %v", err)
	}
	if path != "/Applications/Breeze Helper.app/Contents/MacOS/breeze-helper" {
		t.Fatalf("path = %q", path)
	}

	if _, err := parseProcessPathOutput([]byte(strings.Repeat("a", maxHelperFieldBytes+1))); err == nil {
		t.Fatal("expected oversized process path to fail")
	}
}

func TestParseMigrationTargetsOutput(t *testing.T) {
	t.Parallel()

	out := []byte("1 501 seat0\n2 0 seat0\n3 bad seat0\n4 501 seat0\n")
	targets := parseMigrationTargetsOutput(out)
	if len(targets) != 1 || targets[0] != "501" {
		t.Fatalf("parseMigrationTargetsOutput = %+v, want [501]", targets)
	}
}
