package security

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Threat represents a detected security threat.
type Threat struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Severity string `json:"severity"`
	Path     string `json:"path"`
}

const (
	ThreatSeverityLow      = "low"
	ThreatSeverityMedium   = "medium"
	ThreatSeverityHigh     = "high"
	ThreatSeverityCritical = "critical"
)

type threatSignature struct {
	Name             string
	Type             string
	Severity         string
	FilenamePatterns []string
	ContentPattern   []byte
}

var defaultThreatSignatures = []threatSignature{
	{
		Name:             "EICAR-Test-File",
		Type:             "malware",
		Severity:         ThreatSeverityHigh,
		FilenamePatterns: []string{"eicar"},
		ContentPattern:   []byte("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"),
	},
	{
		Name:             "Mimikatz",
		Type:             "malware",
		Severity:         ThreatSeverityHigh,
		FilenamePatterns: []string{"mimikatz", "sekurlsa"},
	},
	{
		Name:             "CobaltStrike-Beacon",
		Type:             "malware",
		Severity:         ThreatSeverityCritical,
		FilenamePatterns: []string{"cobaltstrike", "beacon"},
	},
	{
		Name:             "Emotet",
		Type:             "trojan",
		Severity:         ThreatSeverityCritical,
		FilenamePatterns: []string{"emotet", "trickbot"},
	},
	{
		Name:             "Ransomware-Note",
		Type:             "ransomware",
		Severity:         ThreatSeverityHigh,
		FilenamePatterns: []string{"_readme", "how_to_decrypt", "recover", "decrypt"},
	},
}

type threatScanOptions struct {
	MaxFileSize  int64
	MaxReadBytes int64
	ExcludePaths []string
}

// DetectThreats scans the provided paths for known malware patterns.
func DetectThreats(paths []string) ([]Threat, error) {
	return detectThreats(paths, defaultThreatScanOptions())
}

func detectThreats(paths []string, options threatScanOptions) ([]Threat, error) {
	cleanPaths := uniquePaths(paths)
	var threats []Threat
	seen := make(map[string]struct{})
	var errs []error

	for _, path := range cleanPaths {
		if path == "" {
			continue
		}
		if isExcludedPath(path, options.ExcludePaths) {
			continue
		}

		info, err := os.Lstat(path)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			errs = append(errs, err)
			continue
		}
		if info.Mode()&os.ModeSymlink != 0 {
			continue
		}

		if info.IsDir() {
			err := filepath.WalkDir(path, func(current string, entry fs.DirEntry, walkErr error) error {
				if walkErr != nil {
					if os.IsPermission(walkErr) {
						return fs.SkipDir
					}
					errs = append(errs, walkErr)
					return nil
				}

				if isExcludedPath(current, options.ExcludePaths) {
					if entry.IsDir() {
						return fs.SkipDir
					}
					return nil
				}

				if entry.Type()&os.ModeSymlink != 0 {
					if entry.IsDir() {
						return fs.SkipDir
					}
					return nil
				}

				if entry.IsDir() {
					return nil
				}

				info, err := entry.Info()
				if err != nil {
					if os.IsPermission(err) {
						return nil
					}
					errs = append(errs, err)
					return nil
				}

				if !info.Mode().IsRegular() {
					return nil
				}

				found, err := scanFileForThreats(current, info, options)
				if err != nil {
					if !os.IsPermission(err) {
						errs = append(errs, err)
					}
					return nil
				}

				for _, threat := range found {
					key := threat.Name + "|" + threat.Path
					if _, ok := seen[key]; ok {
						continue
					}
					seen[key] = struct{}{}
					threats = append(threats, threat)
				}

				return nil
			})
			if err != nil && !os.IsPermission(err) {
				errs = append(errs, err)
			}
			continue
		}

		if info.Mode().IsRegular() {
			found, err := scanFileForThreats(path, info, options)
			if err != nil {
				if !os.IsPermission(err) {
					errs = append(errs, err)
				}
				continue
			}
			for _, threat := range found {
				key := threat.Name + "|" + threat.Path
				if _, ok := seen[key]; ok {
					continue
				}
				seen[key] = struct{}{}
				threats = append(threats, threat)
			}
		}
	}

	return threats, errors.Join(errs...)
}

// QuarantineThreat moves a detected threat to a quarantine directory.
func QuarantineThreat(threat Threat, quarantineDir string) (string, error) {
	if threat.Path == "" {
		return "", fmt.Errorf("threat path is empty")
	}
	if quarantineDir == "" {
		return "", fmt.Errorf("quarantine directory is required")
	}

	if err := os.MkdirAll(quarantineDir, 0700); err != nil {
		return "", fmt.Errorf("failed to create quarantine directory: %w", err)
	}

	base := filepath.Base(threat.Path)
	dest := filepath.Join(quarantineDir, fmt.Sprintf("%s-%d", base, time.Now().UnixNano()))

	if err := os.Rename(threat.Path, dest); err != nil {
		if copyErr := copyFile(threat.Path, dest); copyErr != nil {
			return "", fmt.Errorf("failed to quarantine threat: %w", err)
		}
		if removeErr := os.Remove(threat.Path); removeErr != nil {
			return "", fmt.Errorf("failed to remove original threat after copy: %w", removeErr)
		}
		return dest, nil
	}

	return dest, nil
}

// RemoveThreat deletes the threat file from disk.
func RemoveThreat(threat Threat) error {
	if threat.Path == "" {
		return fmt.Errorf("threat path is empty")
	}
	if err := os.Remove(threat.Path); err != nil {
		return fmt.Errorf("failed to remove threat: %w", err)
	}
	return nil
}

func scanFileForThreats(path string, info fs.FileInfo, options threatScanOptions) ([]Threat, error) {
	nameLower := strings.ToLower(info.Name())
	pathLower := strings.ToLower(path)
	var matches []Threat

	needsContent := false
	for _, signature := range defaultThreatSignatures {
		if signatureMatchesName(signature, nameLower, pathLower) {
			matches = append(matches, Threat{
				Name:     signature.Name,
				Type:     signature.Type,
				Severity: signature.Severity,
				Path:     path,
			})
		}
		if len(signature.ContentPattern) > 0 {
			needsContent = true
		}
	}

	if !needsContent {
		return matches, nil
	}

	if info.Size() <= 0 || (options.MaxFileSize > 0 && info.Size() > options.MaxFileSize) {
		return matches, nil
	}

	content, err := readFileSample(path, options.MaxReadBytes)
	if err != nil {
		return matches, err
	}

	for _, signature := range defaultThreatSignatures {
		if len(signature.ContentPattern) == 0 {
			continue
		}
		if bytes.Contains(content, signature.ContentPattern) {
			matches = append(matches, Threat{
				Name:     signature.Name,
				Type:     signature.Type,
				Severity: signature.Severity,
				Path:     path,
			})
		}
	}

	return matches, nil
}

func signatureMatchesName(signature threatSignature, nameLower string, pathLower string) bool {
	for _, pattern := range signature.FilenamePatterns {
		if pattern == "" {
			continue
		}
		pattern = strings.ToLower(pattern)
		if strings.Contains(nameLower, pattern) || strings.Contains(pathLower, pattern) {
			return true
		}
	}
	return false
}

func readFileSample(path string, maxReadBytes int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	if maxReadBytes <= 0 {
		maxReadBytes = 1024 * 1024
	}

	reader := io.LimitReader(file, maxReadBytes)
	return io.ReadAll(reader)
}

func copyFile(src string, dest string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	info, err := in.Stat()
	if err != nil {
		return err
	}

	out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode())
	if err != nil {
		return err
	}
	defer out.Close()

	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Sync()
}

func defaultThreatScanOptions() threatScanOptions {
	return threatScanOptions{
		MaxFileSize:  25 * 1024 * 1024,
		MaxReadBytes: 1024 * 1024,
		ExcludePaths: defaultExcludedPaths(),
	}
}

func defaultExcludedPaths() []string {
	switch runtime.GOOS {
	case "windows":
		var paths []string
		if programData := os.Getenv("ProgramData"); programData != "" {
			paths = append(paths, filepath.Join(programData, "Microsoft", "Windows Defender", "Quarantine"))
		}
		if systemDrive := os.Getenv("SystemDrive"); systemDrive != "" {
			paths = append(paths,
				filepath.Join(systemDrive, "Windows", "WinSxS"),
				filepath.Join(systemDrive, "System Volume Information"),
				filepath.Join(systemDrive, "$Recycle.Bin"),
			)
		}
		return paths
	case "darwin":
		return []string{
			"/System",
			"/Volumes",
			"/private/var/folders",
		}
	default:
		return []string{
			"/proc",
			"/sys",
			"/dev",
			"/run",
			"/snap",
			"/var/lib/docker",
		}
	}
}

func isExcludedPath(path string, excludes []string) bool {
	if len(excludes) == 0 {
		return false
	}

	clean := filepath.Clean(path)
	lower := strings.ToLower(clean)
	for _, raw := range excludes {
		if raw == "" {
			continue
		}
		prefix := filepath.Clean(raw)
		if prefix == "." || prefix == string(os.PathSeparator) {
			continue
		}
		prefixLower := strings.ToLower(prefix)
		if hasPathPrefix(lower, prefixLower) {
			return true
		}
	}
	return false
}

func hasPathPrefix(path string, prefix string) bool {
	if !strings.HasPrefix(path, prefix) {
		return false
	}
	if len(path) == len(prefix) {
		return true
	}
	separator := string(os.PathSeparator)
	if strings.HasSuffix(prefix, separator) {
		return true
	}
	return strings.HasPrefix(path[len(prefix):], separator)
}

func uniquePaths(paths []string) []string {
	seen := make(map[string]struct{}, len(paths))
	var cleaned []string
	for _, p := range paths {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		p = filepath.Clean(p)
		key := strings.ToLower(p)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		cleaned = append(cleaned, p)
	}
	return cleaned
}
