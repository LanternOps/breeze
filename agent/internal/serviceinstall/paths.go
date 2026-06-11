package serviceinstall

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const installDirName = "Breeze"

func ProtectedBinaryPathIn(programFilesDir, binaryName string) (string, error) {
	if strings.TrimSpace(programFilesDir) == "" {
		return "", fmt.Errorf("ProgramFiles is not set; cannot choose a protected service install directory")
	}
	if strings.TrimSpace(binaryName) == "" || filepath.Base(binaryName) != binaryName {
		return "", fmt.Errorf("invalid service binary name %q", binaryName)
	}

	programFilesAbs, err := filepath.Abs(programFilesDir)
	if err != nil {
		return "", fmt.Errorf("resolve ProgramFiles path: %w", err)
	}
	return filepath.Join(programFilesAbs, installDirName, binaryName), nil
}

func StageProtectedBinary(currentExe, targetPath string) (string, bool, error) {
	source, err := filepath.EvalSymlinks(currentExe)
	if err != nil {
		return "", false, fmt.Errorf("resolve current executable path: %w", err)
	}
	source, err = filepath.Abs(source)
	if err != nil {
		return "", false, fmt.Errorf("resolve current executable absolute path: %w", err)
	}
	target, err := filepath.Abs(targetPath)
	if err != nil {
		return "", false, fmt.Errorf("resolve protected executable path: %w", err)
	}
	targetForCompare := target
	if resolvedTarget, err := filepath.EvalSymlinks(target); err == nil {
		if absResolvedTarget, err := filepath.Abs(resolvedTarget); err == nil {
			targetForCompare = absResolvedTarget
		}
	}

	if samePath(source, targetForCompare) {
		if err := HardenProtectedBinaryACL(target); err != nil {
			return "", false, err
		}
		return target, false, nil
	}

	if err := copyExecutable(source, target); err != nil {
		return "", false, err
	}
	if err := HardenProtectedBinaryACL(target); err != nil {
		return "", false, err
	}

	return target, true, nil
}

func samePath(a, b string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
	}
	return filepath.Clean(a) == filepath.Clean(b)
}

func copyExecutable(source, target string) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return fmt.Errorf("create protected service install directory: %w", err)
	}

	src, err := os.Open(source)
	if err != nil {
		return fmt.Errorf("open current executable: %w", err)
	}
	defer src.Close()

	tmp, err := os.CreateTemp(filepath.Dir(target), "."+filepath.Base(target)+".tmp-*")
	if err != nil {
		return fmt.Errorf("create temporary protected executable: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)

	if _, err := io.Copy(tmp, src); err != nil {
		tmp.Close()
		return fmt.Errorf("copy executable to protected location: %w", err)
	}
	if err := tmp.Chmod(0o755); err != nil {
		tmp.Close()
		return fmt.Errorf("set protected executable mode: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close protected executable: %w", err)
	}

	if err := os.Rename(tmpPath, target); err != nil {
		if _, statErr := os.Stat(target); statErr != nil {
			return fmt.Errorf("move executable into protected location: %w", err)
		}
		if removeErr := os.Remove(target); removeErr != nil {
			return fmt.Errorf("replace existing protected executable: %w", removeErr)
		}
		if renameErr := os.Rename(tmpPath, target); renameErr != nil {
			return fmt.Errorf("move executable into protected location after replacing existing file: %w", renameErr)
		}
	}
	return nil
}
