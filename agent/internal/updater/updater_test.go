package updater

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"testing"

	"github.com/breeze-rmm/agent/internal/secmem"
)

func signedDownloadInfo(t *testing.T, version, component, rawURL string, content []byte) downloadInfo {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	oldKeys := trustedUpdateManifestPublicKeys
	trustedUpdateManifestPublicKeys = []string{base64.StdEncoding.EncodeToString(publicKey)}
	t.Cleanup(func() {
		trustedUpdateManifestPublicKeys = oldKeys
	})

	sum := sha256.Sum256(content)
	manifest := updateManifest{
		Version:   version,
		Component: component,
		Platform:  manifestPlatform(),
		Arch:      runtime.GOARCH,
		URL:       rawURL,
		Checksum:  hex.EncodeToString(sum[:]),
		Size:      int64(len(content)),
	}
	payload, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	signature := ed25519.Sign(privateKey, payload)
	return downloadInfo{
		URL:               rawURL,
		Checksum:          manifest.Checksum,
		Manifest:          string(payload),
		ManifestSignature: base64.StdEncoding.EncodeToString(signature),
	}
}

func signedReleaseArtifactDownloadInfo(t *testing.T, version, assetName, rawURL string, content []byte) downloadInfo {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	oldKeys := trustedUpdateManifestPublicKeys
	trustedUpdateManifestPublicKeys = []string{base64.StdEncoding.EncodeToString(publicKey)}
	t.Cleanup(func() {
		trustedUpdateManifestPublicKeys = oldKeys
	})

	sum := sha256.Sum256(content)
	checksum := hex.EncodeToString(sum[:])
	manifest := struct {
		SchemaVersion int    `json:"schemaVersion"`
		Release       string `json:"release"`
		Assets        []struct {
			Name          string `json:"name"`
			SHA256        string `json:"sha256"`
			Size          int64  `json:"size"`
			PlatformTrust string `json:"platformTrust"`
		} `json:"assets"`
	}{
		SchemaVersion: 1,
		Release:       "v" + version,
		Assets: []struct {
			Name          string `json:"name"`
			SHA256        string `json:"sha256"`
			Size          int64  `json:"size"`
			PlatformTrust string `json:"platformTrust"`
		}{
			{
				Name:          assetName,
				SHA256:        checksum,
				Size:          int64(len(content)),
				PlatformTrust: "release-workflow-produced",
			},
		},
	}
	payload, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	signature := ed25519.Sign(privateKey, payload)
	return downloadInfo{
		URL:               rawURL,
		Checksum:          checksum,
		Manifest:          string(payload),
		ManifestSignature: base64.StdEncoding.EncodeToString(signature),
	}
}

func TestNewCreatesUpdater(t *testing.T) {
	cfg := &Config{
		ServerURL:      "http://localhost:3001",
		AuthToken:      secmem.NewSecureString("brz_test"),
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

func TestNormalizePreflightErr_PreservesFileLocked(t *testing.T) {
	err := normalizePreflightErr(ErrFileLocked)
	if !errors.Is(err, ErrFileLocked) {
		t.Fatalf("expected ErrFileLocked, got %v", err)
	}
	if errors.Is(err, ErrReadOnlyFS) {
		t.Fatalf("did not expect ErrReadOnlyFS, got %v", err)
	}
}

func TestNormalizePreflightErr_WrapsReadOnly(t *testing.T) {
	// EROFS, EACCES, and EPERM should all be classified as read-only
	for _, sysErr := range []error{syscall.EROFS, syscall.EACCES, syscall.EPERM} {
		err := normalizePreflightErr(sysErr)
		if !errors.Is(err, ErrReadOnlyFS) {
			t.Fatalf("expected ErrReadOnlyFS for %v, got %v", sysErr, err)
		}
	}
}

func TestNormalizePreflightErr_PassesThroughTransient(t *testing.T) {
	// Transient errors should NOT be wrapped as ErrReadOnlyFS
	err := normalizePreflightErr(os.ErrPermission)
	if errors.Is(err, ErrReadOnlyFS) {
		t.Fatalf("os.ErrPermission should not be classified as ErrReadOnlyFS")
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
			json.NewEncoder(w).Encode(signedDownloadInfo(t, "1.0.0", "agent", "http://"+r.Host+"/binary/breeze-agent", binaryContent))

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
		AuthToken: secmem.NewSecureString("test-token"),
	})
	u.client = server.Client()

	tempPath, manifest, err := u.downloadBinary("1.0.0")
	if err != nil {
		t.Fatalf("download failed: %v", err)
	}
	defer os.Remove(tempPath)

	downloaded, _ := os.ReadFile(tempPath)
	if string(downloaded) != string(binaryContent) {
		t.Fatalf("downloaded content mismatch")
	}
	if manifest.Checksum == "" {
		t.Fatal("expected signed manifest checksum")
	}
}

func TestDownloadBinaryRejectsTamperedSignedMetadata(t *testing.T) {
	binaryContent := []byte("fake binary v1.0.0")
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	oldKeys := trustedUpdateManifestPublicKeys
	trustedUpdateManifestPublicKeys = []string{base64.StdEncoding.EncodeToString(publicKey)}
	t.Cleanup(func() {
		trustedUpdateManifestPublicKeys = oldKeys
	})

	sum := sha256.Sum256(binaryContent)
	manifest := updateManifest{
		Version:   "1.0.0",
		Component: "agent",
		Platform:  manifestPlatform(),
		Arch:      runtime.GOARCH,
		URL:       "http://example.invalid/binary/breeze-agent",
		Checksum:  hex.EncodeToString(sum[:]),
		Size:      int64(len(binaryContent)),
	}
	payload, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	signature := ed25519.Sign(privateKey, payload)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v1/agent-versions/1.0.0/download":
			var tampered updateManifest
			if err := json.Unmarshal(payload, &tampered); err != nil {
				t.Fatal(err)
			}
			tampered.URL = "http://" + r.Host + "/binary/breeze-agent"
			tamperedPayload, err := json.Marshal(tampered)
			if err != nil {
				t.Fatal(err)
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(downloadInfo{
				URL:               tampered.URL,
				Checksum:          tampered.Checksum,
				Manifest:          string(tamperedPayload),
				ManifestSignature: base64.StdEncoding.EncodeToString(signature),
			})
		case r.URL.Path == "/binary/breeze-agent":
			w.Write(binaryContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	u := New(&Config{
		ServerURL: server.URL,
		AuthToken: secmem.NewSecureString("test-token"),
	})
	u.client = server.Client()

	_, _, err = u.downloadBinary("1.0.0")
	if err == nil {
		t.Fatal("tampered manifest metadata should fail signature verification")
	}
}

func TestDownloadBinaryAcceptsSignedReleaseArtifactManifest(t *testing.T) {
	binaryContent := []byte("fake binary v1.0.0 from release manifest")
	suffix := ""
	if runtime.GOOS == "windows" {
		suffix = ".exe"
	}
	assetName := "breeze-agent-" + runtime.GOOS + "-" + runtime.GOARCH + suffix

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v1/agent-versions/1.0.0/download":
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(signedReleaseArtifactDownloadInfo(t, "1.0.0", assetName, "http://"+r.Host+"/binary/"+assetName, binaryContent))
		case r.URL.Path == "/binary/"+assetName:
			w.Write(binaryContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	u := New(&Config{
		ServerURL: server.URL,
		AuthToken: secmem.NewSecureString("test-token"),
	})
	u.client = server.Client()

	tempPath, manifest, err := u.downloadBinary("1.0.0")
	if err != nil {
		t.Fatalf("download failed: %v", err)
	}
	defer os.Remove(tempPath)

	if manifest.Checksum == "" {
		t.Fatal("expected signed release artifact manifest checksum")
	}
	if manifest.Size != int64(len(binaryContent)) {
		t.Fatalf("manifest size mismatch: %d", manifest.Size)
	}
}

func TestDownloadBinaryRejectsWrongSignedReleaseArtifact(t *testing.T) {
	binaryContent := []byte("fake helper artifact")

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v1/agent-versions/1.0.0/download":
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(signedReleaseArtifactDownloadInfo(t, "1.0.0", "breeze-helper-linux.AppImage", "http://"+r.Host+"/binary/breeze-helper-linux.AppImage", binaryContent))
		case r.URL.Path == "/binary/breeze-helper-linux.AppImage":
			w.Write(binaryContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	u := New(&Config{
		ServerURL: server.URL,
		AuthToken: secmem.NewSecureString("test-token"),
	})
	u.client = server.Client()

	_, _, err := u.downloadBinary("1.0.0")
	if err == nil {
		t.Fatal("wrong signed release artifact should fail")
	}
}

func TestDownloadBinaryRejectsRedirectResponseWithoutSignedManifest(t *testing.T) {
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
		AuthToken: secmem.NewSecureString("test-token"),
	})
	u.client = server.Client()

	_, _, err := u.downloadBinary("1.0.0")
	if err == nil {
		t.Fatal("redirect response without signed manifest should fail")
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
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v1/agent-versions/1.0.0/download":
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(signedDownloadInfo(t, "1.0.0", "agent", "http://"+r.Host+"/binary/breeze-agent", newContent))
		case r.URL.Path == "/binary/breeze-agent":
			w.Write(newContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	u := New(&Config{
		ServerURL:      server.URL,
		AuthToken:      secmem.NewSecureString("tok"),
		CurrentVersion: "0.1.0",
		BinaryPath:     binaryPath,
		BackupPath:     backupPath,
	})
	u.client = server.Client()

	// We can't test the full UpdateTo because Restart() would fail,
	// but we can test the download -> verify -> backup -> replace pipeline manually
	tempPath, manifest, err := u.downloadBinary("1.0.0")
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	defer os.Remove(tempPath)

	if err := u.verifyChecksum(tempPath, manifest.Checksum); err != nil {
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

func TestNormalizePreflightErr_PreservesTextBusy(t *testing.T) {
	err := normalizePreflightErr(ErrTextBusy)
	if !errors.Is(err, ErrTextBusy) {
		t.Fatalf("expected ErrTextBusy, got %v", err)
	}
	if errors.Is(err, ErrReadOnlyFS) {
		t.Fatalf("did not expect ErrReadOnlyFS, got %v", err)
	}
}

func TestRollback_UnlinksBeforeWrite(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unlink behavior is Unix-only")
	}

	tmpDir := t.TempDir()
	binaryPath := filepath.Join(tmpDir, "breeze-agent")
	backupPath := filepath.Join(tmpDir, "breeze-agent.backup")

	// Create "current" binary and hold it open (simulates running executable)
	os.WriteFile(binaryPath, []byte("corrupted"), 0755)
	holder, err := os.Open(binaryPath)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Close()

	origInfo, _ := os.Stat(binaryPath)
	origSys := origInfo.Sys().(*syscall.Stat_t)
	origIno := origSys.Ino

	// Create backup
	os.WriteFile(backupPath, []byte("good v0.1.0"), 0755)

	u := New(&Config{BinaryPath: binaryPath, BackupPath: backupPath})
	if err := u.Rollback(); err != nil {
		t.Fatalf("rollback failed: %v", err)
	}

	// Verify rollback content
	content, _ := os.ReadFile(binaryPath)
	if string(content) != "good v0.1.0" {
		t.Fatalf("rollback content mismatch: %s", string(content))
	}

	// Verify new inode (unlink happened)
	newInfo, _ := os.Stat(binaryPath)
	newSys := newInfo.Sys().(*syscall.Stat_t)
	if newSys.Ino == origIno {
		t.Fatal("expected new inode after unlink+create in rollback")
	}
}

func TestReplaceBinary_UnlinksBeforeWrite(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unlink behavior is Unix-only")
	}

	tmpDir := t.TempDir()
	binaryPath := filepath.Join(tmpDir, "breeze-agent")
	newBinaryPath := filepath.Join(tmpDir, "new-binary")

	// Create current binary and hold it open (simulates running executable holding inode)
	os.WriteFile(binaryPath, []byte("old binary"), 0755)
	holder, err := os.Open(binaryPath)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Close()

	// Record original inode
	origInfo, _ := os.Stat(binaryPath)
	origSys := origInfo.Sys().(*syscall.Stat_t)
	origIno := origSys.Ino

	// Create new binary
	os.WriteFile(newBinaryPath, []byte("new binary v2"), 0644)

	u := New(&Config{BinaryPath: binaryPath})
	if err := u.replaceBinary(newBinaryPath); err != nil {
		t.Fatalf("replace failed: %v", err)
	}

	// Verify new content at path
	content, _ := os.ReadFile(binaryPath)
	if string(content) != "new binary v2" {
		t.Fatalf("expected new content, got: %s", string(content))
	}

	// Verify it's a NEW inode (unlink created a new file, not truncated old one)
	newInfo, _ := os.Stat(binaryPath)
	newSys := newInfo.Sys().(*syscall.Stat_t)
	if newSys.Ino == origIno {
		t.Fatal("expected new inode after unlink+create, but got same inode")
	}

	// Verify the held-open file descriptor still reads old content (kernel kept old inode)
	holder.Seek(0, 0)
	oldContent := make([]byte, 100)
	n, _ := holder.Read(oldContent)
	if string(oldContent[:n]) != "old binary" {
		t.Fatalf("held FD should still read old content, got: %s", string(oldContent[:n]))
	}
}
