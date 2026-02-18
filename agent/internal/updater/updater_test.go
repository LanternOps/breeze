package updater

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestNewCreatesUpdater(t *testing.T) {
	cfg := &Config{
		ServerURL:      "http://localhost:3001",
		AuthToken:      "brz_test",
		CurrentVersion: "0.1.0",
		BinaryPath:     "/usr/local/bin/breeze-agent",
		BackupPath:     "/usr/local/bin/breeze-agent.backup",
	}
	u := New(cfg)
	if u == nil {
		t.Fatal("New returned nil")
	}
	if u.config != cfg {
		t.Fatal("config not stored")
	}
	if u.client == nil {
		t.Fatal("HTTP client not created")
	}
}

func TestVerifyChecksumValid(t *testing.T) {
	content := []byte("hello breeze agent binary")

	tmpFile, err := os.CreateTemp("", "updater-test-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(tmpFile.Name())

	if _, err := tmpFile.Write(content); err != nil {
		t.Fatal(err)
	}
	tmpFile.Close()

	hasher := sha256.New()
	hasher.Write(content)
	checksum := hex.EncodeToString(hasher.Sum(nil))

	u := New(&Config{})
	if err := u.verifyChecksum(tmpFile.Name(), checksum); err != nil {
		t.Fatalf("valid checksum should pass: %v", err)
	}
}

func TestVerifyChecksumInvalid(t *testing.T) {
	tmpFile, err := os.CreateTemp("", "updater-test-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(tmpFile.Name())

	tmpFile.Write([]byte("actual content"))
	tmpFile.Close()

	u := New(&Config{})
	err = u.verifyChecksum(tmpFile.Name(), "0000000000000000000000000000000000000000000000000000000000000000")
	if err == nil {
		t.Fatal("invalid checksum should fail")
	}
}

func TestVerifyChecksumFileNotFound(t *testing.T) {
	u := New(&Config{})
	err := u.verifyChecksum("/nonexistent/file", "abc")
	if err == nil {
		t.Fatal("nonexistent file should return error")
	}
}

func TestBackupCurrentBinary(t *testing.T) {
	tmpDir := t.TempDir()
	binaryPath := filepath.Join(tmpDir, "breeze-agent")
	backupPath := filepath.Join(tmpDir, "breeze-agent.backup")

	// Create a "binary"
	if err := os.WriteFile(binaryPath, []byte("v0.1.0 binary"), 0755); err != nil {
		t.Fatal(err)
	}

	u := New(&Config{
		BinaryPath: binaryPath,
		BackupPath: backupPath,
	})

	if err := u.backupCurrentBinary(); err != nil {
		t.Fatalf("backup failed: %v", err)
	}

	// Verify backup exists and matches
	backup, err := os.ReadFile(backupPath)
	if err != nil {
		t.Fatalf("failed to read backup: %v", err)
	}
	if string(backup) != "v0.1.0 binary" {
		t.Fatalf("backup content mismatch: %s", string(backup))
	}

	// Verify permissions match
	origInfo, _ := os.Stat(binaryPath)
	backupInfo, _ := os.Stat(backupPath)
	if origInfo.Mode() != backupInfo.Mode() {
		t.Fatalf("permissions mismatch: orig=%v backup=%v", origInfo.Mode(), backupInfo.Mode())
	}
}

func TestReplaceBinary(t *testing.T) {
	tmpDir := t.TempDir()
	binaryPath := filepath.Join(tmpDir, "breeze-agent")
	newBinaryPath := filepath.Join(tmpDir, "new-binary")

	// Create current and new binaries
	os.WriteFile(binaryPath, []byte("old"), 0755)
	os.WriteFile(newBinaryPath, []byte("new version"), 0644)

	u := New(&Config{
		BinaryPath: binaryPath,
	})

	if err := u.replaceBinary(newBinaryPath); err != nil {
		t.Fatalf("replace failed: %v", err)
	}

	content, _ := os.ReadFile(binaryPath)
	if string(content) != "new version" {
		t.Fatalf("binary content not replaced: %s", string(content))
	}

	// Verify executable permission on Unix
	info, _ := os.Stat(binaryPath)
	if info.Mode().Perm()&0111 == 0 {
		t.Fatal("binary should be executable after replacement")
	}
}

func TestRollback(t *testing.T) {
	tmpDir := t.TempDir()
	binaryPath := filepath.Join(tmpDir, "breeze-agent")
	backupPath := filepath.Join(tmpDir, "breeze-agent.backup")

	// Create current (corrupted) and backup
	os.WriteFile(binaryPath, []byte("corrupted"), 0755)
	os.WriteFile(backupPath, []byte("good v0.1.0"), 0755)

	u := New(&Config{
		BinaryPath: binaryPath,
		BackupPath: backupPath,
	})

	if err := u.Rollback(); err != nil {
		t.Fatalf("rollback failed: %v", err)
	}

	content, _ := os.ReadFile(binaryPath)
	if string(content) != "good v0.1.0" {
		t.Fatalf("rollback didn't restore backup: %s", string(content))
	}
}

func TestRollbackNoBackup(t *testing.T) {
	u := New(&Config{
		BinaryPath: "/tmp/nonexistent",
		BackupPath: "/tmp/nonexistent.backup",
	})

	err := u.Rollback()
	if err == nil {
		t.Fatal("rollback should fail when no backup exists")
	}
}

func TestDownloadBinary(t *testing.T) {
	binaryContent := []byte("fake binary v1.0.0")
	hasher := sha256.New()
	hasher.Write(binaryContent)
	checksum := hex.EncodeToString(hasher.Sum(nil))

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v1/agent-versions/1.0.0/download":
			// Verify auth
			if r.Header.Get("Authorization") != "Bearer test-token" {
				t.Errorf("missing or wrong auth: %s", r.Header.Get("Authorization"))
			}

			platform := r.URL.Query().Get("platform")
			arch := r.URL.Query().Get("arch")
			if platform == "" || arch == "" {
				t.Error("missing platform or arch query params")
			}

			// Return JSON with download info
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(downloadInfo{
				URL:      "http://" + r.Host + "/binary/breeze-agent",
				Checksum: checksum,
			})

		case r.URL.Path == "/binary/breeze-agent":
			// Serve the actual binary
			w.Write(binaryContent)

		default:
			t.Errorf("unexpected request path: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	u := New(&Config{
		ServerURL: server.URL,
		AuthToken: "test-token",
	})
	u.client = server.Client()

	tempPath, gotChecksum, err := u.downloadBinary("1.0.0")
	if err != nil {
		t.Fatalf("download failed: %v", err)
	}
	defer os.Remove(tempPath)

	if gotChecksum != checksum {
		t.Fatalf("checksum mismatch: got %s, want %s", gotChecksum, checksum)
	}

	downloaded, _ := os.ReadFile(tempPath)
	if string(downloaded) != string(binaryContent) {
		t.Fatalf("downloaded content mismatch")
	}
}

func TestDownloadBinaryRedirectResponse(t *testing.T) {
	binaryContent := []byte("fake binary from redirect")
	hasher := sha256.New()
	hasher.Write(binaryContent)
	checksum := hex.EncodeToString(hasher.Sum(nil))

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v1/agent-versions/1.0.0/download":
			if r.Header.Get("Authorization") != "Bearer test-token" {
				t.Errorf("missing or wrong auth: %s", r.Header.Get("Authorization"))
			}
			w.Header().Set("X-Checksum", checksum)
			w.Header().Set("Location", "/binary/breeze-agent")
			w.WriteHeader(http.StatusFound)
		case r.URL.Path == "/binary/breeze-agent":
			w.Write(binaryContent)
		default:
			t.Errorf("unexpected request path: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	u := New(&Config{
		ServerURL: server.URL,
		AuthToken: "test-token",
	})
	u.client = server.Client()

	tempPath, gotChecksum, err := u.downloadBinary("1.0.0")
	if err != nil {
		t.Fatalf("download failed: %v", err)
	}
	defer os.Remove(tempPath)

	if gotChecksum != checksum {
		t.Fatalf("checksum mismatch: got %s, want %s", gotChecksum, checksum)
	}

	downloaded, _ := os.ReadFile(tempPath)
	if string(downloaded) != string(binaryContent) {
		t.Fatalf("downloaded content mismatch")
	}
}

func TestDownloadBinaryMissingChecksum(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// JSON response missing checksum
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"url": "http://" + r.Host + "/binary",
		})
	}))
	defer server.Close()

	u := New(&Config{ServerURL: server.URL})
	u.client = server.Client()

	_, _, err := u.downloadBinary("1.0.0")
	if err == nil {
		t.Fatal("should fail when checksum missing from JSON response")
	}
}

func TestDownloadBinaryServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	u := New(&Config{ServerURL: server.URL})
	u.client = server.Client()

	_, _, err := u.downloadBinary("1.0.0")
	if err == nil {
		t.Fatal("should fail on server error")
	}
}

func TestEndToEndUpdateWithoutRestart(t *testing.T) {
	tmpDir := t.TempDir()
	binaryPath := filepath.Join(tmpDir, "breeze-agent")
	backupPath := filepath.Join(tmpDir, "breeze-agent.backup")

	// Create current binary
	os.WriteFile(binaryPath, []byte("old binary"), 0755)

	newContent := []byte("new binary v1.0.0")
	hasher := sha256.New()
	hasher.Write(newContent)
	checksum := hex.EncodeToString(hasher.Sum(nil))

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v1/agent-versions/1.0.0/download":
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(downloadInfo{
				URL:      "http://" + r.Host + "/binary/breeze-agent",
				Checksum: checksum,
			})
		case r.URL.Path == "/binary/breeze-agent":
			w.Write(newContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	u := New(&Config{
		ServerURL:      server.URL,
		AuthToken:      "tok",
		CurrentVersion: "0.1.0",
		BinaryPath:     binaryPath,
		BackupPath:     backupPath,
	})
	u.client = server.Client()

	// We can't test the full UpdateTo because Restart() would fail,
	// but we can test the download -> verify -> backup -> replace pipeline manually
	tempPath, dlChecksum, err := u.downloadBinary("1.0.0")
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	defer os.Remove(tempPath)

	if err := u.verifyChecksum(tempPath, dlChecksum); err != nil {
		t.Fatalf("verify: %v", err)
	}

	if err := u.backupCurrentBinary(); err != nil {
		t.Fatalf("backup: %v", err)
	}

	if err := u.replaceBinary(tempPath); err != nil {
		t.Fatalf("replace: %v", err)
	}

	// Verify new binary is in place
	content, _ := os.ReadFile(binaryPath)
	if string(content) != string(newContent) {
		t.Fatalf("binary not updated: %s", string(content))
	}

	// Verify backup is old binary
	backup, _ := os.ReadFile(backupPath)
	if string(backup) != "old binary" {
		t.Fatalf("backup not correct: %s", string(backup))
	}

	// Verify rollback works
	if err := u.Rollback(); err != nil {
		t.Fatalf("rollback: %v", err)
	}

	content, _ = os.ReadFile(binaryPath)
	if string(content) != "old binary" {
		t.Fatalf("rollback didn't restore: %s", string(content))
	}
}
