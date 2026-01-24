package backup

import (
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// CompressFile compresses a file with gzip.
func CompressFile(srcPath, destPath string) error {
	srcFile, err := os.Open(srcPath)
	if err != nil {
		return fmt.Errorf("failed to open source file: %w", err)
	}
	srcInfo, statErr := srcFile.Stat()
	if statErr != nil {
		_ = srcFile.Close()
		return fmt.Errorf("failed to stat source file: %w", statErr)
	}

	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		_ = srcFile.Close()
		return fmt.Errorf("failed to create destination directory: %w", err)
	}

	destFile, err := os.Create(destPath)
	if err != nil {
		_ = srcFile.Close()
		return fmt.Errorf("failed to create destination file: %w", err)
	}

	gzipWriter := gzip.NewWriter(destFile)
	gzipWriter.Name = filepath.Base(srcPath)
	gzipWriter.ModTime = srcInfo.ModTime()

	_, err = io.Copy(gzipWriter, srcFile)
	closeErr := gzipWriter.Close()
	if err == nil {
		err = closeErr
	}
	closeErr = destFile.Close()
	if err == nil {
		err = closeErr
	}
	closeErr = srcFile.Close()
	if err == nil {
		err = closeErr
	}

	if err != nil {
		return fmt.Errorf("failed to compress file: %w", err)
	}
	return nil
}

// DecompressFile decompresses a gzip file.
func DecompressFile(srcPath, destPath string) error {
	srcFile, err := os.Open(srcPath)
	if err != nil {
		return fmt.Errorf("failed to open source file: %w", err)
	}

	gzipReader, err := gzip.NewReader(srcFile)
	if err != nil {
		_ = srcFile.Close()
		return fmt.Errorf("failed to create gzip reader: %w", err)
	}

	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		_ = gzipReader.Close()
		_ = srcFile.Close()
		return fmt.Errorf("failed to create destination directory: %w", err)
	}

	destFile, err := os.Create(destPath)
	if err != nil {
		_ = gzipReader.Close()
		_ = srcFile.Close()
		return fmt.Errorf("failed to create destination file: %w", err)
	}

	_, err = io.Copy(destFile, gzipReader)
	closeErr := destFile.Close()
	if err == nil {
		err = closeErr
	}
	closeErr = gzipReader.Close()
	if err == nil {
		err = closeErr
	}
	closeErr = srcFile.Close()
	if err == nil {
		err = closeErr
	}

	if err != nil {
		return fmt.Errorf("failed to decompress file: %w", err)
	}
	return nil
}
