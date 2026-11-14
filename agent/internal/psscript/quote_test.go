package psscript

import (
	"bytes"
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"
)

// quoteTestValues covers the characters PowerShell treats specially in and
// around a single-quoted literal, plus ordinary text.
var quoteTestValues = []string{
	"",
	"plain",
	`C:\Program Files\Breeze\breeze-agent.exe`,
	"it's",
	"''",
	"O\u2018Brien",
	"O\u2019Brien",
	"low\u201aquote",
	"reversed\u201bquote",
	"\u2019\u2019\u2019",
	"'\u2018\u2019\u201a\u201b",
	"Vendor\u2019s task; Daily",
	`$env:PATH and $(Get-Date) and ` + "`" + `n stay literal`,
	`"double" ` + "\u201cquotes\u201d",
	"line one\nline two\r\nline three",
	"tab\there",
	"unicode \u00e9\u4e2d\U0001F600",
}

func TestEscapeSingleQuoted(t *testing.T) {
	tests := []struct {
		in, want string
	}{
		{"", ""},
		{"plain", "plain"},
		{"it's", "it''s"},
		{"\u2018", "\u2018\u2018"},
		{"\u2019", "\u2019\u2019"},
		{"\u201a", "\u201a\u201a"},
		{"\u201b", "\u201b\u201b"},
		{"a'\u2019b", "a''\u2019\u2019b"},
		{`$x "y" ` + "`z", `$x "y" ` + "`z"},
	}
	for _, tt := range tests {
		if got := EscapeSingleQuoted(tt.in); got != tt.want {
			t.Errorf("EscapeSingleQuoted(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestQuoteWrapsEscapedValue(t *testing.T) {
	if got, want := Quote("a\u2019b"), "'a\u2019\u2019b'"; got != want {
		t.Fatalf("Quote = %q, want %q", got, want)
	}
}

// scanSingleQuoted mirrors how PowerShell's tokenizer reads a single-quoted
// string literal: any of the five single-quote characters opens and closes it,
// and two consecutive single-quote characters stand for the second one. It
// returns the literal's value and the number of bytes the literal occupies.
func scanSingleQuoted(t *testing.T, src string) (string, int) {
	t.Helper()
	isQuote := func(r rune) bool {
		switch r {
		case '\'', '\u2018', '\u2019', '\u201a', '\u201b':
			return true
		}
		return false
	}
	r, size := utf8.DecodeRuneInString(src)
	if !isQuote(r) {
		t.Fatalf("literal %q does not start with a single quote", src)
	}
	var b strings.Builder
	i := size
	for i < len(src) {
		r, size = utf8.DecodeRuneInString(src[i:])
		i += size
		if isQuote(r) {
			next, nextSize := utf8.DecodeRuneInString(src[i:])
			if i < len(src) && isQuote(next) {
				b.WriteRune(next)
				i += nextSize
				continue
			}
			return b.String(), i
		}
		b.WriteRune(r)
	}
	t.Fatalf("literal %q is not terminated", src)
	return "", 0
}

func checkQuoteRoundTrip(t *testing.T, value string) {
	t.Helper()
	quoted := Quote(value)
	// Append text after the literal: the literal must end exactly where
	// Quote's output ends, never earlier.
	got, n := scanSingleQuoted(t, quoted+" -Next")
	if got != value {
		t.Fatalf("Quote(%q) reads back as %q", value, got)
	}
	if n != len(quoted) {
		t.Fatalf("Quote(%q) = %q: literal ends after %d bytes, want %d", value, quoted, n, len(quoted))
	}
}

func TestQuoteReadsBackAsOneLiteral(t *testing.T) {
	for _, v := range quoteTestValues {
		checkQuoteRoundTrip(t, v)
	}
}

func FuzzQuoteReadsBackAsOneLiteral(f *testing.F) {
	for _, v := range quoteTestValues {
		f.Add(v)
	}
	f.Fuzz(func(t *testing.T, value string) {
		if !utf8.ValidString(value) {
			t.Skip()
		}
		checkQuoteRoundTrip(t, value)
	})
}

// TestQuoteRoundTripsInPowerShell runs the quoted values through a real
// PowerShell when one is installed: each value must come back unchanged and
// the script must produce nothing else.
func TestQuoteRoundTripsInPowerShell(t *testing.T) {
	pwsh, err := exec.LookPath("pwsh")
	if err != nil {
		t.Skip("pwsh not installed")
	}
	var script strings.Builder
	for _, v := range quoteTestValues {
		script.WriteString("$v = " + Quote(v) + "\n")
		script.WriteString("[Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$v)))\n")
	}
	path := filepath.Join(t.TempDir(), "quote.ps1")
	if err := os.WriteFile(path, []byte(WithBOM(script.String())), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(pwsh, "-NoProfile", "-NonInteractive", "-File", path)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("pwsh: %v\n%s", err, stderr.String())
	}
	lines := strings.Split(strings.TrimRight(strings.ReplaceAll(string(out), "\r\n", "\n"), "\n"), "\n")
	if len(lines) != len(quoteTestValues) {
		t.Fatalf("pwsh printed %d lines, want %d:\n%s\nstderr:\n%s", len(lines), len(quoteTestValues), out, stderr.String())
	}
	for i, v := range quoteTestValues {
		got, err := base64.StdEncoding.DecodeString(lines[i])
		if err != nil {
			t.Fatalf("line %d: %v", i, err)
		}
		if string(got) != v {
			t.Errorf("value %d: PowerShell read %q, want %q", i, got, v)
		}
	}
}

// TestNoASCIIOnlySingleQuoteEscaping keeps PowerShell literal quoting in this
// package: escaping only the ASCII apostrophe leaves the typographic single
// quotes (which PowerShell also accepts as delimiters) unescaped. T-SQL
// literals in the SQL Server backup code follow T-SQL's own rules and are
// not PowerShell.
func TestNoASCIIOnlySingleQuoteEscaping(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	self, err := filepath.Abs(".")
	if err != nil {
		t.Fatal(err)
	}
	tsql := filepath.Join(root, "internal", "backup", "mssql")
	// The apostrophe and its doubled form, as interpreted or raw string literals.
	const one, two = "(\"'\"|`'`)", "(\"''\"|`''`)"
	pattern := regexp.MustCompile(`(ReplaceAll|Replace)\([^()]*,\s*` + one + `,\s*` + two + `|NewReplacer\(\s*` + one + `,\s*` + two)
	var offenders []string
	err = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			name := d.Name()
			if path != root && (path == self || path == tsql || name == "vendor" || name == "testdata" || strings.HasPrefix(name, ".")) {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for i, line := range strings.Split(string(b), "\n") {
			if pattern.MatchString(line) {
				rel, _ := filepath.Rel(root, path)
				offenders = append(offenders, rel+":"+strconv.Itoa(i+1)+": "+strings.TrimSpace(line))
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(offenders) > 0 {
		t.Fatalf("quote PowerShell literals with psscript.Quote / psscript.EscapeSingleQuoted:\n%s",
			strings.Join(offenders, "\n"))
	}
}
