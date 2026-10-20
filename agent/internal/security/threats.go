package security

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/breeze-rmm/agent/internal/obfuscate"
	"github.com/breeze-rmm/agent/internal/yarascan"
)

// Threat represents a detected security threat.
type Threat struct {
	Name          string `json:"name"`
	Type          string `json:"type"`
	Severity      string `json:"severity"`
	Path          string `json:"path"`
	QuarantinedTo string `json:"quarantinedTo,omitempty"`
	// QuarantineFailed distinguishes "auto-quarantine attempted and failed"
	// from "quarantined" (QuarantinedTo set) and "auto-quarantine off"
	// (neither set) — all three would otherwise report QuarantinedTo == ""
	// and be indistinguishable to the server. Set only when AutoQuarantine
	// was on and QuarantineThreat returned an error for this threat.
	QuarantineFailed bool `json:"quarantineFailed,omitempty"`

	// #6263 W02 — rule-level detail for YARA hits (contract C3). Empty for
	// legacy signature hits, which keep the W01 shape plus SHA256.
	RuleName       string                   `json:"ruleName,omitempty"`
	RuleSetID      string                   `json:"ruleSetId,omitempty"`
	RuleID         string                   `json:"ruleId,omitempty"`
	Tags           []string                 `json:"tags,omitempty"`
	MatchedStrings []yarascan.MatchedString `json:"matchedStrings,omitempty"`
	// SHA256 of the file at scan time; empty when the file exceeds the
	// hashing cap (maxHashBytes) or could not be re-read.
	SHA256 string `json:"sha256,omitempty"`

	// autoQuarantine is the matching rule set's own opt-in (spec D7): a YARA
	// hit is auto-quarantined only when the policy AND its set allow it.
	autoQuarantine bool
	// hashFailed: the file matched but could not be hashed at scan time, so
	// its identity cannot be re-verified and it is never auto-quarantined.
	hashFailed bool
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

// The threat-signature table is stored XOR-obfuscated (see internal/obfuscate)
// and decoded lazily on first use. The signature names, filename patterns, and
// content patterns are well-known malware/test-file tokens; as plain Go
// literals they get compiled verbatim into the shipped binaries and AV engines
// then flag breeze-agent.exe / breeze-user-helper.exe (issue #2797, confirmed
// on VirusTotal). The entire table is encoded uniformly so
// reviewers don't have to judge which tokens are "distinctive enough". The CI
// guard scripts/security/check-agent-binary-signatures.sh checks built
// binaries for the plaintext tokens.
//
// Encoded literals were produced with the XOR-0x5A scheme documented in
// internal/obfuscate. Comments name only non-sensitive decoded values.
var (
	threatSignaturesOnce sync.Once
	threatSignaturesVal  []threatSignature
)

// threatSignatures returns the decoded default threat-signature table.
func threatSignatures() []threatSignature {
	threatSignaturesOnce.Do(func() {
		threatSignaturesVal = buildDefaultThreatSignatures()
	})
	return threatSignaturesVal
}

func buildDefaultThreatSignatures() []threatSignature {
	dec := obfuscate.Decode
	return []threatSignature{
		{
			// AV test-file signature (name + filename token + 68-byte content payload).
			Name:     dec([]byte{0x1f, 0x13, 0x19, 0x1b, 0x08, 0x77, 0x0e, 0x3f, 0x29, 0x2e, 0x77, 0x1c, 0x33, 0x36, 0x3f}),
			Type:     "malware",
			Severity: ThreatSeverityHigh,
			FilenamePatterns: []string{
				dec([]byte{0x3f, 0x33, 0x39, 0x3b, 0x28}),
			},
			ContentPattern: obfuscate.DecodeBytes([]byte{
				0x02, 0x6f, 0x15, 0x7b, 0x0a, 0x7f, 0x1a, 0x1b, 0x0a, 0x01, 0x6e, 0x06, 0x0a, 0x00, 0x02, 0x6f,
				0x6e, 0x72, 0x0a, 0x04, 0x73, 0x6d, 0x19, 0x19, 0x73, 0x6d, 0x27, 0x7e, 0x1f, 0x13, 0x19, 0x1b,
				0x08, 0x77, 0x09, 0x0e, 0x1b, 0x14, 0x1e, 0x1b, 0x08, 0x1e, 0x77, 0x1b, 0x14, 0x0e, 0x13, 0x0c,
				0x13, 0x08, 0x0f, 0x09, 0x77, 0x0e, 0x1f, 0x09, 0x0e, 0x77, 0x1c, 0x13, 0x16, 0x1f, 0x7b, 0x7e,
				0x12, 0x71, 0x12, 0x70,
			}),
		},
		{
			// Credential-dumping tool signature (name + two filename tokens).
			Name:     dec([]byte{0x17, 0x33, 0x37, 0x33, 0x31, 0x3b, 0x2e, 0x20}),
			Type:     "malware",
			Severity: ThreatSeverityHigh,
			FilenamePatterns: []string{
				dec([]byte{0x37, 0x33, 0x37, 0x33, 0x31, 0x3b, 0x2e, 0x20}),
				dec([]byte{0x29, 0x3f, 0x31, 0x2f, 0x28, 0x36, 0x29, 0x3b}),
			},
		},
		{
			// C2-framework beacon signature (name + tool token + "beacon").
			Name:     dec([]byte{0x19, 0x35, 0x38, 0x3b, 0x36, 0x2e, 0x09, 0x2e, 0x28, 0x33, 0x31, 0x3f, 0x77, 0x18, 0x3f, 0x3b, 0x39, 0x35, 0x34}),
			Type:     "malware",
			Severity: ThreatSeverityCritical,
			FilenamePatterns: []string{
				dec([]byte{0x39, 0x35, 0x38, 0x3b, 0x36, 0x2e, 0x29, 0x2e, 0x28, 0x33, 0x31, 0x3f}),
				dec([]byte{0x38, 0x3f, 0x3b, 0x39, 0x35, 0x34}), // "beacon"
			},
		},
		{
			// Banking-trojan family signature (name + two family tokens).
			Name:     dec([]byte{0x1f, 0x37, 0x35, 0x2e, 0x3f, 0x2e}),
			Type:     "trojan",
			Severity: ThreatSeverityCritical,
			FilenamePatterns: []string{
				dec([]byte{0x3f, 0x37, 0x35, 0x2e, 0x3f, 0x2e}),
				dec([]byte{0x2e, 0x28, 0x33, 0x39, 0x31, 0x38, 0x35, 0x2e}),
			},
		},
		{
			Name:     dec([]byte{0x08, 0x3b, 0x34, 0x29, 0x35, 0x37, 0x2d, 0x3b, 0x28, 0x3f, 0x77, 0x14, 0x35, 0x2e, 0x3f}), // "Ransomware-Note"
			Type:     "ransomware",
			Severity: ThreatSeverityHigh,
			FilenamePatterns: []string{
				dec([]byte{0x05, 0x28, 0x3f, 0x3b, 0x3e, 0x37, 0x3f}),                                           // "_readme"
				dec([]byte{0x32, 0x35, 0x2d, 0x05, 0x2e, 0x35, 0x05, 0x3e, 0x3f, 0x39, 0x28, 0x23, 0x2a, 0x2e}), // "how_to_decrypt"
				dec([]byte{0x28, 0x3f, 0x39, 0x35, 0x2c, 0x3f, 0x28}),                                           // "recover"
				dec([]byte{0x3e, 0x3f, 0x39, 0x28, 0x23, 0x2a, 0x2e}),                                           // "decrypt"
			},
		},
	}
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

// detectThreats keeps its signature for the existing callers and tests.
func detectThreats(paths []string, options threatScanOptions) ([]Threat, error) {
	threats, _, err := detectThreatsCtx(context.Background(), paths, options)
	return threats, err
}

// detectThreatsCtx is detectThreats with a deadline and a scanned-file counter.
// A cancelled context returns what was found so far plus ctx.Err(); callers
// decide whether that is a timeout (partial results, reported) or a real error.
//
// Since #6263 W02 it is the legacy signature table driven through the shared
// worker-pool walk (walkpool.go) with W01's exact semantics: one worker,
// every regular file offered (filename signatures ignore the size cap), and
// per-file errors joined into the returned error.
func detectThreatsCtx(ctx context.Context, paths []string, options threatScanOptions) ([]Threat, int, error) {
	res, err := walkAndMatch(ctx, paths, options, legacyMatcher{options: options}, legacyWalkConfig())
	return res.Threats, res.FilesScanned, err
}

// legacyMatcher adapts the XOR-obfuscated signature table to the
// yarascan.Matcher interface so both engines share one walk. Used whenever no
// rule set is usable (no ruleSets, all failed, or the YARA engine could not
// start).
type legacyMatcher struct{ options threatScanOptions }

func (legacyMatcher) Engine() string { return yarascan.EngineLegacy }
func (legacyMatcher) Close()         {}
func (l legacyMatcher) NewWorker() (yarascan.Worker, error) {
	return legacyWorker(l), nil
}

type legacyWorker legacyMatcher

func (legacyWorker) Close() {}

func (l legacyWorker) ScanFile(path string) ([]yarascan.Match, error) {
	// Lstat, as W01's walk used the DirEntry's own info: a path swapped for a
	// symlink after the walk saw it is not followed.
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, nil
	}
	found, err := scanFileForThreats(path, info, l.options)
	out := make([]yarascan.Match, 0, len(found))
	for _, th := range found {
		out = append(out, yarascan.Match{RuleName: th.Name, Severity: th.Severity, ThreatType: th.Type})
	}
	return out, err
}

// QuarantineThreat neutralizes a detected threat and moves it into the
// quarantine directory. See quarantine.go for the implementation (#6263 W01
// / spec D6) — this signature is kept exactly as callers (handlers_security.go)
// expect.

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
	for _, signature := range threatSignatures() {
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

	for _, signature := range threatSignatures() {
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
	defer func() {
		if closeErr := file.Close(); closeErr != nil {
			log.Warn("failed to close scanned file", "path", path, "error", closeErr.Error())
		}
	}()

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
	defer func() {
		if closeErr := in.Close(); closeErr != nil {
			log.Warn("failed to close copyFile source", "path", src, "error", closeErr.Error())
		}
	}()

	info, err := in.Stat()
	if err != nil {
		return err
	}

	out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode())
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := out.Close(); closeErr != nil {
			log.Warn("failed to close copyFile destination", "path", dest, "error", closeErr.Error())
		}
	}()

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
