package bmr

import (
	"context"
	"errors"
	"path"
	"strings"
	"testing"
)

func TestWindowsRestorePathError(t *testing.T) {
	cases := []struct {
		path string
		ok   bool
	}{
		{`C:\data\report.docx`, true},
		{`\\?\C:\data\report.docx`, true},
		{`\\.\C:\data\report.docx`, true},
		{`\\server\share\dir\file.txt`, true},
		{`C:\data\host.txt:extra`, false},
		{`C:\data\x::$DATA`, false},
		{`C:\data\name.`, false},
		{`C:\data\name \file`, false},
		{`C:\dir:ads\file`, false},
	}
	for _, tc := range cases {
		err := windowsRestorePathError(tc.path)
		if (err == nil) != tc.ok {
			t.Fatalf("windowsRestorePathError(%q) = %v, want ok=%v", tc.path, err, tc.ok)
		}
	}
}

func TestRestoreFiles_WindowsHostRefusesStreamAndAliasNames(t *testing.T) {
	withRecoverHost(t, "windows")
	downloads := 0
	provider := &breakerFakeProvider{downloadErr: func(int) error { downloads++; return errors.New("unexpected download") }}
	manifest := &snapshotManifest{ID: "snap-w", Files: []manifestFile{
		{SourcePath: `C:\data\host.txt:extra`, BackupPath: path.Join("snapshots", "snap-w", "files", "a"), Size: 1},
		{SourcePath: `C:\data\trailing.`, BackupPath: path.Join("snapshots", "snap-w", "files", "b"), Size: 1},
	}}
	_, _, warnings, failed, _ := restoreFiles(context.Background(), manifest, RecoveryConfig{}, provider)
	if failed != 2 || downloads != 0 {
		t.Fatalf("failed=%d downloads=%d, want 2 refused before any download", failed, downloads)
	}
	if !strings.Contains(strings.Join(warnings, "\n"), "invalid_windows_name") {
		t.Fatalf("warnings %v lack invalid_windows_name", warnings)
	}
}
