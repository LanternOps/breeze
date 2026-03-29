package systemstate

import (
	"fmt"
	"io"
	"io/fs"
	"os"
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
