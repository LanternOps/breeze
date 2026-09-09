package systemstate

import (
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
)

// artifactFromFile creates an Artifact for a single collected file.
func artifactFromFile(name, category, absPath, stagingDir string) Artifact {
	relPath, _ := filepath.Rel(stagingDir, absPath)
	var size int64
	if info, err := os.Stat(absPath); err == nil {
		size = info.Size()
	}
	return Artifact{
		Name:      name,
		Category:  category,
		Path:      filepath.ToSlash(relPath),
		SizeBytes: size,
	}
}

// collectArtifactsInDir walks a directory and returns an Artifact for each file.
func collectArtifactsInDir(category, dir, stagingDir string) ([]Artifact, error) {
	var artifacts []Artifact
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil // skip errors
		}
		if d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		relPath, _ := filepath.Rel(stagingDir, path)
		artifacts = append(artifacts, Artifact{
			Name:      filepath.Base(path),
			Category:  category,
			Path:      filepath.ToSlash(relPath),
			SizeBytes: info.Size(),
		})
		return nil
	})
	return artifacts, err
}

// copyFile copies a single file from src to dst.
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("open %s: %w", src, err)
	}
	defer in.Close()

	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return err
	}

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("create %s: %w", dst, err)
	}
	defer out.Close()

	if _, err := io.Copy(out, in); err != nil {
		return fmt.Errorf("copy %s → %s: %w", src, dst, err)
	}
	return nil
}

// copyTree recursively copies a directory tree. Symlinks are skipped.
// Permission errors on individual files are logged and skipped, not fatal.
func copyTree(srcRoot, dstRoot string) error {
	return filepath.WalkDir(srcRoot, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil // skip inaccessible entries
		}

		relPath, err := filepath.Rel(srcRoot, path)
		if err != nil {
			return nil
		}
		dstPath := filepath.Join(dstRoot, relPath)

		if d.IsDir() {
			return os.MkdirAll(dstPath, 0o700)
		}

		// Skip symlinks and non-regular files.
		if !d.Type().IsRegular() {
			return nil
		}

		if err := copyFile(path, dstPath); err != nil {
			// Non-fatal: skip files we can't read (e.g. /etc/shadow).
			return nil
		}
		return nil
	})
}

// ---------------------------------------------------------------------------
// Windows registry hive collection and Certificate Services detection
//
// These live here (rather than in state_windows.go, which is build-tagged
// windows) so the decision logic — which hives failed, whether AD CS looks
// installed — is exercisable in unit tests on any platform, without a real
// Windows machine or reg.exe/certutil.exe. The package-level var seams below
// are overridden by tests; state_windows.go uses the defaults unmodified.
// ---------------------------------------------------------------------------

// runRegSave executes `reg save HKLM\<hive> <outPath> /y`, capturing combined
// output for diagnostics. It is a package-level var (rather than a direct
// exec.Command call in collectRegistryHives) purely so tests can substitute a
// fake.
var runRegSave = func(hive, outPath string) ([]byte, error) {
	return exec.Command("reg", "save", `HKLM\`+hive, outPath, "/y").CombinedOutput()
}

// registrySaveError reports that one or more registry hives failed to save.
// FailedHives names exactly which ones, so callers can log or surface the
// specific hive instead of only "the registry step failed".
type registrySaveError struct {
	FailedHives []string
	Err         error // the first hive's error, representative of the failure
}

func (e *registrySaveError) Error() string {
	return fmt.Sprintf("reg save failed for hive(s) %v: %s", e.FailedHives, e.Err)
}

func (e *registrySaveError) Unwrap() error { return e.Err }

// collectRegistryHives saves each named hive from dir via runRegSave. Hives
// that succeed are kept as artifacts even when others fail — a partial
// registry capture is more useful for diagnosis than none — while a non-nil
// *registrySaveError tells the caller exactly which hive(s) are missing so it
// can decide whether that's acceptable.
func collectRegistryHives(dir, stagingDir string, hives []string) ([]Artifact, error) {
	var artifacts []Artifact
	var failed []string
	var firstErr error
	for _, hive := range hives {
		outPath := filepath.Join(dir, hive)
		out, err := runRegSave(hive, outPath)
		if err != nil {
			slog.Warn("systemstate: reg save failed", "hive", hive, "error", err.Error(), "output", string(out))
			failed = append(failed, hive)
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		artifacts = append(artifacts, artifactFromFile("registry_"+hive, "registry", outPath, stagingDir))
	}
	if len(failed) > 0 {
		return artifacts, &registrySaveError{FailedHives: failed, Err: firstErr}
	}
	return artifacts, nil
}

// certSvcInstalled reports whether the AD CS (Certificate Services) role
// appears to be installed, checked the same way collectIIS checks for IIS:
// existence of the role's binary under %WINDIR%\system32. A package-level var
// so tests can fake it without a real Windows machine.
var certSvcInstalled = func() bool {
	certsrv := filepath.Join(os.Getenv("WINDIR"), "system32", "certsrv.exe")
	_, err := os.Stat(certsrv)
	return err == nil
}
