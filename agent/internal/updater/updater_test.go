package updater

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
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

// TestEmbeddedTrustRootMatchesRepoPubKey guards against shipping the agent
// with an Ed25519 trust root that doesn't match the key the release pipeline
// actually signs manifests with. PR #568 (May 2026) baked in a wrong key,
// silently breaking auto-update for v0.65.5 and v0.65.6 — agents downloaded
// the manifest, failed signature verification, and parked devices in
// "updating" state forever. This test compares the embedded key against the
// repo-tracked public key file (whose private counterpart is the GitHub
// secret RELEASE_MANIFEST_ED25519_PRIVATE_KEY) so the same regression
// can't slip in again.
func TestEmbeddedTrustRootMatchesRepoPubKey(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot resolve test file location via runtime.Caller")
	}
	repoRoot := filepath.Join(filepath.Dir(thisFile), "..", "..", "..")
	pubPath := filepath.Join(repoRoot, "internal", "release-keys", "release-manifest.ed25519.pub")

	pemBytes, err := os.ReadFile(pubPath)
	if err != nil {
		t.Fatalf("repo manifest pub key not readable at %s: %v", pubPath, err)
	}

	block, _ := pem.Decode(pemBytes)
	if block == nil || block.Type != "PUBLIC KEY" {
		t.Fatalf("expected a PEM PUBLIC KEY block in %s", pubPath)
	}

	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		t.Fatalf("parse SPKI from %s: %v", pubPath, err)
	}
	edKey, ok := parsed.(ed25519.PublicKey)
	if !ok {
		t.Fatalf("expected ed25519.PublicKey in %s, got %T", pubPath, parsed)
	}
	expected := base64.StdEncoding.EncodeToString(edKey)

	for _, k := range trustedUpdateManifestPublicKeys {
		if k == expected {
			return
		}
	}
	t.Fatalf(
		"trustedUpdateManifestPublicKeys does not contain the repo manifest pub key.\n"+
			"  expected (raw base64 of %s): %s\n"+
			"  embedded: %v\n"+
			"If you rotated the manifest signing key, update agent/internal/updater/updater.go to match.",
		pubPath, expected, trustedUpdateManifestPublicKeys,
	)
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

// Regression for #646: the agent must accept a server-relative info.URL even
// when the signed manifest references the canonical github.com asset URL.
// Binary trust is bound by checksum (verified against the signed assets list),
// not by URL string equality.
func TestDownloadBinaryAcceptsServerRelativeUrlWithMatchingChecksum(t *testing.T) {
	binaryContent := []byte("fake binary v1.0.0 served via server-relative proxy")
	suffix := ""
	if runtime.GOOS == "windows" {
		suffix = ".exe"
	}
	assetName := "breeze-agent-" + runtime.GOOS + "-" + runtime.GOARCH + suffix

	// Signed manifest references the canonical github URL; the API hands back
	// a server-relative URL pointing at its own proxy route.
	canonicalAssetURL := "https://github.com/LanternOps/breeze/releases/download/v1.0.0/" + assetName

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v1/agent-versions/1.0.0/download":
			signed := signedReleaseArtifactDownloadInfo(t, "1.0.0", assetName, canonicalAssetURL, binaryContent)
			// Override the URL handed to the agent: server-relative proxy
			// path, NOT the canonical (cross-origin) URL signed into the
			// manifest. Manifest signature stays intact; manifest's Assets[]
			// list still names the asset canonically.
			signed.URL = "http://" + r.Host + "/api/v1/agents/download/" + runtime.GOOS + "/" + runtime.GOARCH
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(signed)
		case r.URL.Path == "/api/v1/agents/download/"+runtime.GOOS+"/"+runtime.GOARCH:
			// Stand-in for the existing /agents/download route which 302s to
			// github in BINARY_SOURCE=github mode. For the test we just stream
			// the bytes directly.
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
		t.Fatalf("server-relative URL with matching checksum should be accepted: %v", err)
	}
	defer os.Remove(tempPath)
	if manifest.Checksum == "" {
		t.Fatal("expected manifest checksum to be returned")
	}
	downloaded, _ := os.ReadFile(tempPath)
	if string(downloaded) != string(binaryContent) {
		t.Fatalf("downloaded content mismatch")
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

// TestRollback_UnlinksBeforeWrite and TestReplaceBinary_UnlinksBeforeWrite
// live in updater_unix_test.go (build-tag !windows) because they use
// syscall.Stat_t to inspect inodes, which doesn't exist on Windows. The
// previous runtime-skip pattern still broke `go test -c` cross-compile.

// TestTrustedManifestKeys_IncludesPinnedKeys verifies that per-deployment
// pinned pubkeys delivered via heartbeat/enrollment (#625) are included in
// the trust set alongside the embedded LanternOps key.
func TestTrustedManifestKeys_IncludesPinnedKeys(t *testing.T) {
	pinnedRaw := make([]byte, ed25519.PublicKeySize)
	for i := range pinnedRaw {
		pinnedRaw[i] = byte(i + 1)
	}
	pinned := base64.StdEncoding.EncodeToString(pinnedRaw)

	u := &Updater{
		config: &Config{
			PinnedManifestPubKeys: []string{"deploy-test:" + pinned},
		},
	}
	keys := u.trustedManifestKeys()

	// Embedded LanternOps key + the pinned key.
	if len(keys) < 2 {
		t.Fatalf("expected >= 2 trusted keys (embedded + pinned), got %d", len(keys))
	}

	// Verify the pinned bytes appear in the result.
	found := false
	for _, k := range keys {
		if string(k) == string(pinnedRaw) {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("pinned pubkey was not present in trustedManifestKeys output")
	}
}

// TestVerifyUpdateManifest_AcceptsManifestSignedByPinnedKey exercises the full
// per-deployment trust path end-to-end: generate a fresh Ed25519 keypair, sign
// a manifest JSON, pin the pubkey via Config.PinnedManifestPubKeys, and assert
// that verifyUpdateManifest accepts the manifest. This is the gap left by
// TestTrustedManifestKeys_IncludesPinnedKeys, which only checked that the key
// appears in the slice — not that the signature path actually works (#625).
func TestVerifyUpdateManifest_AcceptsManifestSignedByPinnedKey(t *testing.T) {
	// nil uses crypto/rand internally — same as the existing test helpers.
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	pubB64 := base64.StdEncoding.EncodeToString(pub)

	manifest := updateManifest{
		Version:   "0.65.9",
		Component: "agent",
		Platform:  manifestPlatform(),
		Arch:      runtime.GOARCH,
		URL:       "https://selftest.local/agent",
		Checksum:  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		Size:      4096,
	}
	manifestJSON, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	sig := ed25519.Sign(priv, manifestJSON)
	sigB64 := base64.StdEncoding.EncodeToString(sig)

	u := &Updater{
		config: &Config{
			Component:             "agent",
			PinnedManifestPubKeys: []string{"deploy-test:" + pubB64},
		},
	}
	info := downloadInfo{
		URL:               manifest.URL,
		Checksum:          manifest.Checksum,
		Manifest:          string(manifestJSON),
		ManifestSignature: sigB64,
	}
	got, err := u.verifyUpdateManifest(info, "0.65.9")
	if err != nil {
		t.Fatalf("verifyUpdateManifest: %v", err)
	}
	if got.Version != "0.65.9" {
		t.Fatalf("expected version 0.65.9, got %q", got.Version)
	}
}

// TestTrustedManifestKeys_SkipsMalformedPinnedEntries ensures that bad entries
// in the pinned list (no colon, blank pubkey, wrong base64) don't crash or
// poison the trust set — they're just dropped.
func TestTrustedManifestKeys_SkipsMalformedPinnedEntries(t *testing.T) {
	u := &Updater{
		config: &Config{
			PinnedManifestPubKeys: []string{
				"missing-colon",
				"key-id:",
				"key-id:not-valid-base64-!!!",
				":",
			},
		},
	}
	keys := u.trustedManifestKeys()
	// Just the embedded LanternOps key — all malformed entries dropped.
	if len(keys) < 1 {
		t.Fatalf("expected at least 1 (embedded) key, got %d", len(keys))
	}
}

// TestExpectedReleaseAssetNames_UserHelper covers the component=user-helper
// branch added by #816. The breeze-user-helper exists only on Windows; other
// platforms must return an empty allowlist so verifyReleaseArtifactManifest
// surfaces a clear "no expected asset names" error instead of accidentally
// accepting an unrelated artifact.
func TestExpectedReleaseAssetNames_UserHelper(t *testing.T) {
	u := &Updater{config: &Config{Component: "user-helper"}}
	got := u.expectedReleaseAssetNames()

	if runtime.GOOS == "windows" {
		expected := "breeze-user-helper-windows-" + runtime.GOARCH + ".exe"
		if len(got) != 1 {
			t.Fatalf("expected exactly 1 asset name on windows, got %d (%v)", len(got), got)
		}
		if _, ok := got[expected]; !ok {
			t.Fatalf("expected %q in asset name set, got %v", expected, got)
		}
		return
	}

	// Non-Windows: user-helper isn't shipped, so the set is empty.
	if len(got) != 0 {
		t.Fatalf("expected empty asset name set on %s, got %v", runtime.GOOS, got)
	}
}

// TestExpectedReleaseAssetNames_Agent guards against regressions in the
// existing agent branch when refactoring the user-helper case.
func TestExpectedReleaseAssetNames_Agent(t *testing.T) {
	u := &Updater{config: &Config{Component: "agent"}}
	got := u.expectedReleaseAssetNames()
	suffix := ""
	if runtime.GOOS == "windows" {
		suffix = ".exe"
	}
	expected := "breeze-agent-" + runtime.GOOS + "-" + runtime.GOARCH + suffix
	if _, ok := got[expected]; !ok {
		t.Fatalf("expected %q in agent asset name set, got %v", expected, got)
	}
}

// TestUpdateToWithOptions_CleansHelperTempOnFailure regression-tests the
// fix for the orphan-temp-file bug flagged in the #845 follow-up review:
// when UpdateTo returns an error AND the caller pre-downloaded a user-helper
// via opts.UserHelper, the temp file must be removed. Before the fix only
// the agent temp was cleaned up, leaking the helper temp in %TEMP% on every
// failed upgrade.
//
// Ported from the pre-PR-B TestUpdateToWithUserHelper_CleansHelperTempOnFailure
// — same intent, new API surface (UpdateToWithOptions + UpdateOptions).
//
// We force UpdateTo to fail by giving it no AuthToken — downloadBinary
// returns "auth token not available" immediately on every platform.
func TestUpdateToWithOptions_CleansHelperTempOnFailure(t *testing.T) {
	// Synthesize a "pre-downloaded user-helper" tempfile. The test owns the
	// file; UpdateToWithOptions is expected to remove it on update failure.
	helperTemp, err := os.CreateTemp("", "breeze-user-helper-leak-test-*")
	if err != nil {
		t.Fatal(err)
	}
	helperTemp.Close()
	helperTempPath := helperTemp.Name()
	// Best-effort cleanup if the test fails (we expect the SUT to do this).
	t.Cleanup(func() { _ = os.Remove(helperTempPath) })

	// On non-Windows, UpdateTo's first step (checkWritable) would fail before
	// we get to the AuthToken check. Use a path that exists and is writable
	// so we DO reach downloadBinary and fail there with "auth token not
	// available" — exercises the same UpdateTo error-return path on every OS.
	binaryFile, err := os.CreateTemp("", "breeze-agent-bin-test-*")
	if err != nil {
		t.Fatal(err)
	}
	binaryFile.Close()
	t.Cleanup(func() { _ = os.Remove(binaryFile.Name()) })

	u := New(&Config{
		ServerURL:  "http://localhost:0",
		BinaryPath: binaryFile.Name(),
		BackupPath: binaryFile.Name() + ".backup",
		// AuthToken intentionally nil — forces downloadBinary to return early.
	})

	err = u.UpdateToWithOptions("9.9.9", UpdateOptions{
		UserHelper: &BinaryPair{
			Temp:   helperTempPath,
			Target: `C:\target\breeze-user-helper.exe`,
		},
	})
	if err == nil {
		t.Fatal("expected UpdateTo to fail (no auth token configured)")
	}

	if _, statErr := os.Stat(helperTempPath); !os.IsNotExist(statErr) {
		t.Fatalf("user-helper temp file should be removed on UpdateTo failure; got stat err=%v", statErr)
	}
}

// TestUpdateToWithOptions_NoUserHelperIsNoOp guards against a regression
// where the helper-temp cleanup branch fires when opts.UserHelper is nil
// (call path: agent-only upgrade on a release that doesn't ship the
// user-helper artifact, or a non-Windows host). It must not error or panic.
//
// Ported from the pre-PR-B TestUpdateToWithUserHelper_NoHelperTempPathIsNoOp.
func TestUpdateToWithOptions_NoUserHelperIsNoOp(t *testing.T) {
	binaryFile, err := os.CreateTemp("", "breeze-agent-bin-test-*")
	if err != nil {
		t.Fatal(err)
	}
	binaryFile.Close()
	t.Cleanup(func() { _ = os.Remove(binaryFile.Name()) })

	u := New(&Config{
		ServerURL:  "http://localhost:0",
		BinaryPath: binaryFile.Name(),
		BackupPath: binaryFile.Name() + ".backup",
	})

	// nil UserHelper should leave the cleanup branch dormant.
	if err := u.UpdateToWithOptions("9.9.9", UpdateOptions{}); err == nil {
		t.Fatal("expected UpdateTo to fail (no auth token configured)")
	}
}

// TestUpdateTo_DelegatesToUpdateToWithOptions verifies the thin-shim wiring
// added by PR B: UpdateTo must forward to UpdateToWithOptions with a
// zero-valued UpdateOptions, i.e. the agent-only path. We can't observe the
// internal call directly, but we can prove equivalence by asserting both
// invocations produce the same observable error (no auth token), confirming
// the shim doesn't drop arguments or short-circuit.
func TestUpdateTo_DelegatesToUpdateToWithOptions(t *testing.T) {
	binaryFile, err := os.CreateTemp("", "breeze-agent-bin-test-*")
	if err != nil {
		t.Fatal(err)
	}
	binaryFile.Close()
	t.Cleanup(func() { _ = os.Remove(binaryFile.Name()) })

	mkUpdater := func() *Updater {
		return New(&Config{
			ServerURL:  "http://localhost:0",
			BinaryPath: binaryFile.Name(),
			BackupPath: binaryFile.Name() + ".backup",
		})
	}

	shimErr := mkUpdater().UpdateTo("9.9.9")
	if shimErr == nil {
		t.Fatal("expected shim UpdateTo to fail (no auth token)")
	}

	explicitErr := mkUpdater().UpdateToWithOptions("9.9.9", UpdateOptions{})
	if explicitErr == nil {
		t.Fatal("expected explicit UpdateToWithOptions to fail (no auth token)")
	}

	// Errors must be structurally identical — same wrapped message text — to
	// prove the shim isn't munging args. Use Error() string equality; both
	// flows reach the same downloadBinary "auth token not available" branch.
	if shimErr.Error() != explicitErr.Error() {
		t.Fatalf("shim and explicit calls produced different errors:\n  shim:     %v\n  explicit: %v", shimErr, explicitErr)
	}
}
