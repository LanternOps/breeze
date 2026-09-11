package desktop

import (
	"embed"
	"go/parser"
	"go/token"
	"io/fs"
	"strconv"
	"strings"
	"testing"
)

// desktopSources embeds every Go source file in this package at compile time.
//
// Embedding rather than reading from disk keeps the contract valid when the
// package's test binary is cross-compiled and executed on a lab machine with
// no checkout. Embedding is also not build-constraint aware, so the scan
// covers the Windows-, macOS- and Linux-only files of this package no matter
// which GOOS the test binary was built for.
//
//go:embed *.go
var desktopSources embed.FS

const filedropImportPath = "github.com/breeze-rmm/agent/internal/remote/filedrop"

// forbiddenFileDropSinks are the concrete registration sites that would put an
// unaudited file-write path back on the wire.
var forbiddenFileDropSinks = []string{
	`CreateDataChannel("filedrop"`,
	`case "filedrop"`,
	"filedrop.NewFileDropHandler",
}

// TestDesktopDoesNotExposeUnauditedFileDropChannel is a source-boundary
// contract for the peer-to-peer desktop transport. The API server is not in
// this data path, so registering a filedrop channel here would let a viewer
// write files onto the endpoint without a server-resolved capability and
// without a durable central audit record.
//
// It is a source contract rather than a behavioural one because the channel
// registration sink cannot be exercised end to end in CI — StartSession needs
// a real display capturer. It scans the whole package, not just the WebRTC
// session file, so the channel cannot be reintroduced from a sibling transport
// (the WS manager, the control channel) either. A future file-transfer feature
// must replace this contract with end-to-end capability, audit, quota,
// ownership and cleanup tests before exposing a channel again.
func TestDesktopDoesNotExposeUnauditedFileDropChannel(t *testing.T) {
	names, err := fs.Glob(desktopSources, "*.go")
	if err != nil {
		t.Fatalf("glob embedded desktop sources: %v", err)
	}

	// Positive control: prove the embed actually produced this package's
	// sources before trusting a scan that finds nothing. A silently empty or
	// truncated embed would otherwise read as a pass.
	var scanned, totalBytes int
	sawSessionWebRTC := false

	for _, name := range names {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		raw, readErr := desktopSources.ReadFile(name)
		if readErr != nil {
			t.Fatalf("read embedded %s: %v", name, readErr)
		}
		src := string(raw)
		scanned++
		totalBytes += len(src)
		if name == "session_webrtc.go" {
			if !strings.Contains(src, `CreateDataChannel("cursor"`) {
				t.Fatalf("embedded session_webrtc.go is missing the cursor channel registration (%d bytes) — the scan would be vacuous", len(src))
			}
			sawSessionWebRTC = true
		}

		fset := token.NewFileSet()
		parsed, parseErr := parser.ParseFile(fset, name, src, parser.ImportsOnly)
		if parseErr != nil {
			t.Fatalf("parse imports of %s: %v", name, parseErr)
		}
		for _, imp := range parsed.Imports {
			path, uErr := strconv.Unquote(imp.Path.Value)
			if uErr == nil && path == filedropImportPath {
				t.Errorf("%s must not import %s: the desktop transport has no server-authorized, audited file path", name, filedropImportPath)
			}
		}

		for _, forbidden := range forbiddenFileDropSinks {
			if strings.Contains(src, forbidden) {
				t.Errorf("%s must not expose the unaudited filedrop path %q", name, forbidden)
			}
		}
	}

	if !sawSessionWebRTC {
		t.Fatalf("embedded sources did not include session_webrtc.go (scanned %d files) — the scan would be vacuous", scanned)
	}
	if scanned < 50 || totalBytes < 100_000 {
		t.Fatalf("embedded sources look truncated: %d files, %d bytes", scanned, totalBytes)
	}
}
