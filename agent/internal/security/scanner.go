package security

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/yarascan"
)

var log = logging.L("security")

// SecurityScanner coordinates security scans on the local system.
type SecurityScanner struct {
	QuarantineDir string
	MaxFileSize   int64
	MaxReadBytes  int64
	Config        *config.Config

	// #6263 W01 — delivered per scan in the command payload, resolved from the
	// device's effective security config policy. Zero values mean "agent
	// defaults", which is what an unmanaged device gets.
	Exclusions     []string
	Timeout        time.Duration
	AutoQuarantine bool

	// #6263 W02 — the YARA engine for this scan, built by the handler from
	// the payload's ruleSets. nil ⇒ the legacy signature table (W01).
	Matcher yarascan.Matcher
	// RuleCacheDir overrides the compiled-rules cache location (tests);
	// empty ⇒ <data dir>/yara/cache.
	RuleCacheDir string
}

// ScanResult captures the output of a security scan.
type ScanResult struct {
	Threats  []Threat       `json:"threats"`
	Status   SecurityStatus `json:"status"`
	Duration time.Duration  `json:"duration"`
}

// ScanOutcome is the richer result of ScanWithContext: everything ScanResult
// carries, plus how much of the scan actually completed.
type ScanOutcome struct {
	Threats      []Threat
	Status       SecurityStatus
	Duration     time.Duration
	FilesScanned int
	TimedOut     bool
	Partial      bool

	// #6263 W02. Engine is the matcher that actually ran ("yara" or
	// "legacy"). EngineError is set when a YARA matcher was supplied but
	// could not start, so the scan fell back to the legacy signatures — the
	// caller reports that as a degraded run, never as a clean YARA scan.
	Engine      string
	EngineError string
	// FilesFailed counts files the YARA walk could not read (locked,
	// vanished, engine timeout). Always 0 for the legacy engine, whose
	// per-file errors keep W01 semantics (they fail the scan).
	FilesFailed int
}

// QuickScan performs a fast scan of common threat locations.
func (s *SecurityScanner) QuickScan() (ScanResult, error) {
	outcome, err := s.ScanWithContext(context.Background(), "quick", nil)
	return outcome.toScanResult(), err
}

// FullScan performs a comprehensive scan of system locations.
func (s *SecurityScanner) FullScan() (ScanResult, error) {
	outcome, err := s.ScanWithContext(context.Background(), "full", nil)
	return outcome.toScanResult(), err
}

// CustomScan scans the provided paths.
func (s *SecurityScanner) CustomScan(paths []string) (ScanResult, error) {
	outcome, err := s.ScanWithContext(context.Background(), "custom", paths)
	return outcome.toScanResult(), err
}

func (o ScanOutcome) toScanResult() ScanResult {
	return ScanResult{
		Threats:  o.Threats,
		Status:   o.Status,
		Duration: o.Duration,
	}
}

// ScanWithContext runs a scan honouring the scanner's Exclusions, MaxFileSize
// and Timeout. A deadline is reported as an outcome (TimedOut/Partial with
// the threats found so far), never as an error — see DECISION 4 in the W01
// plan: a 2-hour full scan that hits its deadline has usually done useful
// work, and discarding it would make the timeout setting user-hostile.
func (s *SecurityScanner) ScanWithContext(ctx context.Context, scanType string, paths []string) (ScanOutcome, error) {
	var targets []string
	switch strings.ToLower(scanType) {
	case "quick":
		targets = defaultQuickPaths()
	case "full":
		targets = defaultFullPaths()
	case "custom":
		if len(paths) == 0 {
			return ScanOutcome{}, fmt.Errorf("custom scan requires one or more paths")
		}
		targets = filterExistingPaths(paths)
	default:
		return ScanOutcome{}, fmt.Errorf("unsupported scanType: %s", scanType)
	}

	options := defaultThreatScanOptions()
	if s.MaxFileSize > 0 {
		options.MaxFileSize = s.MaxFileSize
	}
	if s.MaxReadBytes > 0 {
		options.MaxReadBytes = s.MaxReadBytes
	}
	if dir := s.quarantineDir(); dir != "" {
		options.ExcludePaths = append(options.ExcludePaths, dir)
	}
	// Caller exclusions are ADDITIVE to the agent's built-ins: a policy may
	// widen the skip set, never narrow it. /proc, /sys and the Defender
	// quarantine stay excluded whatever the policy says.
	options.ExcludePaths = append(options.ExcludePaths, s.Exclusions...)

	scanCtx := ctx
	cancel := func() {}
	if s.Timeout > 0 {
		scanCtx, cancel = context.WithTimeout(ctx, s.Timeout)
	}
	defer cancel()

	started := time.Now()
	engine := yarascan.EngineLegacy
	engineErr := ""
	var res walkResult
	var scanErr error
	if s.Matcher != nil {
		engine = s.Matcher.Engine()
		res, scanErr = walkAndMatch(scanCtx, targets, options, s.Matcher, yaraWalkConfig())
		if errors.Is(scanErr, ErrNoScanWorkers) {
			// Fallback = the legacy signatures, recorded as a degraded run.
			log.Warn("IOC scan engine could not start; scanning with built-in signatures", "error", scanErr.Error())
			engine, engineErr = yarascan.EngineLegacy, scanErr.Error()
			res.Threats, res.FilesScanned, scanErr = detectThreatsCtx(scanCtx, targets, options)
			res.FilesFailed = 0
		}
	} else {
		res.Threats, res.FilesScanned, scanErr = detectThreatsCtx(scanCtx, targets, options)
	}
	threats, filesScanned := res.Threats, res.FilesScanned
	timedOut := errors.Is(scanErr, context.DeadlineExceeded) || errors.Is(scanErr, context.Canceled)
	if timedOut {
		scanErr = nil // a deadline is an outcome, reported through TimedOut
	}

	if s.AutoQuarantine && len(threats) > 0 {
		s.autoQuarantine(threats)
	}

	status, statusErr := CollectStatus(s.Config)
	if statusErr != nil {
		// A posture probe (e.g. firewall status on a host with no known
		// firewall tool) failing to resolve is not a scan failure — the same
		// tolerance handleSecurityCollectStatus already applies. Folding it
		// into the returned error would discard real threat results the scan
		// DID find, on hosts as ordinary as a minimal Linux box or a CI
		// container with no ufw/firewalld/systemctl.
		log.Warn("scan completed but posture status collection was incomplete", "error", statusErr.Error())
	}
	status.ThreatCount = len(threats)
	status.LastScanAt = time.Now().UTC().Format(time.RFC3339)
	status.LastScanType = strings.ToLower(scanType)

	return ScanOutcome{
		Threats:      threats,
		Status:       status,
		Duration:     time.Since(started),
		FilesScanned: filesScanned,
		TimedOut:     timedOut,
		Partial:      timedOut,
		Engine:       engine,
		EngineError:  engineErr,
		FilesFailed:  res.FilesFailed,
	}, scanErr
}

// autoQuarantine applies the policy's auto-quarantine to threats in place:
//   - spec D7: a YARA hit (RuleSetID set) is quarantined only when its own
//     rule set opted in as well; legacy hits follow the policy flag alone (W01);
//   - each FILE is quarantined once even when several rules matched it, and
//     every threat on that file reports the same outcome (a per-threat loop
//     would report the second threat as failed because the file is gone);
//   - the file's identity is re-verified against the scan-time sha256 first:
//     a file that changed since it was scanned is not moved.
//
// A file that could not be quarantined is still a real detection: it is
// reported with QuarantineFailed so the server can tell "quarantined", "not
// attempted" and "attempted and failed" apart.
func (s *SecurityScanner) autoQuarantine(threats []Threat) {
	dir := s.quarantineDir()
	done := map[string]string{} // path -> quarantinedTo ("" = attempted and failed)
	for i := range threats {
		th := &threats[i]
		if th.RuleSetID != "" && !th.autoQuarantine {
			continue
		}
		if dest, seen := done[th.Path]; seen {
			th.QuarantinedTo, th.QuarantineFailed = dest, dest == ""
			continue
		}
		if th.SHA256 != "" && fileSHA256(th.Path) != th.SHA256 {
			log.Warn("skipping auto-quarantine: file changed since it was scanned", "path", th.Path, "name", th.Name)
			done[th.Path], th.QuarantineFailed = "", true
			continue
		}
		dest, qErr := QuarantineThreat(*th, dir)
		if qErr != nil {
			log.Warn("auto-quarantine failed", "path", th.Path, "name", th.Name, "error", qErr.Error())
			done[th.Path], th.QuarantineFailed = "", true
			continue
		}
		done[th.Path], th.QuarantinedTo = dest, dest
	}
}

// RuleCacheDirOrDefault is where compiled YARA rules are cached.
func (s *SecurityScanner) RuleCacheDirOrDefault() string {
	if s.RuleCacheDir != "" {
		return s.RuleCacheDir
	}
	return filepath.Join(config.GetDataDir(), "yara", "cache")
}

func (s *SecurityScanner) quarantineDir() string {
	if s.QuarantineDir != "" {
		return s.QuarantineDir
	}

	return DefaultQuarantineDir()
}

// DefaultQuarantineDir returns the default quarantine path for this host.
func DefaultQuarantineDir() string {
	base := defaultDataDir()
	if base != "" {
		return filepath.Join(base, "quarantine")
	}

	return filepath.Join(os.TempDir(), "breeze-quarantine")
}

func defaultQuickPaths() []string {
	paths := []string{os.TempDir()}
	home, _ := os.UserHomeDir()

	switch runtime.GOOS {
	case "windows":
		systemDrive := os.Getenv("SystemDrive")
		if systemDrive != "" {
			paths = append(paths, filepath.Join(systemDrive, "Windows", "Temp"))
		}
		if home != "" {
			paths = append(paths,
				filepath.Join(home, "Downloads"),
				filepath.Join(home, "AppData", "Local", "Temp"),
				filepath.Join(home, "AppData", "Roaming"),
			)
		}
		if programData := os.Getenv("ProgramData"); programData != "" {
			paths = append(paths, programData)
		}
	case "darwin":
		if home != "" {
			paths = append(paths,
				filepath.Join(home, "Downloads"),
				filepath.Join(home, "Library", "LaunchAgents"),
				filepath.Join(home, "Library", "Application Support"),
			)
		}
		paths = append(paths, "/Library/LaunchDaemons", "/Library/LaunchAgents")
	default:
		if home != "" {
			paths = append(paths,
				filepath.Join(home, "Downloads"),
				filepath.Join(home, ".config", "autostart"),
			)
		}
		paths = append(paths,
			"/tmp",
			"/var/tmp",
			"/etc/cron.d",
			"/etc/cron.daily",
			"/etc/cron.hourly",
			"/etc/cron.weekly",
			"/etc/cron.monthly",
		)
	}

	return filterExistingPaths(paths)
}

func defaultFullPaths() []string {
	paths := []string{}
	home, _ := os.UserHomeDir()

	switch runtime.GOOS {
	case "windows":
		systemDrive := os.Getenv("SystemDrive")
		if systemDrive != "" {
			root := systemDrive
			if !strings.HasSuffix(root, string(os.PathSeparator)) {
				root += string(os.PathSeparator)
			}
			paths = append(paths, root)
		}
		if home != "" {
			paths = append(paths, home)
		}
		if programData := os.Getenv("ProgramData"); programData != "" {
			paths = append(paths, programData)
		}
	case "darwin":
		paths = append(paths, "/Applications", "/Library", "/Users")
	default:
		paths = append(paths, "/", "/home", "/opt", "/usr", "/var", "/etc")
	}

	return filterExistingPaths(paths)
}

func filterExistingPaths(paths []string) []string {
	seen := make(map[string]struct{}, len(paths))
	var filtered []string
	for _, path := range paths {
		path = filepath.Clean(path)
		if path == "." || path == "" {
			continue
		}
		key := strings.ToLower(path)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		if _, err := os.Stat(path); err == nil {
			filtered = append(filtered, path)
		}
	}
	return filtered
}
