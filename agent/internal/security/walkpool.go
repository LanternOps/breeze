package security

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"sync"

	"github.com/breeze-rmm/agent/internal/yarascan"
)

// maxHashBytes: files larger than this get Threat.SHA256 == "".
const maxHashBytes = 256 << 20

// maxLoggedFileErrors bounds per-file error log lines for one scan; the rest
// are only counted (ScanOutcome.FilesFailed).
const maxLoggedFileErrors = 20

// ErrNoScanWorkers is returned by walkAndMatch when not one worker could
// start its matcher (e.g. the YARA engine failed to instantiate). Callers
// fall back to the legacy matcher rather than reporting a clean scan.
var ErrNoScanWorkers = errors.New("no IOC scan worker could start")

func defaultScanWorkers() int {
	n := runtime.NumCPU() / 2
	if n < 1 {
		n = 1
	}
	if n > 4 {
		n = 4
	}
	return n
}

// walkConfig captures how the two engines differ in one walk.
type walkConfig struct {
	Workers int
	// SkipOversized drops files above options.MaxFileSize before they reach
	// the matcher (they are not counted as scanned). The legacy matcher
	// applies the size cap itself, to content only — filename signatures
	// still match on big files — so it must see every file.
	SkipOversized bool
	// FileErrorsFatal joins per-file and per-directory errors into the
	// returned error, as W01's single-goroutine walk did. With it off, such
	// errors are counted in walkResult.FilesFailed and a sample is logged,
	// and the scan completes with what it could read — one locked or
	// vanished file must not discard a whole scan's detections.
	FileErrorsFatal bool
	// Background lowers each worker's OS-thread priority (DECISION W02-c).
	Background bool
}

func legacyWalkConfig() walkConfig { return walkConfig{Workers: 1, FileErrorsFatal: true} }

func yaraWalkConfig() walkConfig {
	return walkConfig{Workers: defaultScanWorkers(), SkipOversized: true, Background: true}
}

type walkResult struct {
	Threats      []Threat
	FilesScanned int
	FilesFailed  int
}

type fileJob struct {
	path string
	size int64
}

// errCollector is the one place walk/scan errors go; it applies the
// FileErrorsFatal policy.
type errCollector struct {
	mu     sync.Mutex
	fatal  bool
	errs   []error
	failed int
	logged int
}

func (c *errCollector) file(path string, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.fatal {
		c.errs = append(c.errs, err)
		return
	}
	c.failed++
	if c.logged < maxLoggedFileErrors {
		c.logged++
		log.Debug("IOC scan could not read a file", "path", path, "error", err.Error())
	}
}

// always records an error that is fatal regardless of policy.
func (c *errCollector) always(err error) {
	c.mu.Lock()
	c.errs = append(c.errs, err)
	c.mu.Unlock()
}

// walkAndMatch walks paths with one producer and cfg.Workers goroutines that
// each own one matcher Worker (one wasm instance) for the whole scan. A
// cancelled ctx returns what was found so far plus ctx.Err().
func walkAndMatch(ctx context.Context, paths []string, options threatScanOptions, m yarascan.Matcher, cfg walkConfig) (walkResult, error) {
	if cfg.Workers < 1 {
		cfg.Workers = 1
	}
	// workCtx is also cancelled when every worker has failed to start, so
	// the producer never blocks on a channel nobody reads.
	workCtx, cancelWork := context.WithCancel(ctx)
	defer cancelWork()

	jobs := make(chan fileJob, cfg.Workers*4)
	ec := &errCollector{fatal: cfg.FileErrorsFatal}
	var (
		mu       sync.Mutex
		threats  []Threat
		seen     = map[string]struct{}{}
		scanned  int
		alive    = cfg.Workers
		initErrs []error
	)

	var wg sync.WaitGroup
	for i := 0; i < cfg.Workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if cfg.Background {
				// Never unlocked: the runtime retires this thread with the
				// goroutine, so the lowered priority never leaks (W02-c).
				runtime.LockOSThread()
				yarascan.EnterBackgroundThread()
			}
			w, err := m.NewWorker()
			if err != nil {
				mu.Lock()
				initErrs = append(initErrs, err)
				alive--
				if alive == 0 {
					cancelWork()
				}
				mu.Unlock()
				return // do NOT drain: healthy workers own the remaining jobs
			}
			defer w.Close()
			for job := range jobs {
				if workCtx.Err() != nil {
					continue // drain without scanning so the producer unblocks
				}
				matches, err := w.ScanFile(job.path)
				mu.Lock()
				scanned++
				mu.Unlock()
				if err != nil {
					// W01 (fatal mode) skips permission-denied files silently;
					// the non-fatal mode counts every unreadable file.
					if !cfg.FileErrorsFatal || !os.IsPermission(err) {
						ec.file(job.path, err)
					}
					continue
				}
				if len(matches) == 0 {
					continue
				}
				sum := ""
				if job.size <= maxHashBytes {
					sum = fileSHA256(job.path)
				}
				mu.Lock()
				for _, mt := range matches {
					key := mt.RuleSetID + "|" + mt.RuleName + "|" + job.path
					if _, dup := seen[key]; dup {
						continue
					}
					seen[key] = struct{}{}
					threats = append(threats, threatFromMatch(mt, job.path, sum))
				}
				mu.Unlock()
			}
		}()
	}

	walkErr := produce(workCtx, uniquePaths(paths), options, cfg, jobs, ec)
	close(jobs)
	wg.Wait()

	if len(initErrs) == cfg.Workers {
		return walkResult{}, fmt.Errorf("%w: %w", ErrNoScanWorkers, errors.Join(initErrs...))
	}
	for _, err := range initErrs {
		log.Warn("IOC scan worker failed to start; continuing with fewer workers", "error", err.Error())
	}
	if walkErr != nil {
		// Report the caller's own deadline/cancel, not workCtx's.
		if ctx.Err() != nil {
			walkErr = ctx.Err()
		}
		ec.always(walkErr)
	}
	if cfg.Workers > 1 {
		// Worker interleaving is nondeterministic; keep results stable.
		sort.SliceStable(threats, func(i, j int) bool {
			a, b := threats[i], threats[j]
			if a.Path != b.Path {
				return a.Path < b.Path
			}
			if a.RuleSetID != b.RuleSetID {
				return a.RuleSetID < b.RuleSetID
			}
			return a.Name < b.Name
		})
	}
	return walkResult{Threats: threats, FilesScanned: scanned, FilesFailed: ec.failed}, errors.Join(ec.errs...)
}

func threatFromMatch(mt yarascan.Match, path, sum string) Threat {
	t := Threat{
		Name: mt.RuleName, Type: mt.ThreatType, Severity: mt.Severity, Path: path,
		RuleSetID: mt.RuleSetID, SHA256: sum,
	}
	if mt.RuleSetID != "" {
		// YARA hit: rule-level detail (C3). Legacy signature hits keep the
		// W01 shape (name/type/severity/path) plus sha256.
		t.RuleName, t.RuleID = mt.RuleName, mt.RuleID
		t.Tags, t.MatchedStrings = mt.Tags, mt.Strings
		t.autoQuarantine = mt.AutoQuarantine
	}
	return t
}

func fileSHA256(p string) string {
	f, err := os.Open(p)
	if err != nil {
		return ""
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(f, maxHashBytes+1))
	if err != nil || n > maxHashBytes {
		return ""
	}
	return hex.EncodeToString(h.Sum(nil))
}

// produce walks roots and feeds regular files to jobs. The walk rules are
// W01's detectThreatsCtx verbatim: os.Lstat on roots, symlinks never
// followed, permission-denied directories skipped, exclusions by
// isExcludedPath, regular files only.
func produce(ctx context.Context, roots []string, options threatScanOptions, cfg walkConfig, jobs chan<- fileJob, ec *errCollector) error {
	send := func(p string, size int64) error {
		if cfg.SkipOversized && options.MaxFileSize > 0 && size > options.MaxFileSize {
			return nil
		}
		select {
		case jobs <- fileJob{path: p, size: size}:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	for _, root := range roots {
		if err := ctx.Err(); err != nil {
			return err
		}
		if root == "" || isExcludedPath(root, options.ExcludePaths) {
			continue
		}
		info, err := os.Lstat(root)
		if err != nil {
			if !os.IsNotExist(err) {
				ec.file(root, err)
			}
			continue
		}
		if info.Mode()&os.ModeSymlink != 0 {
			continue
		}
		if !info.IsDir() {
			if info.Mode().IsRegular() {
				if err := send(root, info.Size()); err != nil {
					return err
				}
			}
			continue
		}
		err = filepath.WalkDir(root, func(cur string, d fs.DirEntry, werr error) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			if werr != nil {
				if os.IsPermission(werr) {
					return fs.SkipDir
				}
				ec.file(cur, werr)
				return nil
			}
			if isExcludedPath(cur, options.ExcludePaths) {
				if d.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
			if d.Type()&os.ModeSymlink != 0 || d.IsDir() {
				return nil
			}
			fi, err := d.Info()
			if err != nil {
				if !os.IsPermission(err) {
					ec.file(cur, err)
				}
				return nil
			}
			if !fi.Mode().IsRegular() {
				return nil
			}
			return send(cur, fi.Size())
		})
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		if err != nil && !os.IsPermission(err) {
			ec.file(root, err)
		}
	}
	return nil
}

// WalkOptions configures WalkAndMatch.
type WalkOptions struct {
	Workers     int   // <1 ⇒ the agent default
	MaxFileSize int64 // bytes; <=0 ⇒ the agent default (25 MiB)
	Exclusions  []string
}

// WalkResult is WalkAndMatch's outcome.
type WalkResult struct {
	Threats      []Threat
	FilesScanned int
	FilesFailed  int
}

// WalkAndMatch runs the agent's YARA-mode walk (same exclusions, size cap,
// per-file error policy and background-priority workers) with an arbitrary
// matcher. It exists for cmd/breeze-yarac's benchmark so the lab numbers
// measure the code the agent ships, not a copy of it.
func WalkAndMatch(ctx context.Context, paths []string, m yarascan.Matcher, o WalkOptions) (WalkResult, error) {
	options := defaultThreatScanOptions()
	if o.MaxFileSize > 0 {
		options.MaxFileSize = o.MaxFileSize
	}
	options.ExcludePaths = append(options.ExcludePaths, o.Exclusions...)
	cfg := yaraWalkConfig()
	if o.Workers > 0 {
		cfg.Workers = o.Workers
	}
	res, err := walkAndMatch(ctx, paths, options, m, cfg)
	return WalkResult(res), err
}
