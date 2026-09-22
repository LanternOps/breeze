package security

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/breeze-rmm/agent/internal/obfuscate"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// Quarantine neutralizes: a quarantined file is XOR-0x5A encoded (the same
// trivial transform internal/obfuscate uses for the shipped signature table) and
// written as <name>-<unixnano>.bqz beside a .bqz.json manifest. A plain rename —
// what this replaced — leaves live malware on disk, which a second AV product
// rescans and re-alerts on forever, and which an EDR may then delete out from
// under us. XOR is not security: it is an AV-recognition break plus an exact,
// reversible transform. #6263 W01 / spec D6.

const (
	quarantinePayloadExt      = ".bqz"
	quarantineManifestExt     = ".bqz.json"
	quarantineManifestVersion = 1
)

// QuarantineManifest records what a .bqz payload used to be, so restore is
// exact and the operator UI can show what got quarantined without decoding
// the payload.
type QuarantineManifest struct {
	V             int    `json:"v"`
	OriginalPath  string `json:"originalPath"`
	SHA256        string `json:"sha256"`
	Name          string `json:"name"`
	Type          string `json:"type"`
	Severity      string `json:"severity"`
	QuarantinedAt string `json:"quarantinedAt"`
}

// encodeStream copies src -> dst XOR-ing every byte, in 64 KiB chunks so a
// multi-gigabyte file never lands in memory, hashing the ORIGINAL
// (pre-XOR) bytes as it goes and returning that digest.
func encodeStream(dst io.Writer, src io.Reader) (string, error) {
	hasher := sha256.New()
	buf := make([]byte, 64*1024)
	for {
		n, readErr := src.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			if _, err := hasher.Write(chunk); err != nil {
				return "", err
			}
			encoded := obfuscate.DecodeBytes(chunk) // XOR is its own inverse
			if _, err := dst.Write(encoded); err != nil {
				return "", err
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				break
			}
			return "", readErr
		}
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

// decodeStream is the inverse of encodeStream: it XOR-decodes src (the
// on-disk .bqz payload) into dst and returns the sha256 of the DECODED
// (original) bytes, for verification against the manifest. Unlike
// encodeStream, the hash here must be computed on the OUTPUT, since the
// input is the encoded payload, not the plaintext.
func decodeStream(dst io.Writer, src io.Reader) (string, error) {
	hasher := sha256.New()
	buf := make([]byte, 64*1024)
	for {
		n, readErr := src.Read(buf)
		if n > 0 {
			decoded := obfuscate.DecodeBytes(buf[:n]) // XOR is its own inverse
			if _, err := hasher.Write(decoded); err != nil {
				return "", err
			}
			if _, err := dst.Write(decoded); err != nil {
				return "", err
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				break
			}
			return "", readErr
		}
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

// QuarantineThreat neutralizes a detected threat file: it is copied through
// the XOR-0x5A transform into `<quarantineDir>/<base>-<unixnano>.bqz`, a
// manifest recording the original path and plaintext digest is written
// beside it, and the original file is removed. Returns the .bqz payload path.
func QuarantineThreat(threat Threat, quarantineDir string) (string, error) {
	if threat.Path == "" {
		return "", fmt.Errorf("threat path is empty")
	}
	if quarantineDir == "" {
		return "", fmt.Errorf("quarantine directory is required")
	}

	if err := os.MkdirAll(quarantineDir, 0o700); err != nil {
		return "", fmt.Errorf("failed to create quarantine directory: %w", err)
	}

	base := filepath.Base(threat.Path)
	dest := filepath.Join(quarantineDir, fmt.Sprintf("%s-%d%s", base, time.Now().UnixNano(), quarantinePayloadExt))

	sha, err := quarantineEncodeFile(threat.Path, dest)
	if err != nil {
		if rmErr := os.Remove(dest); rmErr != nil && !os.IsNotExist(rmErr) {
			log.Warn("failed to clean up partial quarantine payload", "path", dest, "error", rmErr.Error())
		}
		return "", fmt.Errorf("failed to quarantine threat: %w", err)
	}

	manifest := QuarantineManifest{
		V:             quarantineManifestVersion,
		OriginalPath:  threat.Path,
		SHA256:        sha,
		Name:          threat.Name,
		Type:          threat.Type,
		Severity:      threat.Severity,
		QuarantinedAt: time.Now().UTC().Format(time.RFC3339),
	}
	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		if rmErr := os.Remove(dest); rmErr != nil && !os.IsNotExist(rmErr) {
			log.Warn("failed to clean up quarantine payload after manifest encode error", "path", dest, "error", rmErr.Error())
		}
		return "", fmt.Errorf("failed to encode quarantine manifest: %w", err)
	}
	// Write the payload first, then the manifest: a crash after this point
	// leaves a decodable payload, never a manifest pointing at nothing.
	if err := os.WriteFile(dest+".json", manifestBytes, 0o600); err != nil {
		if rmErr := os.Remove(dest); rmErr != nil && !os.IsNotExist(rmErr) {
			log.Warn("failed to clean up quarantine payload after manifest write error", "path", dest, "error", rmErr.Error())
		}
		return "", fmt.Errorf("failed to write quarantine manifest: %w", err)
	}

	if err := os.Remove(threat.Path); err != nil {
		return "", fmt.Errorf("failed to remove original threat after quarantine: %w", err)
	}

	return dest, nil
}

func quarantineEncodeFile(srcPath, destPath string) (string, error) {
	src, err := os.Open(srcPath)
	if err != nil {
		return "", err
	}
	defer func() {
		if closeErr := src.Close(); closeErr != nil {
			log.Warn("failed to close quarantine source file", "path", srcPath, "error", closeErr.Error())
		}
	}()

	info, err := src.Stat()
	if err != nil {
		return "", err
	}

	dst, err := os.OpenFile(destPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode()&0o600|0o600)
	if err != nil {
		return "", err
	}
	defer func() {
		if closeErr := dst.Close(); closeErr != nil {
			log.Warn("failed to close quarantine destination file", "path", destPath, "error", closeErr.Error())
		}
	}()

	sha, err := encodeStream(dst, src)
	if err != nil {
		return "", err
	}
	if err := dst.Sync(); err != nil {
		return "", err
	}
	return sha, nil
}

// RestoreQuarantined reverses a quarantine. If quarantinedPath has a sibling
// `.bqz.json` manifest, the file is XOR-decoded, its digest is verified
// against the manifest, and it is written back to the manifest's
// OriginalPath (or the caller's explicit originalPath, if given) — then the
// payload and manifest are removed. Without a manifest (a pre-W01
// plain-rename quarantine entry), originalPath is required and the entry is
// restored via a plain rename with a copy+remove fallback for a cross-device
// move.
func RestoreQuarantined(quarantinedPath, originalPath string) (string, error) {
	cleanSource := filepath.Clean(quarantinedPath)
	if err := tools.EnforcePathContainment("restore", cleanSource); err != nil {
		return "", err
	}

	manifestPath := quarantineManifestPath(cleanSource)
	manifestBytes, statErr := os.ReadFile(manifestPath)
	if statErr != nil {
		// No manifest: legacy plain-rename entry. Requires an explicit target.
		if originalPath == "" {
			return "", fmt.Errorf("no quarantine manifest found and no originalPath given for %s", cleanSource)
		}
		cleanTarget := filepath.Clean(originalPath)
		if err := tools.EnforcePathContainment("write", cleanTarget); err != nil {
			return "", err
		}
		if err := restoreLegacyEntry(cleanSource, cleanTarget); err != nil {
			return "", err
		}
		return cleanTarget, nil
	}

	var manifest QuarantineManifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		return "", fmt.Errorf("failed to parse quarantine manifest: %w", err)
	}

	target := manifest.OriginalPath
	if originalPath != "" {
		target = originalPath
	}
	if target == "" {
		return "", fmt.Errorf("quarantine manifest has no originalPath and none was given")
	}
	cleanTarget := filepath.Clean(target)
	if err := tools.EnforcePathContainment("write", cleanTarget); err != nil {
		return "", err
	}

	if err := os.MkdirAll(filepath.Dir(cleanTarget), 0o755); err != nil {
		return "", fmt.Errorf("failed to create restore directory: %w", err)
	}

	if err := restoreManifestEntry(cleanSource, cleanTarget, manifest); err != nil {
		return "", err
	}

	// Remove the manifest first, then the payload: a crash between the two
	// still leaves a decodable payload rather than an orphaned manifest.
	if err := os.Remove(manifestPath); err != nil && !os.IsNotExist(err) {
		return "", fmt.Errorf("failed to remove quarantine manifest: %w", err)
	}
	if err := os.Remove(cleanSource); err != nil && !os.IsNotExist(err) {
		return "", fmt.Errorf("failed to remove quarantine payload: %w", err)
	}

	return cleanTarget, nil
}

func restoreManifestEntry(cleanSource, cleanTarget string, manifest QuarantineManifest) error {
	src, err := os.Open(cleanSource)
	if err != nil {
		return fmt.Errorf("failed to open quarantine payload: %w", err)
	}
	defer func() {
		if closeErr := src.Close(); closeErr != nil {
			log.Warn("failed to close quarantine payload during restore", "path", cleanSource, "error", closeErr.Error())
		}
	}()

	tmp := cleanTarget + ".restoring"
	dst, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("failed to open restore target: %w", err)
	}

	removeTmp := func() {
		if rmErr := os.Remove(tmp); rmErr != nil && !os.IsNotExist(rmErr) {
			log.Warn("failed to clean up restore temp file", "path", tmp, "error", rmErr.Error())
		}
	}

	sha, err := decodeStream(dst, src)
	closeErr := dst.Close()
	if err != nil {
		removeTmp()
		return fmt.Errorf("failed to decode quarantine payload: %w", err)
	}
	if closeErr != nil {
		removeTmp()
		return fmt.Errorf("failed to finalize restore target: %w", closeErr)
	}

	if manifest.SHA256 != "" && sha != manifest.SHA256 {
		removeTmp()
		return fmt.Errorf("restored file digest %s does not match manifest digest %s", sha, manifest.SHA256)
	}

	if err := os.Rename(tmp, cleanTarget); err != nil {
		removeTmp()
		return fmt.Errorf("failed to finalize restored file: %w", err)
	}
	return nil
}

func restoreLegacyEntry(cleanSource, cleanTarget string) error {
	if err := os.MkdirAll(filepath.Dir(cleanTarget), 0o755); err != nil {
		return fmt.Errorf("failed to create restore directory: %w", err)
	}
	if err := os.Rename(cleanSource, cleanTarget); err == nil {
		return nil
	}
	// Cross-device move: copy then remove.
	if err := copyFile(cleanSource, cleanTarget); err != nil {
		return fmt.Errorf("failed to restore file: %w", err)
	}
	if err := os.Remove(cleanSource); err != nil {
		return fmt.Errorf("failed to remove quarantine entry after copy: %w", err)
	}
	return nil
}

func quarantineManifestPath(payloadPath string) string {
	if filepath.Ext(payloadPath) == quarantinePayloadExt {
		return payloadPath[:len(payloadPath)-len(quarantinePayloadExt)] + quarantineManifestExt
	}
	return payloadPath + quarantineManifestExt
}
