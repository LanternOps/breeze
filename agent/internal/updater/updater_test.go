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
	"strings"
	"syscall"
	"testing"

	"github.com/breeze-rmm/agent/internal/secmem"
)

// staticServerURL wraps a fixed URL as a Config.ServerURL provider for tests
// that don't exercise failover promotion. Config.ServerURL is a func() string
// (#2478) so long-lived updaters follow backup-server-URL promotion.
func staticServerURL(s string) func() string {
	return func() string { return s }
}

func signedDownloadInfo(t *testing.T, version, component, rawURL string, content []byte) downloadInfo {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	installEmbeddedManifestKey(t, testEmbeddedKeyID, publicKey)

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
		SigningKeyID:      testEmbeddedKeyID,
	}
}

func signedReleaseArtifactDownloadInfo(t *testing.T, version, assetName, rawURL string, content []byte) downloadInfo {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	installEmbeddedManifestKey(t, testEmbeddedKeyID, publicKey)

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
		SigningKeyID:      testEmbeddedKeyID,
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

	// The key must be present under the exact ID the API stamps onto
	// signingKeyId for GitHub-sourced releases (binarySync.ts). Matching bytes
	// under a different ID is now a hard failure too: every hosted manifest
	// names this ID, and an ID mismatch no longer falls back to trying other
	// keys, so a renamed embedded entry would break auto-update fleet-wide.
	const canonicalID = "release-artifact-manifest-ed25519"
	got, ok := embeddedManifestPublicKeys[canonicalID]
	if !ok {
		ids := make([]string, 0, len(embeddedManifestPublicKeys))
		for id := range embeddedManifestPublicKeys {
			ids = append(ids, id)
		}
		t.Fatalf(
			"embeddedManifestPublicKeys has no entry for %q (has: %v).\n"+
				"The API stamps this key id onto every GitHub-sourced download response;\n"+
				"without a matching entry, exact-ID verification fails for the whole fleet.",
			canonicalID, ids,
		)
	}
	if base64.StdEncoding.EncodeToString(got) != expected {
		t.Fatalf(
			"embeddedManifestPublicKeys[%q] does not match the repo manifest pub key.\n"+
				"  expected (raw base64 of %s): %s\n"+
				"If you rotated the manifest signing key, update agent/internal/updater/updater.go to match.",
			canonicalID, pubPath, expected,
		)
	}
}

func TestNewCreatesUpdater(t *testing.T) {
	cfg := &Config{
		ServerURL:       staticServerURL("http://localhost:3001"),
		BackupServerURL: "http://localhost:3002",
		AuthToken:       secmem.NewSecureString("brz_test"),
		CurrentVersion:  "0.1.0",
		BinaryPath:      "/usr/local/bin/breeze-agent",
		BackupPath:      "/usr/local/bin/breeze-agent.backup",
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
	if u.clientErr != nil {
		t.Fatalf("valid config should not produce a client construction error: %v", u.clientErr)
	}
}

// TestNewFailsClosedOnMalformedOrigin proves New() does not panic or produce
// a usable-but-unenforced client when the configured server/backup URLs are
// malformed — it stores the netpolicy construction error and every download
// entry point (checkClient) must refuse to proceed rather than silently
// falling back to an unenforced client.
func TestNewFailsClosedOnMalformedOrigin(t *testing.T) {
	cfg := &Config{
		// Userinfo in a configured origin is rejected by netpolicy
		// (ReasonUserinfoPresent) at NewClient construction time.
		ServerURL: staticServerURL("http://user:pw@breeze.example"),
	}
	u := New(cfg)
	if u == nil {
		t.Fatal("New returned nil")
	}
	if u.clientErr == nil {
		t.Fatal("expected a client construction error for a malformed configured origin")
	}
	if u.client != nil {
		t.Fatal("client must be nil when construction failed — no unenforced fallback")
	}
	if err := u.checkClient(); err == nil {
		t.Fatal("checkClient should surface the construction error")
	}
	if _, err := u.downloadFromURL("https://cdn.example/file.bin"); err == nil {
		t.Fatal("downloadFromURL must fail closed when the client failed to construct")
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
	// These tests use plain-text stand-in "binaries", which are not Mach-O and
	// would always fail the real macOS code-signature gate added in #3458. The
	// gate has its own coverage in replace_binary_signature_test.go.
	stubStagedSignatureCheck(t, func(string) error { return nil })

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
		ServerURL: staticServerURL(server.URL),
		AuthToken: secmem.NewSecureString("test-token"),
	})
	u.client = server.Client()

	tempPath, manifest, _, err := u.downloadBinary("1.0.0")
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
	installEmbeddedManifestKey(t, testEmbeddedKeyID, publicKey)

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
				SigningKeyID:      testEmbeddedKeyID,
			})
		case r.URL.Path == "/binary/breeze-agent":
			w.Write(binaryContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	u := New(&Config{
		ServerURL: staticServerURL(server.URL),
		AuthToken: secmem.NewSecureString("test-token"),
	})
	u.client = server.Client()

	_, _, _, err = u.downloadBinary("1.0.0")
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
		ServerURL: staticServerURL(server.URL),
		AuthToken: secmem.NewSecureString("test-token"),
	})
	u.client = server.Client()

	tempPath, manifest, _, err := u.downloadBinary("1.0.0")
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
		ServerURL: staticServerURL(server.URL),
		AuthToken: secmem.NewSecureString("test-token"),
	})
	u.client = server.Client()

	tempPath, manifest, _, err := u.downloadBinary("1.0.0")
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
		ServerURL: staticServerURL(server.URL),
		AuthToken: secmem.NewSecureString("test-token"),
	})
	u.client = server.Client()

	_, _, _, err := u.downloadBinary("1.0.0")
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
		ServerURL: staticServerURL(server.URL),
		AuthToken: secmem.NewSecureString("test-token"),
	})
	u.client = server.Client()

	_, _, _, err := u.downloadBinary("1.0.0")
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

	u := New(&Config{ServerURL: staticServerURL(server.URL)})
	u.client = server.Client()

	_, _, _, err := u.downloadBinary("1.0.0")
	if err == nil {
		t.Fatal("should fail when checksum missing from JSON response")
	}
}

func TestDownloadBinaryServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	u := New(&Config{ServerURL: staticServerURL(server.URL)})
	u.client = server.Client()

	_, _, _, err := u.downloadBinary("1.0.0")
	if err == nil {
		t.Fatal("should fail on server error")
	}
}

// TestDownloadBinary_ChecksumMismatchCleansUpTempFile pins the cleanup-on-checksum-
// failure contract in the exported DownloadBinary path. heartbeat.doUpgrade's
// user-helper fallback (issue #816, PR #845) relies on DownloadBinary returning
// "" and leaving no temp file behind on checksum failure — otherwise repeated
// upgrade retries leak temp files into the OS temp dir.
func TestDownloadBinary_ChecksumMismatchCleansUpTempFile(t *testing.T) {
	// Redirect os.CreateTemp("", ...) into the test's TempDir so we can
	// detect any leftover binary fragments.
	tempRoot := t.TempDir()
	t.Setenv("TMPDIR", tempRoot)

	// Intended content (what the signed manifest declares).
	intendedContent := []byte("INTENDED-binary-bytes")
	// Tampered content actually served by the binary URL. Same length as
	// intendedContent so the manifest.Size check passes and we reach the
	// post-download verifyChecksum.
	tamperedContent := []byte("TAMPERED-binary-bytes")
	if len(intendedContent) != len(tamperedContent) {
		t.Fatalf("test setup invariant: intended and tampered must be same length (%d vs %d)",
			len(intendedContent), len(tamperedContent))
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v1/agent-versions/1.0.0/download":
			w.Header().Set("Content-Type", "application/json")
			// Manifest is signed against the *intended* bytes' SHA256.
			json.NewEncoder(w).Encode(signedDownloadInfo(
				t, "1.0.0", "agent",
				"http://"+r.Host+"/binary/breeze-agent",
				intendedContent,
			))
		case r.URL.Path == "/binary/breeze-agent":
			// Serve the tampered bytes so the post-write verifyChecksum
			// inside DownloadBinary fails.
			w.Write(tamperedContent)
		default:
			t.Errorf("unexpected request path: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	u := New(&Config{
		ServerURL: staticServerURL(server.URL),
		AuthToken: secmem.NewSecureString("test-token"),
	})
	u.client = server.Client()

	gotPath, err := u.DownloadBinary("1.0.0")
	if err == nil {
		t.Fatalf("expected checksum mismatch error, got nil (path=%q)", gotPath)
	}
	if gotPath != "" {
		t.Fatalf("expected empty returned path on checksum failure, got %q", gotPath)
	}

	// Confirm no temp file was leaked: walk the redirected temp dir.
	// The only entries should be ones t.TempDir created internally; the
	// breeze-agent-dev-* file from downloadFromURL must not be present.
	entries, err := os.ReadDir(tempRoot)
	if err != nil {
		t.Fatalf("failed to read temp dir %s: %v", tempRoot, err)
	}
	for _, entry := range entries {
		// t.TempDir() places per-test subdirs under TMPDIR; allow those,
		// but no breeze-agent-dev-* leftovers.
		name := entry.Name()
		if strings.HasPrefix(name, "breeze-agent-dev-") {
			t.Fatalf("temp file leaked after checksum failure: %s", filepath.Join(tempRoot, name))
		}
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
		ServerURL:      staticServerURL(server.URL),
		AuthToken:      secmem.NewSecureString("tok"),
		CurrentVersion: "0.1.0",
		BinaryPath:     binaryPath,
		BackupPath:     backupPath,
	})
	u.client = server.Client()

	// We can't test the full UpdateTo because Restart() would fail,
	// but we can test the download -> verify -> backup -> replace pipeline manually
	tempPath, manifest, _, err := u.downloadBinary("1.0.0")
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

	stubStagedSignatureCheck(t, func(string) error { return nil })
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
// the trust set alongside the embedded LanternOps key — now keyed by their ID.
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
	keyed, _, err := u.manifestTrustKeys()
	if err != nil {
		t.Fatalf("manifestTrustKeys: %v", err)
	}

	// Embedded LanternOps key + the pinned key.
	if len(keyed) < 2 {
		t.Fatalf("expected >= 2 trusted keys (embedded + pinned), got %d", len(keyed))
	}
	got, ok := keyed["deploy-test"]
	if !ok {
		t.Fatal("pinned pubkey was not present under its key id")
	}
	if string(got) != string(pinnedRaw) {
		t.Fatal("pinned pubkey bytes do not match the pinned entry")
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
		SigningKeyID:      "deploy-test",
	}
	got, err := u.verifyUpdateManifest(info, "0.65.9")
	if err != nil {
		t.Fatalf("verifyUpdateManifest: %v", err)
	}
	if got.Version != "0.65.9" {
		t.Fatalf("expected version 0.65.9, got %q", got.Version)
	}
}

// Malformed pinned entries used to be silently dropped, which quietly demoted
// a deployment back to the embedded vendor root. They now fail the whole trust
// assembly — see TestManifestTrustKeys_RejectsMalformedPinnedEntries below.

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

// TestExpectedReleaseAssetNames_Watchdog covers the component=watchdog branch.
// Unlike user-helper, the watchdog ships per-arch on every platform, so the
// allowlist must be populated on all GOOS. Without this case the GitHub
// multi-asset manifest verification fails ("no expected release asset names
// configured for component watchdog") — the root cause of watchdog auto-update
// never working on the hosted path.
func TestExpectedReleaseAssetNames_Watchdog(t *testing.T) {
	u := &Updater{config: &Config{Component: "watchdog"}}
	got := u.expectedReleaseAssetNames()
	suffix := ""
	if runtime.GOOS == "windows" {
		suffix = ".exe"
	}
	expected := "breeze-watchdog-" + runtime.GOOS + "-" + runtime.GOARCH + suffix
	if len(got) != 1 {
		t.Fatalf("expected exactly 1 watchdog asset name on %s, got %d (%v)", runtime.GOOS, len(got), got)
	}
	if _, ok := got[expected]; !ok {
		t.Fatalf("expected %q in watchdog asset name set, got %v", expected, got)
	}
}

// TestExpectedReleaseAssetNames_Backup covers the component=backup branch.
// breeze-backup mirrors the watchdog's asset-name shape: per-arch on every
// platform, .exe suffix on windows.
func TestExpectedReleaseAssetNames_Backup(t *testing.T) {
	u := &Updater{config: &Config{Component: "backup"}}
	got := u.expectedReleaseAssetNames()
	suffix := ""
	if runtime.GOOS == "windows" {
		suffix = ".exe"
	}
	expected := "breeze-backup-" + runtime.GOOS + "-" + runtime.GOARCH + suffix
	if len(got) != 1 {
		t.Fatalf("expected exactly 1 backup asset name on %s, got %d (%v)", runtime.GOOS, len(got), got)
	}
	if _, ok := got[expected]; !ok {
		t.Fatalf("expected %q in backup asset name set, got %v", expected, got)
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
	//
	// ServerURL below uses port 1, not 0: port 0 is itself an invalid_port
	// per netpolicy's origin validation (New would fail closed on a
	// misconfigured client and downloadBinary would return that error
	// instead of "auth token not available", changing what this test proves
	// without changing whether it passes).
	binaryFile, err := os.CreateTemp("", "breeze-agent-bin-test-*")
	if err != nil {
		t.Fatal(err)
	}
	binaryFile.Close()
	t.Cleanup(func() { _ = os.Remove(binaryFile.Name()) })

	u := New(&Config{
		ServerURL:  staticServerURL("http://localhost:1"),
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
		ServerURL:  staticServerURL("http://localhost:1"),
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
			ServerURL:  staticServerURL("http://localhost:1"),
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

// --- exact signing-key-ID verification (P1-UPD-001) -------------------------
//
// The rule these tests pin: when the download response carries a signingKeyId,
// the manifest is verified against THAT key and nothing else. Possession of any
// other trusted key — including a legitimately pinned deployment key, or the
// embedded vendor root — must not be enough to sign a manifest that names a
// different key.

const testEmbeddedKeyID = "test-embedded-root"

// installEmbeddedManifestKey replaces the embedded trust map for the duration
// of a test. It replaces the map wholesale (rather than mutating the real one)
// so a test can never leak a key into the production trust root, and restores
// the original in cleanup.
func installEmbeddedManifestKey(t *testing.T, id string, pub ed25519.PublicKey) {
	t.Helper()
	old := embeddedManifestPublicKeys
	embeddedManifestPublicKeys = ManifestPublicKeys{id: pub}
	t.Cleanup(func() { embeddedManifestPublicKeys = old })
}

// signManifestFor builds a valid agent manifest for version and signs it with
// priv, returning the JSON payload and base64 signature.
func signManifestFor(t *testing.T, version string, priv ed25519.PrivateKey) (string, string, string) {
	t.Helper()
	checksum := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	manifest := updateManifest{
		Version:   version,
		Component: "agent",
		Platform:  manifestPlatform(),
		Arch:      runtime.GOARCH,
		URL:       "https://updates.example.invalid/agent",
		Checksum:  checksum,
		Size:      4096,
	}
	payload, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	return string(payload), base64.StdEncoding.EncodeToString(ed25519.Sign(priv, payload)), checksum
}

// countingWarner swaps the bounded-warning log seam for a counter and resets
// the once-guard, so warning assertions can never inherit state from an
// earlier test in the same process.
func countingWarner(t *testing.T) *int {
	t.Helper()
	var count int
	old := missingSigningKeyIDWarner
	missingSigningKeyIDWarner = func() { count++ }
	resetMissingSigningKeyIDWarningForTests()
	t.Cleanup(func() {
		missingSigningKeyIDWarner = old
		resetMissingSigningKeyIDWarningForTests()
	})
	return &count
}

func TestVerifyUpdateManifest_AcceptsExactEmbeddedKeyID(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	installEmbeddedManifestKey(t, testEmbeddedKeyID, pub)
	countingWarner(t)

	payload, sig, checksum := signManifestFor(t, "1.2.3", priv)
	u := &Updater{config: &Config{Component: "agent"}}
	got, err := u.verifyUpdateManifest(downloadInfo{
		URL:               "https://updates.example.invalid/agent",
		Checksum:          checksum,
		Manifest:          payload,
		ManifestSignature: sig,
		SigningKeyID:      testEmbeddedKeyID,
	}, "1.2.3")
	if err != nil {
		t.Fatalf("verifyUpdateManifest: %v", err)
	}
	if got.Version != "1.2.3" {
		t.Fatalf("version = %q, want 1.2.3", got.Version)
	}
}

func TestVerifyUpdateManifest_AcceptsExactDeploymentKeyID(t *testing.T) {
	embeddedPub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	installEmbeddedManifestKey(t, testEmbeddedKeyID, embeddedPub)
	countingWarner(t)

	deployPub, deployPriv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	payload, sig, checksum := signManifestFor(t, "1.2.3", deployPriv)

	u := &Updater{config: &Config{
		Component:             "agent",
		PinnedManifestPubKeys: []string{"deploy-x:" + base64.StdEncoding.EncodeToString(deployPub)},
	}}
	if _, err := u.verifyUpdateManifest(downloadInfo{
		URL:               "https://updates.example.invalid/agent",
		Checksum:          checksum,
		Manifest:          payload,
		ManifestSignature: sig,
		SigningKeyID:      "deploy-x",
	}, "1.2.3"); err != nil {
		t.Fatalf("verifyUpdateManifest with pinned key: %v", err)
	}
}

func TestVerifyUpdateManifest_RejectsUnknownSigningKeyID(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	installEmbeddedManifestKey(t, testEmbeddedKeyID, pub)
	warnings := countingWarner(t)

	payload, sig, checksum := signManifestFor(t, "1.2.3", priv)
	u := &Updater{config: &Config{Component: "agent"}}
	_, err = u.verifyUpdateManifest(downloadInfo{
		URL:               "https://updates.example.invalid/agent",
		Checksum:          checksum,
		Manifest:          payload,
		ManifestSignature: sig,
		SigningKeyID:      "some-other-key",
	}, "1.2.3")
	if err == nil {
		t.Fatal("expected an unknown signing key id to fail closed, got nil")
	}
	if !strings.Contains(err.Error(), "unknown") {
		t.Fatalf("expected an 'unknown signing key id' error, got: %v", err)
	}
	// An unknown ID must not silently degrade into the compatibility path.
	if *warnings != 0 {
		t.Fatalf("unknown key id took the missing-ID compatibility path (warnings=%d)", *warnings)
	}
}

// THE vulnerability being closed: a manifest signed by a key the agent trusts
// for OTHER manifests must still fail when the response names a different key.
func TestVerifyUpdateManifest_RejectsSignatureFromDifferentTrustedKey(t *testing.T) {
	embeddedPub, embeddedPriv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	installEmbeddedManifestKey(t, testEmbeddedKeyID, embeddedPub)

	deployPub, deployPriv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	pinned := []string{"deploy-x:" + base64.StdEncoding.EncodeToString(deployPub)}

	cases := []struct {
		name    string
		signer  ed25519.PrivateKey
		claimed string
	}{
		{"deployment key signs, response claims the embedded root", deployPriv, testEmbeddedKeyID},
		{"embedded root signs, response claims the deployment key", embeddedPriv, "deploy-x"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			warnings := countingWarner(t)
			payload, sig, checksum := signManifestFor(t, "1.2.3", tc.signer)
			u := &Updater{config: &Config{Component: "agent", PinnedManifestPubKeys: pinned}}
			_, err := u.verifyUpdateManifest(downloadInfo{
				URL:               "https://updates.example.invalid/agent",
				Checksum:          checksum,
				Manifest:          payload,
				ManifestSignature: sig,
				SigningKeyID:      tc.claimed,
			}, "1.2.3")
			if err == nil {
				t.Fatal("expected verification against a key other than the named one to fail")
			}
			if !strings.Contains(err.Error(), "signature verification failed") {
				t.Fatalf("expected a signature verification failure, got: %v", err)
			}
			if *warnings != 0 {
				t.Fatalf("key-substitution attempt took the compatibility path (warnings=%d)", *warnings)
			}
		})
	}
}

func TestVerifyUpdateManifest_RejectsMalformedSigningKeyID(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}

	long := strings.Repeat("a", 129)
	for _, badID := range []string{"has space", "has:colon", "has/slash", "has\nnewline", long} {
		t.Run(strings.ReplaceAll(badID[:min(len(badID), 12)], "\n", "_"), func(t *testing.T) {
			// Install the signing key under the malformed ID so the ONLY thing
			// rejecting the manifest can be the ID validation itself — the
			// signature and the key lookup would otherwise both succeed.
			installEmbeddedManifestKey(t, badID, pub)
			warnings := countingWarner(t)

			payload, sig, checksum := signManifestFor(t, "1.2.3", priv)
			u := &Updater{config: &Config{Component: "agent"}}
			_, err := u.verifyUpdateManifest(downloadInfo{
				URL:               "https://updates.example.invalid/agent",
				Checksum:          checksum,
				Manifest:          payload,
				ManifestSignature: sig,
				SigningKeyID:      badID,
			}, "1.2.3")
			if err == nil {
				t.Fatalf("expected malformed signing key id %q to fail closed", badID)
			}
			if strings.Contains(err.Error(), badID) {
				t.Fatalf("error echoed the unvalidated key id: %v", err)
			}
			if *warnings != 0 {
				t.Fatalf("malformed key id took the compatibility path (warnings=%d)", *warnings)
			}
		})
	}
}

func TestVerifyUpdateManifest_MissingIDCompatibilityVerifiesAgainstKeySet(t *testing.T) {
	embeddedPub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	installEmbeddedManifestKey(t, testEmbeddedKeyID, embeddedPub)
	warnings := countingWarner(t)

	deployPub, deployPriv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	payload, sig, checksum := signManifestFor(t, "1.2.3", deployPriv)

	u := &Updater{config: &Config{
		Component:             "agent",
		PinnedManifestPubKeys: []string{"deploy-x:" + base64.StdEncoding.EncodeToString(deployPub)},
	}}
	if _, err := u.verifyUpdateManifest(downloadInfo{
		URL:               "https://updates.example.invalid/agent",
		Checksum:          checksum,
		Manifest:          payload,
		ManifestSignature: sig,
	}, "1.2.3"); err != nil {
		t.Fatalf("compatibility mode should still verify against the key set: %v", err)
	}
	if *warnings != 1 {
		t.Fatalf("expected exactly 1 compatibility warning, got %d", *warnings)
	}
}

func TestVerifyUpdateManifest_MissingIDFailsClosedWhenRequired(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	installEmbeddedManifestKey(t, testEmbeddedKeyID, pub)
	warnings := countingWarner(t)

	payload, sig, checksum := signManifestFor(t, "1.2.3", priv)
	u := &Updater{config: &Config{Component: "agent", RequireManifestSigningKeyID: true}}
	_, err = u.verifyUpdateManifest(downloadInfo{
		URL:               "https://updates.example.invalid/agent",
		Checksum:          checksum,
		Manifest:          payload,
		ManifestSignature: sig,
	}, "1.2.3")
	if err == nil {
		t.Fatal("expected a missing signing key id to fail closed when required")
	}
	if !strings.Contains(err.Error(), "manifest signing key ID required") {
		t.Fatalf("expected 'manifest signing key ID required', got: %v", err)
	}
	if *warnings != 0 {
		t.Fatalf("fail-closed mode must not emit the compatibility warning (warnings=%d)", *warnings)
	}
}

func TestVerifyUpdateManifest_MissingIDWarnsOncePerProcess(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	installEmbeddedManifestKey(t, testEmbeddedKeyID, pub)
	warnings := countingWarner(t)

	payload, sig, checksum := signManifestFor(t, "1.2.3", priv)
	u := &Updater{config: &Config{Component: "agent"}}
	info := downloadInfo{
		URL:               "https://updates.example.invalid/agent",
		Checksum:          checksum,
		Manifest:          payload,
		ManifestSignature: sig,
	}
	for i := 0; i < 5; i++ {
		if _, err := u.verifyUpdateManifest(info, "1.2.3"); err != nil {
			t.Fatalf("iteration %d: %v", i, err)
		}
	}
	// A separate Updater instance shares the process-wide guard.
	other := &Updater{config: &Config{Component: "agent"}}
	if _, err := other.verifyUpdateManifest(info, "1.2.3"); err != nil {
		t.Fatalf("second updater: %v", err)
	}
	if *warnings != 1 {
		t.Fatalf("expected the warning to be bounded to once per process, got %d", *warnings)
	}
}

// A malformed pinned entry fails the whole trust assembly. Dropping it would
// silently strand the deployment on the embedded vendor root without anyone
// noticing that the pin was lost.
func TestManifestTrustKeys_RejectsMalformedPinnedEntries(t *testing.T) {
	for _, entry := range []string{
		"missing-colon",
		"key-id:",
		"key-id:not-valid-base64-!!!",
		":",
		"key-id:" + base64.StdEncoding.EncodeToString([]byte("too short")),
	} {
		t.Run(entry, func(t *testing.T) {
			u := &Updater{config: &Config{PinnedManifestPubKeys: []string{entry}}}
			if _, _, err := u.manifestTrustKeys(); err == nil {
				t.Fatalf("expected malformed pinned entry %q to fail closed", entry)
			}
		})
	}
}

func TestManifestTrustKeys_IncludesEmbeddedAndPinnedByID(t *testing.T) {
	embeddedPub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	installEmbeddedManifestKey(t, testEmbeddedKeyID, embeddedPub)

	deployPub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	u := &Updater{config: &Config{
		PinnedManifestPubKeys: []string{"deploy-x:" + base64.StdEncoding.EncodeToString(deployPub)},
	}}
	keyed, _, err := u.manifestTrustKeys()
	if err != nil {
		t.Fatalf("manifestTrustKeys: %v", err)
	}
	if got, ok := keyed[testEmbeddedKeyID]; !ok || !got.Equal(embeddedPub) {
		t.Fatalf("embedded key missing or wrong under its id: %v", keyed)
	}
	if got, ok := keyed["deploy-x"]; !ok || !got.Equal(deployPub) {
		t.Fatalf("pinned key missing or wrong under its id: %v", keyed)
	}
}

// A deployment must not be able to substitute its own key for the vendor root
// by pinning it under the embedded key's ID.
func TestManifestTrustKeys_RejectsDeploymentKeyShadowingEmbeddedID(t *testing.T) {
	embeddedPub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	installEmbeddedManifestKey(t, testEmbeddedKeyID, embeddedPub)

	attackerPub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	u := &Updater{config: &Config{
		PinnedManifestPubKeys: []string{testEmbeddedKeyID + ":" + base64.StdEncoding.EncodeToString(attackerPub)},
	}}
	if _, _, err := u.manifestTrustKeys(); err == nil {
		t.Fatal("expected a pinned key shadowing the embedded key id to fail closed")
	}
}

// Verification must fail closed when there is no trust material at all rather
// than treating "no keys" as "nothing to check".
func TestVerifyUpdateManifest_FailsWithNoTrustedKeys(t *testing.T) {
	_, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	old := embeddedManifestPublicKeys
	embeddedManifestPublicKeys = ManifestPublicKeys{}
	t.Cleanup(func() { embeddedManifestPublicKeys = old })
	countingWarner(t)

	payload, sig, checksum := signManifestFor(t, "1.2.3", priv)
	u := &Updater{config: &Config{Component: "agent"}}
	info := downloadInfo{
		URL:               "https://updates.example.invalid/agent",
		Checksum:          checksum,
		Manifest:          payload,
		ManifestSignature: sig,
	}
	if _, err := u.verifyUpdateManifest(info, "1.2.3"); err == nil {
		t.Fatal("expected failure with no trusted keys (missing-ID path)")
	}
	info.SigningKeyID = testEmbeddedKeyID
	if _, err := u.verifyUpdateManifest(info, "1.2.3"); err == nil {
		t.Fatal("expected failure with no trusted keys (exact-ID path)")
	}
}

// --- diagnosability of a fail-closed trust set ------------------------------

// captureUnusableTrustSetLog swaps the trust-set log seam for a recorder and
// clears the latch, so a test can assert both the content and the boundedness
// of the line an operator would actually see.
func captureUnusableTrustSetLog(t *testing.T) *[]string {
	t.Helper()
	var got []string
	old := unusableTrustSetLogger
	unusableTrustSetLogger = func(reason string) { got = append(got, reason) }
	resetUnusableTrustSetLogForTests()
	t.Cleanup(func() {
		unusableTrustSetLogger = old
		resetUnusableTrustSetLogForTests()
	})
	return &got
}

// A malformed pin disables auto-update entirely. That is deliberate, but it
// must be diagnosable: the operator gets one line naming the offending entry
// and the remediation, not silence and not one line per heartbeat.
func TestManifestTrustKeys_UnusableTrustSetLogsOnceWithRemediation(t *testing.T) {
	logged := captureUnusableTrustSetLog(t)

	u := &Updater{config: &Config{
		PinnedManifestPubKeys: []string{"deploy-broken:not-base64!!!"},
	}}
	for i := 0; i < 5; i++ {
		if _, _, err := u.manifestTrustKeys(); err == nil {
			t.Fatalf("iteration %d: expected the malformed pin to fail closed", i)
		}
	}

	if len(*logged) != 1 {
		t.Fatalf("expected exactly 1 log line for a persistently broken trust set, got %d: %v", len(*logged), *logged)
	}
	line := (*logged)[0]
	for _, want := range []string{"deploy-broken", "entry #1"} {
		if !strings.Contains(line, want) {
			t.Errorf("log line does not identify the offending entry (missing %q): %s", want, line)
		}
	}
	if strings.Contains(line, "not-base64") {
		t.Errorf("log line echoed the entry's key material: %s", line)
	}
}

// A different failure is a different operator problem, so it logs again; and a
// trust set that becomes usable re-arms the latch.
func TestManifestTrustKeys_UnusableTrustSetLogRearms(t *testing.T) {
	logged := captureUnusableTrustSetLog(t)

	broken := &Updater{config: &Config{PinnedManifestPubKeys: []string{"deploy-a:not-base64!!!"}}}
	if _, _, err := broken.manifestTrustKeys(); err == nil {
		t.Fatal("expected failure")
	}
	otherBroken := &Updater{config: &Config{PinnedManifestPubKeys: []string{"no-colon-at-all"}}}
	if _, _, err := otherBroken.manifestTrustKeys(); err == nil {
		t.Fatal("expected failure")
	}
	if len(*logged) != 2 {
		t.Fatalf("expected a distinct failure to log again, got %d lines: %v", len(*logged), *logged)
	}

	// Recovery (e.g. re-enrollment rewrote the pin) clears the latch...
	healthy := &Updater{config: &Config{}}
	if _, _, err := healthy.manifestTrustKeys(); err != nil {
		t.Fatalf("healthy trust set: %v", err)
	}
	// ...so the same failure recurring afterwards is reported again.
	if _, _, err := otherBroken.manifestTrustKeys(); err == nil {
		t.Fatal("expected failure")
	}
	if len(*logged) != 3 {
		t.Fatalf("expected the latch to re-arm after recovery, got %d lines: %v", len(*logged), *logged)
	}
}

// --- BREEZE_UPDATE_MANIFEST_PUBLIC_KEYS ------------------------------------
//
// The env var is the self-hoster's escape hatch. Its parser is new (keyed vs
// legacy bare form, and hard errors where the old code silently skipped), and
// getting it wrong means "no updates at all" on a self-hosted fleet.

func TestManifestTrustKeys_EnvKeyedEntryVerifiesByExactID(t *testing.T) {
	embeddedPub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	installEmbeddedManifestKey(t, testEmbeddedKeyID, embeddedPub)
	captureUnusableTrustSetLog(t)
	countingWarner(t)

	envPub, envPriv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("BREEZE_UPDATE_MANIFEST_PUBLIC_KEYS", "selfhost-2026:"+base64.StdEncoding.EncodeToString(envPub))

	payload, sig, checksum := signManifestFor(t, "1.2.3", envPriv)
	u := &Updater{config: &Config{Component: "agent"}}
	if _, err := u.verifyUpdateManifest(downloadInfo{
		URL:               "https://updates.example.invalid/agent",
		Checksum:          checksum,
		Manifest:          payload,
		ManifestSignature: sig,
		SigningKeyID:      "selfhost-2026",
	}, "1.2.3"); err != nil {
		t.Fatalf("keyed env entry should verify under its own id: %v", err)
	}
}

func TestManifestTrustKeys_EnvBareEntryOnlyReachableWithoutID(t *testing.T) {
	embeddedPub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	installEmbeddedManifestKey(t, testEmbeddedKeyID, embeddedPub)
	captureUnusableTrustSetLog(t)
	warnings := countingWarner(t)

	envPub, envPriv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("BREEZE_UPDATE_MANIFEST_PUBLIC_KEYS", base64.StdEncoding.EncodeToString(envPub))

	payload, sig, checksum := signManifestFor(t, "1.2.3", envPriv)
	info := downloadInfo{
		URL:               "https://updates.example.invalid/agent",
		Checksum:          checksum,
		Manifest:          payload,
		ManifestSignature: sig,
	}
	u := &Updater{config: &Config{Component: "agent"}}

	// A legacy bare entry has no ID, so it can only ever be reached on the
	// missing-ID compatibility path.
	if _, err := u.verifyUpdateManifest(info, "1.2.3"); err != nil {
		t.Fatalf("bare env key should verify on the missing-ID path: %v", err)
	}
	if *warnings != 1 {
		t.Fatalf("expected the compatibility warning, got %d", *warnings)
	}

	// Naming any ID must not reach it — there is no ID it could be named by.
	info.SigningKeyID = testEmbeddedKeyID
	if _, err := u.verifyUpdateManifest(info, "1.2.3"); err == nil {
		t.Fatal("a bare env key must not satisfy an ID-bound manifest")
	}
}

// The exact-ID branch must not fall through to the legacy unkeyed slice on an
// unknown ID — that would reintroduce the substitution this task closed, just
// via the env var instead of the pin file.
func TestVerifyUpdateManifest_UnknownIDDoesNotFallBackToLegacyEnvKeys(t *testing.T) {
	embeddedPub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	installEmbeddedManifestKey(t, testEmbeddedKeyID, embeddedPub)
	captureUnusableTrustSetLog(t)
	warnings := countingWarner(t)

	envPub, envPriv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("BREEZE_UPDATE_MANIFEST_PUBLIC_KEYS", base64.StdEncoding.EncodeToString(envPub))

	payload, sig, checksum := signManifestFor(t, "1.2.3", envPriv)
	u := &Updater{config: &Config{Component: "agent"}}
	_, err = u.verifyUpdateManifest(downloadInfo{
		URL:               "https://updates.example.invalid/agent",
		Checksum:          checksum,
		Manifest:          payload,
		ManifestSignature: sig,
		SigningKeyID:      "an-id-nobody-has",
	}, "1.2.3")
	if err == nil {
		t.Fatal("expected an unknown id to fail closed even though a legacy env key would verify the bytes")
	}
	if !strings.Contains(err.Error(), "unknown") {
		t.Fatalf("expected an unknown-key-id error, got: %v", err)
	}
	if *warnings != 0 {
		t.Fatalf("unknown id must not take the compatibility path (warnings=%d)", *warnings)
	}
}

func TestManifestTrustKeys_RejectsMalformedEnvEntries(t *testing.T) {
	valid := base64.StdEncoding.EncodeToString(make([]byte, ed25519.PublicKeySize))
	cases := []struct {
		name string
		env  string
	}{
		{"keyed entry with an invalid id", "bad id!:" + valid},
		{"keyed entry with a non-base64 key", "selfhost:not-base64!!!"},
		{"keyed entry with a wrong-length key", "selfhost:" + base64.StdEncoding.EncodeToString([]byte("short"))},
		{"bare entry that is not base64", "not-base64!!!"},
		{"bare entry of the wrong length", base64.StdEncoding.EncodeToString([]byte("short"))},
		{"one good entry and one broken one", valid + ",not-base64!!!"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			captureUnusableTrustSetLog(t)
			t.Setenv("BREEZE_UPDATE_MANIFEST_PUBLIC_KEYS", tc.env)
			u := &Updater{config: &Config{}}
			if _, _, err := u.manifestTrustKeys(); err == nil {
				t.Fatalf("expected env value %q to fail closed", tc.env)
			}
		})
	}
}

// An operator must not be able to displace the vendor root via the env var
// any more than via a pinned key.
func TestManifestTrustKeys_RejectsEnvKeyShadowingEmbeddedID(t *testing.T) {
	embeddedPub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	installEmbeddedManifestKey(t, testEmbeddedKeyID, embeddedPub)
	captureUnusableTrustSetLog(t)

	otherPub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("BREEZE_UPDATE_MANIFEST_PUBLIC_KEYS", testEmbeddedKeyID+":"+base64.StdEncoding.EncodeToString(otherPub))

	u := &Updater{config: &Config{}}
	if _, _, err := u.manifestTrustKeys(); err == nil {
		t.Fatal("expected an env key shadowing the embedded id to fail closed")
	}
}

// Only the fail-closed direction of RequireManifestSigningKeyID was covered;
// this pins that the flag does not break the normal path it is meant to enforce.
func TestVerifyUpdateManifest_RequiredModeAcceptsValidSigningKeyID(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	installEmbeddedManifestKey(t, testEmbeddedKeyID, pub)
	captureUnusableTrustSetLog(t)
	warnings := countingWarner(t)

	payload, sig, checksum := signManifestFor(t, "1.2.3", priv)
	u := &Updater{config: &Config{Component: "agent", RequireManifestSigningKeyID: true}}
	got, err := u.verifyUpdateManifest(downloadInfo{
		URL:               "https://updates.example.invalid/agent",
		Checksum:          checksum,
		Manifest:          payload,
		ManifestSignature: sig,
		SigningKeyID:      testEmbeddedKeyID,
	}, "1.2.3")
	if err != nil {
		t.Fatalf("fail-closed mode must still accept a manifest that names a known key: %v", err)
	}
	if got.Version != "1.2.3" {
		t.Fatalf("version = %q, want 1.2.3", got.Version)
	}
	if *warnings != 0 {
		t.Fatalf("an ID-bearing manifest must not warn (warnings=%d)", *warnings)
	}
}

// The bounded warning is a signal that a manifest was ACCEPTED without an id.
// A response that fails verification anyway must not consume it.
func TestVerifyUpdateManifest_MissingIDWarnsOnlyOnAcceptance(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	installEmbeddedManifestKey(t, testEmbeddedKeyID, pub)
	captureUnusableTrustSetLog(t)
	warnings := countingWarner(t)

	// Signed by an untrusted key, no id supplied: verification fails.
	_, strangerPriv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	badPayload, badSig, badChecksum := signManifestFor(t, "1.2.3", strangerPriv)
	u := &Updater{config: &Config{Component: "agent"}}
	if _, err := u.verifyUpdateManifest(downloadInfo{
		URL:               "https://updates.example.invalid/agent",
		Checksum:          badChecksum,
		Manifest:          badPayload,
		ManifestSignature: badSig,
	}, "1.2.3"); err == nil {
		t.Fatal("expected an untrusted signature to fail")
	}
	if *warnings != 0 {
		t.Fatalf("a rejected manifest must not consume the one-per-process warning (warnings=%d)", *warnings)
	}

	// The next genuinely-accepted ID-less manifest still gets its warning.
	goodPayload, goodSig, goodChecksum := signManifestFor(t, "1.2.3", priv)
	if _, err := u.verifyUpdateManifest(downloadInfo{
		URL:               "https://updates.example.invalid/agent",
		Checksum:          goodChecksum,
		Manifest:          goodPayload,
		ManifestSignature: goodSig,
	}, "1.2.3"); err != nil {
		t.Fatalf("verifyUpdateManifest: %v", err)
	}
	if *warnings != 1 {
		t.Fatalf("expected the warning on acceptance, got %d", *warnings)
	}
}
