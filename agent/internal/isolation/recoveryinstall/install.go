// Package recoveryinstall stages independently runnable recovery executables.
// It has no dependency on the agent configuration, heartbeat, or updater stack.
package recoveryinstall

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
	"github.com/breeze-rmm/agent/internal/serviceinstall"
)

var ErrUnavailable = errors.New("recovery distribution is not available")
var versionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?(?:\+[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$`)

// Task identifies a recovery task to create or update. Repoint must change and read back
// exactly this task; a partial failure leaves every other task's action intact.
type Task struct{ Name, Path string }

// Installer's trusted adapters are deliberately injected. Fetch must verify the
// updater component's signed manifest before writing bytes; VerifySignature
// additionally checks Authenticode. SelfTest must honor its bounded context.
// InstallDir is the directory of serviceinstall.ProtectedBinaryPath(agent).
// Tasks returns the desired Breeze recovery task plan, including the poll task
// on a raw-swap install with no pre-existing recovery tasks. Repoint creates or
// updates each task and confirms it by read-back. Both adapters are trusted.
// SupportedSchema runs the verified executable with --journal-schema.
type Installer struct {
	InstallDir, DataDir string
	Fetch               func(context.Context, string, io.Writer) error
	VerifySignature     func(string) error
	SupportedSchema     func(context.Context, string) (int, error)
	SelfTest            func(context.Context, string) error
	Tasks               func() ([]Task, error)
	Repoint             func(Task, string) error
}

// EnsureRecovery intentionally has no production download source in W1g. The
// distribution/signing activation PR must wire an Installer with trusted adapters.
// Even a pre-existing executable is insufficient to bypass this gate.
func EnsureRecovery(ctx context.Context, wantVersion string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return "", ErrUnavailable
}

func (i *Installer) EnsureRecovery(ctx context.Context, wantVersion string) (string, error) {
	if len(wantVersion) > 128 || !versionPattern.MatchString(wantVersion) || strings.Contains(wantVersion, "..") {
		return "", errors.New("invalid recovery version")
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if i.Fetch == nil || i.VerifySignature == nil || i.SupportedSchema == nil || i.SelfTest == nil || i.Tasks == nil || i.Repoint == nil || !filepath.IsAbs(i.InstallDir) || !filepath.IsAbs(i.DataDir) {
		return "", errors.New("incomplete recovery installer dependencies")
	}
	path := filepath.Join(i.InstallDir, "isolation-recovery", wantVersion, "breeze-isolation-recovery.exe")
	if err := i.stage(ctx, wantVersion, path); err != nil {
		return "", err
	}
	unlock, err := journal.Lock(i.DataDir)
	if err != nil {
		return "", err
	}
	defer unlock()
	if err := ctx.Err(); err != nil {
		return "", err
	}
	j, err := journal.Load(journal.Path(i.DataDir))
	if errors.Is(err, journal.ErrNotFound) {
		j = journal.New()
	} else if err != nil {
		return "", err
	}
	if unresolved(j) {
		// Stage the new version, but retain all existing actions and the episode's
		// path. Never delete old executables: process references cannot be proven.
		if err := i.check(ctx, j.RecoveryPath); err != nil {
			return "", fmt.Errorf("pinned recovery: %w", err)
		}
		return j.RecoveryPath, nil
	}
	tasks, err := i.Tasks()
	if err != nil {
		return "", err
	}
	for _, task := range tasks {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		if err := regularFile(path); err != nil {
			return "", err
		}
		if err := i.Repoint(task, path); err != nil {
			return "", fmt.Errorf("repoint recovery task %s: %w", task.Name, err)
		}
	}
	j.RecoveryPath = path
	if err := journal.Save(journal.Path(i.DataDir), j); err != nil {
		return "", err
	}
	return path, nil
}

func unresolved(j *journal.Journal) bool {
	switch j.Phase {
	case journal.PhaseProvisional, journal.PhaseCommitted, journal.PhaseReleasing:
		return true
	}
	if j.Episode != nil && (j.Episode.State == "released_locally" || j.Episode.State == "self_released") {
		return true
	}
	return j.PendingReport != nil && (j.PendingReport.State == "released_locally" || j.PendingReport.State == "self_released")
}

func regularFile(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("recovery path is not a regular file")
	}
	return nil
}

func (i *Installer) check(ctx context.Context, path string) error {
	if err := regularFile(path); err != nil {
		return err
	}
	if err := i.VerifySignature(path); err != nil {
		return fmt.Errorf("verify recovery signature: %w", err)
	}
	schemaCtx, schemaCancel := context.WithTimeout(ctx, 10*time.Second)
	schema, schemaErr := i.SupportedSchema(schemaCtx, path)
	schemaContextErr := schemaCtx.Err()
	schemaCancel()
	if err := errors.Join(schemaErr, schemaContextErr); err != nil {
		return fmt.Errorf("query recovery journal schema: %w", err)
	}
	if schema != journal.SchemaVersion {
		return fmt.Errorf("incompatible recovery journal schema: %d", schema)
	}
	testCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := i.SelfTest(testCtx, path); err != nil {
		return fmt.Errorf("recovery self-test: %w", err)
	}
	return testCtx.Err()
}

func (i *Installer) stage(ctx context.Context, version, path string) error {
	if err := regularFile(path); err == nil {
		return i.check(ctx, path)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	// Files inherit the protected service directory ACL, then are explicitly
	// hardened before any untrusted downloaded content is executed.
	tmp, err := os.CreateTemp(dir, ".recovery-*.exe")
	if err != nil {
		return err
	}
	name := tmp.Name()
	// After a successful publication the temporary name no longer exists
	// (MoveFileEx) or is a second link to the published file (os.Link), so a
	// failed removal is only a stray temp file, never a correctness problem.
	defer func() { _ = os.Remove(name) }()
	if err := serviceinstall.HardenProtectedBinaryACL(name); err != nil {
		_ = tmp.Close()
		return err
	}
	fetchErr := i.Fetch(ctx, version, tmp)
	syncErr := tmp.Sync()
	closeErr := tmp.Close()
	if err := errors.Join(fetchErr, syncErr, closeErr); err != nil {
		return err
	}
	if err := os.Chmod(name, 0700); err != nil {
		return err
	}
	if err := i.check(ctx, name); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := publishExclusive(name, path); err != nil {
		// A competing installer may have published the identical verified bytes.
		// Different content at the same version is never overwritten or adopted.
		old, readErr := os.ReadFile(path)
		staged, stageErr := os.ReadFile(name)
		if readErr != nil || stageErr != nil || !bytes.Equal(old, staged) {
			return fmt.Errorf("publish recovery without replacing existing file: %w", err)
		}
		return i.check(ctx, path)
	}
	return nil
}
