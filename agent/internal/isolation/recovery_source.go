package isolation

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/breeze-rmm/agent/internal/isolation/recoveryinstall"
)

// RecoverySource supplies the trusted download adapters for the recovery
// executable. The agent wires both to the updater's isolation-recovery
// component, so the signed release manifest gates every byte:
//   - Fetch writes the executable for version only after the updater has
//     verified the manifest signature and the downloaded SHA-256 against it.
//   - FetchEnvelope returns the signed manifest envelope as served for that
//     version, already signature-verified. Trust Path B still re-verifies the
//     persisted copy on every check; this only places it.
//
// The isolation packages never import the updater (deps_test.go), so the
// adapters are injected.
type RecoverySource struct {
	Fetch         func(ctx context.Context, version string, w io.Writer) error
	FetchEnvelope func(ctx context.Context, version string) (recoveryinstall.ManifestEnvelope, error)
}

// ConfigureRecoverySource gives a scheduler that can install recovery (the
// Windows Task Scheduler) its download adapters. Other schedulers ignore it and
// keep recoveryinstall.EnsureRecovery's fail-closed stub. Call it at agent
// startup, after ConfigureRecoveryManifestTrust and before readiness is
// configured.
func ConfigureRecoverySource(s RecoveryScheduler, src RecoverySource) {
	if c, ok := s.(interface{ configureRecoverySource(RecoverySource) }); ok {
		c.configureRecoverySource(src)
	}
}

// recoveryEnsure is the readiness probe's EnsureRecovery for wantVersion: the
// scheduler's production installer when one is configured, else the
// fail-closed stub (recoveryinstall.ErrUnavailable).
func recoveryEnsure(s RecoveryScheduler, wantVersion string) func(context.Context) (string, error) {
	stub := func(ctx context.Context) (string, error) { return recoveryinstall.EnsureRecovery(ctx, wantVersion) }
	p, ok := s.(interface {
		recoveryInstaller() (*recoveryinstall.Installer, error)
	})
	if !ok {
		return stub
	}
	return func(ctx context.Context) (string, error) {
		inst, err := p.recoveryInstaller()
		if errors.Is(err, recoveryinstall.ErrUnavailable) {
			return stub(ctx)
		}
		if err != nil {
			return "", err
		}
		return inst.EnsureRecovery(ctx, wantVersion)
	}
}

func (s *windowsScheduler) configureRecoverySource(src RecoverySource) {
	s.source.Store(&src)
}

// pollTaskName is the only task an idle device has: the boot and 15-minute
// expire-check backstop. Rollback and expiry tasks exist only during an
// episode, and the installer never repoints while one is unresolved.
const pollTaskName = recoveryTaskFolder + "IsolationPoll"

// recoveryInstaller builds the production installer. It takes the trust policy
// from trustPolicy(), the same one every Arm* and Ready() apply, so the
// installer adopts exactly the executables the scheduler will later accept.
func (s *windowsScheduler) recoveryInstaller() (*recoveryinstall.Installer, error) {
	src := s.source.Load()
	if src == nil || src.Fetch == nil || s.installDir == nil || s.runRecovery == nil {
		return nil, recoveryinstall.ErrUnavailable
	}
	installDir, err := s.installDir()
	if err != nil {
		return nil, fmt.Errorf("resolve recovery install directory: %w", err)
	}
	policy := s.trustPolicy()
	return &recoveryinstall.Installer{
		InstallDir:      installDir,
		DataDir:         s.dataDir,
		Fetch:           src.Fetch,
		FetchEnvelope:   src.FetchEnvelope,
		VerifySignature: policy.CodeSignature,
		ManifestTrust:   policy.ManifestTrust,
		SupportedSchema: func(ctx context.Context, path string) (int, error) {
			out, err := s.runRecovery(ctx, path, "--journal-schema")
			if err != nil {
				return 0, err
			}
			schema, err := strconv.Atoi(strings.TrimSpace(string(out)))
			if err != nil {
				return 0, fmt.Errorf("parse recovery journal schema: %w", err)
			}
			return schema, nil
		},
		SelfTest: func(ctx context.Context, path string) error {
			_, err := s.runRecovery(ctx, path, "self-test")
			return err
		},
		Tasks: func() ([]recoveryinstall.Task, error) {
			return []recoveryinstall.Task{{Name: pollTaskName}}, nil
		},
		Repoint: func(task recoveryinstall.Task, path string) error {
			if task.Name != pollTaskName {
				return fmt.Errorf("refuse to repoint task %q", task.Name)
			}
			// register reads the task back, so a repoint is confirmed or fails.
			return s.register(buildPollTask(path, s.dataDir, s.now()))
		},
		// readback compares action, principal, settings and trigger kinds, not
		// the start boundary, so an existing poll task stays as registered and
		// keeps its 15-minute cadence across readiness re-probes.
		TaskCurrent: func(task recoveryinstall.Task, path string) bool {
			return task.Name == pollTaskName && s.readback(buildPollTask(path, s.dataDir, s.now())) == nil
		},
		Warn: func(msg string, err error) { log.Warn(msg, "error", err) },
	}, nil
}
