package selfuninstall

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Windows step names. They appear in the reported result (failedStep, steps),
// so they are stable: rename one only together with anything that reads it.
const (
	StepReleaseIsolation     = "release-isolation"
	StepHandoffDelay         = "handoff-delay"
	StepStopWatchdog         = "stop-watchdog"
	StepStopAgent            = "stop-agent"
	StepStopHelpers          = "stop-helpers"
	StepReconfirmRelease     = "reconfirm-isolation-release"
	StepMSIUninstall         = "msi-uninstall"
	StepRemoveServices       = "remove-services"
	StepRemoveUserHelperTask = "remove-user-helper-task"
	StepRemoveBinaries       = "remove-binaries"
	StepRemoveConfig         = "remove-config"
	StepVerifyServices       = "verify-services"
	StepVerifyUserHelperTask = "verify-user-helper-task"
	StepVerifyProduct        = "verify-product"
	StepVerifyProcesses      = "verify-processes"
)

// msiexec exit codes the plan branches on
// (https://learn.microsoft.com/en-us/windows/win32/msi/error-codes).
const (
	msiExitSuccess            = 0
	msiExitUnknownProduct     = 1605 // ERROR_UNKNOWN_PRODUCT
	msiExitProductUninstalled = 1614 // ERROR_PRODUCT_UNINSTALLED
	msiExitInstallRunning     = 1618 // ERROR_INSTALL_ALREADY_RUNNING
	msiExitRebootInitiated    = 1641 // ERROR_SUCCESS_REBOOT_INITIATED
	msiExitRebootRequired     = 3010 // ERROR_SUCCESS_REBOOT_REQUIRED
)

// Removal methods and the keys of the details carried in the reported result.
const (
	removalMethodMSI         = "msi"
	removalMethodManual      = "manual"
	detailMethod             = "method"
	detailProductCodes       = "productCodes"
	detailRebootRequired     = "rebootRequired"
	detailMSIExitCodes       = "msiExitCodes"
	detailMSILog             = "msiLog"
	detailFilesAtReboot      = "filesRemovedAtReboot"
	detailMSILookupWarning   = "msiLookupError"
	detailConfigRemoved      = "configRemoved"
	detailUserHelperTaskGone = "userHelperTaskRemoved"
	detailServicesRemoved    = "servicesRemoved"
	detailProductUnverified  = "productUnverified"
)

// WindowsOptions are the inputs to the Windows teardown.
type WindowsOptions struct {
	AgentService    string // BreezeAgent
	WatchdogService string // BreezeWatchdog
	// AgentBinary is the INSTALLED agent executable. It runs
	// `containment release-all` while it still exists and is swept last.
	AgentBinary string
	// Binaries is every installed executable to remove (the agent's included).
	// Swept on both paths: Windows agent updates replace binaries in place, so
	// the cached MSI can be older than the agent and not know about every file.
	Binaries []string
	// UserHelperTask is the logon task that starts the user helper.
	UserHelperTask string
	// ConfigDir is ProgramData\Breeze; "" skips config removal.
	ConfigDir    string
	RemoveConfig bool
	// UpgradeCodes identify the agent's MSI products (one per edition).
	// ProductCode changes with every build, so it is looked up, never fixed.
	UpgradeCodes []string
	MSILogPath   string
	// HandoffDelay lets the agent's handler return and the agent stop
	// accepting commands before its service is stopped.
	HandoffDelay time.Duration
	// HelperProcesses are killed once the agent service is down: they hold
	// file locks, and a respawned agent image is among them.
	HelperProcesses []string
	// AgentProcesses must not be running when the teardown is verified. Any
	// still running are killed again and re-checked, ProcessSettleAttempts
	// times ProcessSettleDelay apart, before verify-processes fails.
	AgentProcesses        []string
	ProcessSettleAttempts int
	ProcessSettleDelay    time.Duration
	// MSIBusyRetries bounds retries of an msiexec that found another
	// installation in progress (1618), MSIBusyRetryDelay apart.
	MSIBusyRetries    int
	MSIBusyRetryDelay time.Duration
	// OnAgentStopped runs once the agent service is stopped, before anything
	// is removed: the caller re-snapshots the agent's credentials, which the
	// stopped agent can no longer rotate. An error is a warning.
	OnAgentStopped func() error
}

// WindowsOps are the side effects of the Windows teardown, behind an
// interface so the plan's decisions are testable on any host.
type WindowsOps interface {
	// ReleaseIsolation runs `<agentBinary> containment release-all`.
	ReleaseIsolation(ctx context.Context, agentBinary string) error
	Sleep(ctx context.Context, d time.Duration) error
	// StopService stops a service and waits for STOPPED, terminating its
	// process if it does not stop in time. A service that does not exist is
	// already stopped.
	StopService(ctx context.Context, name string) error
	// DeleteService deletes a service registration; absent is success.
	DeleteService(name string) error
	// ServiceExists reports whether a registration remains. One marked for
	// deletion does not count: it disappears once its last handle closes.
	ServiceExists(name string) (bool, error)
	KillProcesses(names []string)
	// RelatedProducts returns the installed ProductCodes for the UpgradeCodes.
	RelatedProducts(upgradeCodes []string) ([]string, error)
	// UninstallProduct runs msiexec /x quietly and returns its exit code.
	UninstallProduct(ctx context.Context, productCode, logPath string) (int, error)
	// DeleteScheduledTask deletes a task; absent is success.
	DeleteScheduledTask(name string) error
	ScheduledTaskExists(name string) (bool, error)
	// RemoveFile removes a file; absent is success.
	RemoveFile(path string) error
	// RemoveFileAtReboot queues path for removal at the next boot.
	RemoveFileAtReboot(path string) error
	RemoveAll(path string) error
	// ProcessesRunning returns which of names have a live process.
	ProcessesRunning(names []string) ([]string, error)
	// RestoreService re-enables the agent service (auto start, recovery
	// actions) and restarts it, replacing a process that is on its way out.
	RestoreService(ctx context.Context, name string) error
}

// BuildWindowsPlan returns the Windows teardown. Report is left for the
// caller; OnFailure restores the agent service, unless the failure came after
// the services were removed, when there is nothing left to restore.
//
// Order is load-bearing:
//   - isolation release first, while the agent can still restore itself;
//   - the watchdog down before the agent, so nothing respawns it;
//   - the release confirmed AGAIN once the agent is down (until then it could
//     isolate the device again) and before anything that undoes isolation is
//     removed;
//   - msiexec /x by UpgradeCode (it removes the Programs and Features entry),
//     falling back to removing services, task and files by hand when no MSI
//     product is registered; services, task and files are then removed on
//     both paths, because the cached MSI may predate them;
//   - verification, then config: a teardown that fails verification keeps its
//     config and logs for diagnosis. Only a verified teardown is completed.
func BuildWindowsPlan(opts WindowsOptions, ops WindowsOps) Plan {
	// products are the ProductCodes msiexec removed; method is reported
	// either way.
	var products []string
	// stale are products Windows Installer lists but msiexec reports as not
	// installed (1605): nothing msiexec can remove, so verify-product reports
	// them instead of failing on them.
	stale := map[string]bool{}
	method := removalMethodManual

	steps := []Step{
		{Name: StepReleaseIsolation, Run: func(ctx context.Context, _ *Recorder) error {
			return ops.ReleaseIsolation(ctx, opts.AgentBinary)
		}},
		{Name: StepHandoffDelay, Run: func(ctx context.Context, _ *Recorder) error {
			return ops.Sleep(ctx, opts.HandoffDelay)
		}},
		{Name: StepStopWatchdog, Run: func(ctx context.Context, rec *Recorder) error {
			// Stopped and deleted best-effort in-process before the hand-off;
			// this re-asserts the stop. verify-services requires it gone.
			if err := ops.StopService(ctx, opts.WatchdogService); err != nil {
				rec.Warn("could not stop the %s service again: %v", opts.WatchdogService, err)
			}
			return nil
		}},
		{Name: StepStopAgent, Run: func(ctx context.Context, rec *Recorder) error {
			if err := ops.StopService(ctx, opts.AgentService); err != nil {
				return err
			}
			if opts.OnAgentStopped != nil {
				if err := opts.OnAgentStopped(); err != nil {
					rec.Warn("could not re-read the agent credentials after it stopped; reporting with the ones read at start: %v", err)
				}
			}
			return nil
		}},
		{Name: StepStopHelpers, Run: func(context.Context, *Recorder) error {
			ops.KillProcesses(opts.HelperProcesses)
			return nil
		}},
		{Name: StepReconfirmRelease, Run: func(ctx context.Context, _ *Recorder) error {
			return ops.ReleaseIsolation(ctx, opts.AgentBinary)
		}},
		{Name: StepMSIUninstall, Run: func(ctx context.Context, rec *Recorder) error {
			found, err := ops.RelatedProducts(opts.UpgradeCodes)
			if err != nil {
				rec.Warn("could not query Windows Installer for the agent's product (%v); removing it by hand, so its Programs and Features entry may remain", err)
				rec.Set(detailMSILookupWarning, err.Error())
				rec.Set(detailMethod, method)
				return nil
			}
			var exits []int
			for _, code := range found {
				exit, err := uninstallWithRetry(ctx, ops, opts, code)
				exits = append(exits, exit)
				rec.Set(detailMSIExitCodes, exits)
				rec.Set(detailMSILog, opts.MSILogPath)
				switch {
				case err != nil:
					return fmt.Errorf("msiexec /x %s: %w (log: %s)", code, err, opts.MSILogPath)
				case exit == msiExitSuccess:
				case exit == msiExitRebootRequired || exit == msiExitRebootInitiated:
					rec.Set(detailRebootRequired, true)
				case exit == msiExitUnknownProduct || exit == msiExitProductUninstalled:
					// Listed but not installed: nothing for msiexec to do; the
					// removal below covers the files and services.
					stale[code] = true
					continue
				default:
					return fmt.Errorf("msiexec /x %s exited %d; the uninstall did not complete (log: %s)", code, exit, opts.MSILogPath)
				}
				products = append(products, code)
				method = removalMethodMSI
			}
			rec.Set(detailMethod, method)
			if len(products) > 0 {
				rec.Set(detailProductCodes, products)
			}
			return nil
		}},
		{Name: StepRemoveServices, Run: func(_ context.Context, rec *Recorder) error {
			for _, name := range []string{opts.WatchdogService, opts.AgentService} {
				if err := ops.DeleteService(name); err != nil {
					return fmt.Errorf("delete the %s service: %w", name, err)
				}
			}
			// The point of no return: from here a failure cannot restore the
			// agent, and the result says so (ResultFor).
			rec.Set(detailServicesRemoved, true)
			return nil
		}},
		{Name: StepRemoveUserHelperTask, Run: func(_ context.Context, rec *Recorder) error {
			if opts.UserHelperTask == "" {
				return nil
			}
			if err := ops.DeleteScheduledTask(opts.UserHelperTask); err != nil {
				rec.Warn("could not delete the %s scheduled task: %v", opts.UserHelperTask, err)
			}
			return nil
		}},
		{Name: StepRemoveBinaries, Run: func(_ context.Context, rec *Recorder) error {
			var atReboot []string
			for _, path := range opts.Binaries {
				err := ops.RemoveFile(path)
				if err == nil {
					continue
				}
				if rebootErr := ops.RemoveFileAtReboot(path); rebootErr != nil {
					rec.Warn("could not remove %s (%v) or queue it for removal at reboot (%v)", path, err, rebootErr)
					continue
				}
				atReboot = append(atReboot, path)
				rec.Warn("%s could not be removed now (%v); it is queued for removal at the next reboot", path, err)
			}
			if len(atReboot) > 0 {
				rec.Set(detailFilesAtReboot, atReboot)
			}
			return nil
		}},
		{Name: StepVerifyServices, Run: func(context.Context, *Recorder) error {
			for _, name := range []string{opts.AgentService, opts.WatchdogService} {
				exists, err := ops.ServiceExists(name)
				if err != nil {
					return fmt.Errorf("query the %s service: %w", name, err)
				}
				if exists {
					return fmt.Errorf("the %s service is still registered", name)
				}
			}
			return nil
		}},
		{Name: StepVerifyUserHelperTask, Run: func(_ context.Context, rec *Recorder) error {
			if opts.UserHelperTask == "" {
				return nil
			}
			// A leftover task points at a removed binary: cruft, not an agent
			// that can run, so it is reported without failing the uninstall.
			exists, err := ops.ScheduledTaskExists(opts.UserHelperTask)
			switch {
			case err != nil:
				rec.Warn("could not check the %s scheduled task: %v", opts.UserHelperTask, err)
			case exists:
				rec.Warn("the %s scheduled task is still registered", opts.UserHelperTask)
			default:
				rec.Set(detailUserHelperTaskGone, true)
			}
			return nil
		}},
		{Name: StepVerifyProduct, Run: func(_ context.Context, rec *Recorder) error {
			left, err := ops.RelatedProducts(opts.UpgradeCodes)
			if err != nil {
				rec.Warn("could not confirm with Windows Installer that the agent's product is gone: %v", err)
				rec.Set(detailProductUnverified, true)
				return nil
			}
			var installed []string
			for _, code := range left {
				if stale[code] {
					rec.Warn("Windows Installer still lists %s but reports it is not installed (1605/1614); its Programs and Features entry may remain", code)
					continue
				}
				installed = append(installed, code)
			}
			if len(installed) > 0 {
				return fmt.Errorf("the Windows Installer still lists the agent's product (%s)", strings.Join(installed, ", "))
			}
			return nil
		}},
		{Name: StepVerifyProcesses, Run: func(ctx context.Context, _ *Recorder) error {
			// A process image can outlive its service's STOPPED state briefly,
			// and this failure cannot be rolled back: kill and re-check before
			// giving up.
			for attempt := 0; ; attempt++ {
				running, err := ops.ProcessesRunning(opts.AgentProcesses)
				if err != nil {
					return fmt.Errorf("list processes: %w", err)
				}
				if len(running) == 0 {
					return nil
				}
				if attempt >= opts.ProcessSettleAttempts {
					return fmt.Errorf("still running: %s", strings.Join(running, ", "))
				}
				ops.KillProcesses(running)
				if err := ops.Sleep(ctx, opts.ProcessSettleDelay); err != nil {
					return err
				}
			}
		}},
		{Name: StepRemoveConfig, Run: func(_ context.Context, rec *Recorder) error {
			if !opts.RemoveConfig {
				return nil
			}
			if opts.ConfigDir == "" {
				rec.Warn("config removal was requested but the config directory is unknown; nothing was removed")
				return nil
			}
			if err := ops.RemoveAll(opts.ConfigDir); err != nil {
				rec.Warn("could not remove all of %s: %v", opts.ConfigDir, err)
				return nil
			}
			rec.Set(detailConfigRemoved, true)
			return nil
		}},
	}

	return Plan{
		Steps: steps,
		OnFailure: func(ctx context.Context, o Outcome) {
			if servicesRemoved(o) {
				log.Error("self-uninstall failed after the agent's services were removed; nothing to restore",
					"failedStep", o.FailedStep)
				return
			}
			if err := ops.RestoreService(ctx, opts.AgentService); err != nil {
				log.Error("self-uninstall failed and the agent service could not be restored",
					"service", opts.AgentService, "error", err.Error())
			}
		},
	}
}

// errMSIBusy is returned when msiexec kept finding another installation in
// progress for every allowed attempt.
var errMSIBusy = errors.New("another installation kept Windows Installer busy (1618)")

// uninstallWithRetry runs msiexec /x, retrying only 1618 (another
// installation in progress — Windows Update holds the Installer mutex often
// enough to matter), at most opts.MSIBusyRetries times.
func uninstallWithRetry(ctx context.Context, ops WindowsOps, opts WindowsOptions, code string) (int, error) {
	for attempt := 0; ; attempt++ {
		exit, err := ops.UninstallProduct(ctx, code, opts.MSILogPath)
		if err != nil || exit != msiExitInstallRunning {
			return exit, err
		}
		if attempt >= opts.MSIBusyRetries {
			return exit, errMSIBusy
		}
		if err := ops.Sleep(ctx, opts.MSIBusyRetryDelay); err != nil {
			return exit, err
		}
	}
}

// servicesRemoved reports whether the teardown got past remove-services, after
// which the agent cannot be restored.
func servicesRemoved(o Outcome) bool {
	removed, _ := o.Details[detailServicesRemoved].(bool)
	return removed
}
