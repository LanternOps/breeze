// Package psscript is the one place the agent knows how a .ps1 file it writes
// must be encoded (#3574, #3581).
//
// Windows PowerShell 5.1 decodes a BOM-less .ps1 as the system ANSI codepage,
// so any non-ASCII UTF-8 content — an AI-generated curly quote, or an
// interpolated install path under a localized directory — turns into mojibake
// and either garbles output or breaks parsing. A leading UTF-8 BOM forces UTF-8
// decoding; pwsh on every platform accepts it too. Only .ps1 gets a BOM: bash
// would read it as part of the shebang, and cmd feeds it to the first command.
//
// This package deliberately imports nothing from the agent so the updater
// (which keeps a tiny dependency graph) can use it.
package psscript

import (
	"fmt"
	"os"
	"strings"
)

// BOM is the UTF-8 byte order mark.
const BOM = "\xEF\xBB\xBF"

// WithBOM returns content with exactly one leading UTF-8 BOM.
func WithBOM(content string) string {
	if strings.HasPrefix(content, BOM) {
		return content
	}
	return BOM + content
}

// CreateTemp writes content, BOM-stamped, to a new file in os.TempDir() named
// by pattern (as os.CreateTemp) and returns its path. On any failure the file
// is removed and no path is returned. Callers own the file afterwards.
func CreateTemp(pattern, content string) (string, error) {
	f, err := os.CreateTemp("", pattern)
	if err != nil {
		return "", err
	}
	name := f.Name()
	if _, err := f.WriteString(WithBOM(content)); err != nil {
		_ = f.Close()
		_ = os.Remove(name)
		return "", fmt.Errorf("write %s: %w", name, err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(name)
		return "", fmt.Errorf("close %s: %w", name, err)
	}
	return name, nil
}
