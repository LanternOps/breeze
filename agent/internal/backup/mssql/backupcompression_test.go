package mssql

import (
	"fmt"
	"strings"
	"testing"
)

// (c) WITH COMPRESSION is omitted for an Express edition, and included
// otherwise.
func TestIsExpressEdition(t *testing.T) {
	tests := []struct {
		edition string
		want    bool
	}{
		{"Express Edition (64-bit)", true},
		{"Express Edition with Advanced Services (64-bit)", true},
		{"Enterprise Edition (64-bit)", false},
		{"Standard Edition (64-bit)", false},
		{"Developer Edition (64-bit)", false},
		{"", false},
	}
	for _, tt := range tests {
		if got := isExpressEdition(tt.edition); got != tt.want {
			t.Errorf("isExpressEdition(%q) = %v, want %v", tt.edition, got, tt.want)
		}
	}
}

func TestBuildBackupQuery_OmitsCompressionForExpressEdition(t *testing.T) {
	include := !isExpressEdition("Express Edition (64-bit)")
	if include {
		t.Fatal("expected compression to be omitted for Express edition")
	}
	q := buildBackupQuery("TestDB", `C:\Backups\breeze\TestDB_full.bak`, "full", include)
	if strings.Contains(q, "COMPRESSION") {
		t.Fatalf("expected no COMPRESSION in query for Express edition, got %q", q)
	}
}

func TestBuildBackupQuery_IncludesCompressionForNonExpressEdition(t *testing.T) {
	include := !isExpressEdition("Enterprise Edition (64-bit)")
	if !include {
		t.Fatal("expected compression to be included for Enterprise edition")
	}
	q := buildBackupQuery("TestDB", `C:\Backups\breeze\TestDB_full.bak`, "full", include)
	if !strings.Contains(q, "COMPRESSION") {
		t.Fatalf("expected COMPRESSION in query for Enterprise edition, got %q", q)
	}
}

// (e) the full/differential/log statements are otherwise unchanged: only
// the COMPRESSION keyword's presence should vary.
func TestBuildBackupQuery_StatementsUnchangedAsideFromCompression(t *testing.T) {
	tests := []struct {
		backupType         string
		includeCompression bool
		want               string
	}{
		{"full", true, "BACKUP DATABASE [TestDB] TO DISK='C:\\Backups\\breeze\\TestDB_full.bak' WITH COMPRESSION, INIT, STATS=10"},
		{"full", false, "BACKUP DATABASE [TestDB] TO DISK='C:\\Backups\\breeze\\TestDB_full.bak' WITH INIT, STATS=10"},
		{"differential", true, "BACKUP DATABASE [TestDB] TO DISK='C:\\Backups\\breeze\\TestDB_full.bak' WITH DIFFERENTIAL, COMPRESSION, INIT, STATS=10"},
		{"differential", false, "BACKUP DATABASE [TestDB] TO DISK='C:\\Backups\\breeze\\TestDB_full.bak' WITH DIFFERENTIAL, INIT, STATS=10"},
		{"log", true, "BACKUP LOG [TestDB] TO DISK='C:\\Backups\\breeze\\TestDB_full.bak' WITH COMPRESSION, INIT, STATS=10"},
		{"log", false, "BACKUP LOG [TestDB] TO DISK='C:\\Backups\\breeze\\TestDB_full.bak' WITH INIT, STATS=10"},
	}
	for _, tt := range tests {
		t.Run(fmt.Sprintf("%s_compression=%v", tt.backupType, tt.includeCompression), func(t *testing.T) {
			got := buildBackupQuery("TestDB", `C:\Backups\breeze\TestDB_full.bak`, tt.backupType, tt.includeCompression)
			if got != tt.want {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestLooksLikeCompressionUnsupportedError(t *testing.T) {
	positive := "Msg 1844, Level 16, State 1, Server X, Line 1\nBACKUP DATABASE WITH COMPRESSION is not supported on Express Edition.\n"
	if !looksLikeCompressionUnsupportedError(positive) {
		t.Fatalf("expected Msg 1844 output to be recognized as compression-unsupported: %q", positive)
	}
	negative := "Msg 3201, Level 16, State 1, Server X, Line 1\nCannot open backup device. Operating system error 5(Access is denied.).\n"
	if looksLikeCompressionUnsupportedError(negative) {
		t.Fatalf("did not expect an unrelated SQL error to be recognized as compression-unsupported: %q", negative)
	}
}

// (d) a Msg 1844 response triggers exactly one retry without COMPRESSION.
func TestExecuteBackupStatement_RetriesOnceWithoutCompressionOnMsg1844(t *testing.T) {
	resetTrustCertProbe(t)

	r := &recordingRunner{responses: []fakeResponse{
		{out: []byte("Msg 1844, Level 16, State 1, Server X, Line 1\nBACKUP DATABASE WITH COMPRESSION is not supported on Express Edition.\n")},
		{out: []byte("10 percent processed.\nBACKUP DATABASE successfully processed 100 pages in 1.234 seconds (0.634 MB/sec).\n")},
	}}
	withRecordingRunner(t, r)

	out, compressed, err := executeBackupStatement(".", "TestDB", `C:\Backups\breeze\TestDB_full.bak`, "full", true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if compressed {
		t.Fatal("expected compressed=false after the Msg 1844 retry")
	}
	if !strings.Contains(out, "successfully processed") {
		t.Fatalf("expected the retry's output to be returned, got %q", out)
	}
	if len(r.calls) != 2 {
		t.Fatalf("expected exactly 2 sqlcmd invocations (attempt + one retry), got %d: %v", len(r.calls), r.calls)
	}
	if !strings.Contains(r.calls[0], "COMPRESSION") {
		t.Fatalf("first attempt should include COMPRESSION, got %q", r.calls[0])
	}
	if strings.Contains(r.calls[1], "COMPRESSION") {
		t.Fatalf("retry must not include COMPRESSION, got %q", r.calls[1])
	}
}

// When compression was never requested, a Msg 1844-shaped output (which
// shouldn't occur, but just in case) must not trigger a retry loop.
func TestExecuteBackupStatement_NoRetryWhenCompressionNotRequested(t *testing.T) {
	resetTrustCertProbe(t)

	r := &recordingRunner{responses: []fakeResponse{
		{out: []byte("10 percent processed.\nBACKUP DATABASE successfully processed 100 pages in 1.234 seconds (0.634 MB/sec).\n")},
	}}
	withRecordingRunner(t, r)

	_, compressed, err := executeBackupStatement(".", "TestDB", `C:\Backups\breeze\TestDB_full.bak`, "full", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if compressed {
		t.Fatal("expected compressed=false when compression was never requested")
	}
	if len(r.calls) != 1 {
		t.Fatalf("expected exactly 1 sqlcmd invocation, got %d: %v", len(r.calls), r.calls)
	}
}

// A successful compressed backup (no Msg 1844) must not retry.
func TestExecuteBackupStatement_NoRetryWhenCompressionSucceeds(t *testing.T) {
	resetTrustCertProbe(t)

	r := &recordingRunner{responses: []fakeResponse{
		{out: []byte("10 percent processed.\nBACKUP DATABASE successfully processed 100 pages in 1.234 seconds (0.634 MB/sec).\n")},
	}}
	withRecordingRunner(t, r)

	_, compressed, err := executeBackupStatement(".", "TestDB", `C:\Backups\breeze\TestDB_full.bak`, "full", true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !compressed {
		t.Fatal("expected compressed=true when the compressed attempt succeeds")
	}
	if len(r.calls) != 1 {
		t.Fatalf("expected exactly 1 sqlcmd invocation, got %d: %v", len(r.calls), r.calls)
	}
}
