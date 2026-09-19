package heartbeat

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/helper"
	rollbackstate "github.com/breeze-rmm/agent/internal/rollback"
	"github.com/breeze-rmm/agent/internal/updater"
)

type agentRollbackBackend struct {
	mu              sync.Mutex
	updater         *updater.Updater
	staged          updater.StagedRollbackSet
	componentPaths  map[rollbackstate.Component]string
	journalPath     string
	currentVersions func() map[rollbackstate.Component]string
	mutationLease   *updater.ProcessMutationLease
}

func (b *agentRollbackBackend) verifyLiveVersions(d rollbackstate.Directive) error {
	versions := b.currentVersions()
	if len(versions) != len(d.ComponentVersions) {
		return fmt.Errorf("rollback live component set changed")
	}
	for component, binding := range d.ComponentVersions {
		if versions[rollbackstate.Component(component)] != binding.Current {
			return fmt.Errorf("rollback live component version changed for %s", component)
		}
	}
	return nil
}

func (b *agentRollbackBackend) releaseMutationLease() {
	if b.mutationLease != nil {
		b.mutationLease.Release()
		b.mutationLease = nil
	}
}

func (b *agentRollbackBackend) Prepare(_ context.Context, d rollbackstate.Directive) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	lease, acquired := updater.TryBeginProcessMutation("rollback-stage")
	if !acquired {
		return updater.ErrProcessMutationInProgress
	}
	defer lease.Release()
	if err := b.verifyLiveVersions(d); err != nil {
		return err
	}
	b.staged.Cleanup()
	b.staged = updater.StagedRollbackSet{}
	request := updater.RollbackStageRequest{DirectiveID: d.RollbackID, Platform: d.Platform, Architecture: d.Architecture, CurrentVersion: d.CurrentVersion, TargetVersion: d.TargetVersion, ReleaseManifest: d.ReleaseManifest, ManifestSignature: d.ManifestSignature, ManifestSigningKeyID: d.ManifestSigningKeyID, ComponentVersions: map[updater.RollbackComponent]updater.RollbackComponentVersion{}}
	for component, versions := range d.ComponentVersions {
		request.ComponentVersions[updater.RollbackComponent(component)] = updater.RollbackComponentVersion{Current: versions.Current, Target: versions.Target}
	}
	for _, artifact := range d.Artifacts {
		request.Artifacts = append(request.Artifacts, updater.RollbackArtifactMetadata{Component: updater.RollbackComponent(artifact.Component), CurrentVersion: artifact.CurrentVersion, TargetVersion: artifact.TargetVersion, DownloadURL: artifact.DownloadURL, SHA256: artifact.SHA256, Size: artifact.Size})
	}
	staged, err := b.updater.StageRollbackArtifacts(request)
	if err != nil {
		return err
	}
	b.staged = staged
	return nil
}

func (b *agentRollbackBackend) Swap(_ context.Context, d rollbackstate.Directive) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	lease, acquired := updater.TryBeginProcessMutation("rollback-swap")
	if !acquired {
		return updater.ErrProcessMutationInProgress
	}
	b.mutationLease = lease
	if err := b.verifyLiveVersions(d); err != nil {
		b.releaseMutationLease()
		return err
	}
	if b.staged.DirectiveID != d.RollbackID || len(b.staged.Artifacts) != len(d.Artifacts) {
		b.releaseMutationLease()
		return fmt.Errorf("rollback staged set mismatch")
	}
	set := updater.RollbackSwapSet{DirectiveID: d.RollbackID, JournalPath: b.journalPath}
	for _, artifact := range b.staged.Artifacts {
		live := b.componentPaths[rollbackstate.Component(artifact.Component)]
		if live == "" {
			b.releaseMutationLease()
			return fmt.Errorf("no live path for rollback component %s", artifact.Component)
		}
		set.Artifacts = append(set.Artifacts, updater.RollbackSwapArtifact{Component: artifact.Component, StagedPath: artifact.StagedPath, LivePath: live})
	}
	if err := updater.SwapRollbackArtifactsRetainingJournal(set); err != nil {
		b.releaseMutationLease()
		return err
	}
	b.staged.Cleanup()
	b.staged = updater.StagedRollbackSet{}
	return nil
}

func (b *agentRollbackBackend) Restart(context.Context, rollbackstate.Directive) error {
	return updater.RestartAfterRollback(b.journalPath)
}
func (b *agentRollbackBackend) Healthy(_ context.Context, d rollbackstate.Directive) (bool, error) {
	versions := b.currentVersions()
	for component := range d.ComponentVersions {
		if versions[rollbackstate.Component(component)] != d.TargetVersion {
			return false, nil
		}
	}
	return true, nil
}
func (b *agentRollbackBackend) Finalize(context.Context, rollbackstate.Directive) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if err := updater.CommitRollbackSwap(b.journalPath); err != nil {
		return err
	}
	b.releaseMutationLease()
	return nil
}
func (b *agentRollbackBackend) Recover(context.Context, rollbackstate.Directive) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	defer b.releaseMutationLease()
	b.staged.Cleanup()
	b.staged = updater.StagedRollbackSet{}
	if _, err := os.Stat(b.journalPath); os.IsNotExist(err) {
		return nil
	}
	return updater.RecoverRollbackSwap(b.journalPath)
}

func (h *Heartbeat) initializeRollbackController() {
	if h.config == nil || h.config.DeviceID == "" || h.config.OrgID == "" {
		return
	}
	binaryPath, err := os.Executable()
	if err != nil {
		log.Error("rollback disabled: cannot resolve agent executable", "error", err.Error())
		return
	}
	if resolved, resolveErr := filepath.EvalSymlinks(binaryPath); resolveErr == nil {
		binaryPath = resolved
	}
	dir := filepath.Dir(binaryPath)
	suffix := ""
	if runtime.GOOS == "windows" {
		suffix = ".exe"
	}
	backupPath := h.config.BackupBinaryPath
	if backupPath == "" {
		backupPath = filepath.Join(dir, "breeze-backup"+suffix)
	}
	paths := map[rollbackstate.Component]string{"agent": binaryPath, "helper": helper.DefaultBinaryPath(), "watchdog": filepath.Join(dir, "breeze-watchdog"+suffix), "backup": backupPath}
	if runtime.GOOS == "windows" {
		paths["user-helper"] = filepath.Join(dir, "breeze-user-helper.exe")
	}
	u := updater.New(&updater.Config{ServerURL: h.serverURL, BackupServerURL: h.backupServerURL(), AuthToken: h.secureToken, CurrentVersion: h.agentVersion, PinnedManifestPubKeys: h.pinnedManifestPubKeys(), RequireManifestSigningKeyID: h.requireManifestSigningKeyID()})
	backend := &agentRollbackBackend{updater: u, componentPaths: paths, journalPath: filepath.Join(config.GetDataDir(), "agent-rollback-swap.json"), currentVersions: func() map[rollbackstate.Component]string {
		inventory, complete := h.rollbackComponentVersions()
		if !complete {
			return nil
		}
		versions := make(map[rollbackstate.Component]string, len(inventory))
		for component, version := range inventory {
			versions[rollbackstate.Component(component)] = version
		}
		return versions
	}}
	engine := rollbackstate.NewEngine(rollbackstate.NewStore(filepath.Join(config.GetDataDir(), "agent-rollback-state.json")), rollbackstate.Environment{DeviceID: h.config.DeviceID, OrgID: h.config.OrgID, CurrentVersion: h.agentVersion, Backend: backend, VerifySignature: u.VerifySignedPayload})
	h.rollbackController = engine
	if err := engine.Reconcile(context.Background()); err != nil {
		log.Error("rollback startup reconciliation failed", "error", err.Error())
	}
}
