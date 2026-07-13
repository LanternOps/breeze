package workspaceindex

import (
	"context"
	"errors"
	"fmt"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/time/rate"
)

type profileCrawlTarget struct {
	prefix string
	dir    string
}

// runCrawl executes one server run from start through terminal completion.
// An uploader is deliberately single-use: any Add or Drain failure abandons
// it and fails the run immediately.
func runCrawl(ctx context.Context, deps Deps, src SourceConfig, limits ConfigLimits) error {
	deps = deps.withDefaults()
	if deps.Client == nil {
		return errors.New("workspace index client is required")
	}

	run, err := deps.Client.StartRun(ctx, src.ID)
	if errors.Is(err, ErrRunConflict) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("start crawl run: %w", err)
	}
	if run == nil || run.RunID == "" {
		return errors.New("start crawl run returned no run ID")
	}

	stats := Stats{}
	fail := func(cause error) error {
		stats.Errors++
		// Reconciliation may cancel the crawl context. Completion is still a
		// best-effort terminal notification, so retain values but not cancellation.
		_ = deps.Client.CompleteRun(context.WithoutCancel(ctx), run.RunID, false, stats, cause.Error())
		return cause
	}

	uploader := NewUploader(deps.Client, run.RunID, limits)
	resumeCursor := ""
	if src.ActiveRun != nil && src.ActiveRun.RunID == run.RunID {
		resumeCursor = src.ActiveRun.Cursor
	}
	limiter := crawlRateLimiter(limits.WalkOpsPerSecond)
	emit := func(entry Entry) error {
		if err := uploader.Add(ctx, entry); err != nil {
			return err
		}
		stats.Seen++
		return nil
	}

	switch src.Kind {
	case "smb_share":
		cred, fetchErr := deps.Client.FetchCredential(ctx, src.ID)
		if fetchErr != nil {
			return fail(fmt.Errorf("fetch SMB credential: %w", fetchErr))
		}
		if cred == nil {
			return fail(errors.New("fetch SMB credential returned no credential"))
		}
		defer cred.Zero()

		fsys, closer, dialErr := deps.DialSMB(ctx, src.RootPath, cred)
		if dialErr != nil {
			safeErr := redactCredentialError(dialErr, cred)
			cred.Zero()
			return fail(safeErr)
		}
		redactionCred := *cred
		defer redactionCred.Zero()
		cred.Zero()
		if fsys == nil {
			if closer != nil {
				_ = closer.Close()
			}
			return fail(errors.New("dial SMB returned no filesystem"))
		}
		if closer != nil {
			defer closer.Close()
		}
		if _, walkErr := Walk(ctx, fsys, ".", WalkOptions{
			ExcludeGlobs: src.ExcludeGlobs,
			ResumeCursor: resumeCursor,
			Limiter:      limiter,
		}, emit); walkErr != nil {
			safeErr := redactCredentialError(fmt.Errorf("walk SMB source: %w", walkErr), &redactionCred)
			return fail(safeErr)
		}

	case "local_profile":
		// Each sub-walk operates in its directory-local cursor space. Prefixing
		// before Add composes those spaces into one globally ordered cursor space:
		// <username>/<folder>/<sub-walk relPath>.
		for _, target := range localProfileTargets(deps, src) {
			localResume, shouldWalk := targetResumeCursor(resumeCursor, target.prefix)
			if !shouldWalk {
				continue
			}
			_, walkErr := Walk(ctx, NewLocalFS(target.dir), ".", WalkOptions{
				ExcludeGlobs: src.ExcludeGlobs,
				ResumeCursor: localResume,
				Limiter:      limiter,
			}, func(entry Entry) error {
				entry.RelPath = path.Join(target.prefix, entry.RelPath)
				if entry.ParentPath == "" {
					entry.ParentPath = target.prefix
				} else {
					entry.ParentPath = path.Join(target.prefix, entry.ParentPath)
				}
				return emit(entry)
			})
			if walkErr != nil {
				return fail(fmt.Errorf("walk local profile %s: %w", target.prefix, walkErr))
			}
		}

	default:
		return fail(fmt.Errorf("unsupported workspace index source kind %q", src.Kind))
	}

	if err := uploader.Drain(ctx); err != nil {
		return fail(fmt.Errorf("drain crawl uploader: %w", err))
	}
	if err := deps.Client.CompleteRun(ctx, run.RunID, true, stats, ""); err != nil {
		return fail(fmt.Errorf("complete crawl run: %w", err))
	}
	return nil
}

const (
	// defaultWalkOpsPerSecond caps filesystem walk operations when the server
	// config omits walkOpsPerSecond (the Go zero value on a partially
	// populated crawl-config response) or sends an invalid value. A missing
	// field must never silently remove IO throttling on a local/SMB walk
	// (#2425).
	defaultWalkOpsPerSecond = 200
	// walkOpsUnlimited is the explicit server sentinel that disables walk
	// throttling entirely. Only this exact value runs unthrottled.
	walkOpsUnlimited = -1
)

func crawlRateLimiter(opsPerSecond int) *rate.Limiter {
	if opsPerSecond == walkOpsUnlimited {
		return nil
	}
	if opsPerSecond <= 0 {
		opsPerSecond = defaultWalkOpsPerSecond
	}
	return rate.NewLimiter(rate.Limit(opsPerSecond), opsPerSecond)
}

func localProfileTargets(deps Deps, src SourceConfig) []profileCrawlTarget {
	var profiles []ProfileRoot
	if deps.Enumerate != nil {
		profiles = deps.Enumerate()
	} else {
		profiles = EnumerateProfileRoots(src.RootPath)
	}

	targets := make([]profileCrawlTarget, 0, len(profiles)*len(standardProfileCrawlDirs))
	for _, profile := range profiles {
		for _, dir := range ProfileCrawlDirs(profile) {
			targets = append(targets, profileCrawlTarget{
				prefix: path.Join(profile.Username, filepath.Base(dir)),
				dir:    dir,
			})
		}
	}
	sort.Slice(targets, func(i, j int) bool {
		return compareWalkPaths(targets[i].prefix, targets[j].prefix) < 0
	})
	return targets
}

func targetResumeCursor(globalCursor, prefix string) (string, bool) {
	if globalCursor == "" || globalCursor == prefix {
		return "", true
	}
	if strings.HasPrefix(globalCursor, prefix+"/") {
		return strings.TrimPrefix(globalCursor, prefix+"/"), true
	}
	if compareWalkPaths(prefix, globalCursor) > 0 {
		return "", true
	}
	return "", false
}

type credentialSafeError struct {
	message string
}

func (e *credentialSafeError) Error() string { return e.message }

func redactCredentialError(err error, cred *Credential) error {
	if err == nil {
		return nil
	}
	message := err.Error()
	if cred != nil {
		values := []string{cred.Password, cred.Username}
		if cred.Domain != nil {
			values = append(values, *cred.Domain)
		}
		for _, value := range values {
			if value != "" {
				message = strings.ReplaceAll(message, value, "[REDACTED]")
			}
		}
	}
	return &credentialSafeError{message: message}
}
