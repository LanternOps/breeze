package agentapp

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	"syscall"
	"time"

	"github.com/breeze-rmm/agent/internal/audit"
	"github.com/breeze-rmm/agent/internal/authstate"
	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/elevaccount"
	"github.com/breeze-rmm/agent/internal/eventlog"
	"github.com/breeze-rmm/agent/internal/heartbeat"
	"github.com/breeze-rmm/agent/internal/hostpolicy"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/mtls"
	"github.com/breeze-rmm/agent/internal/observability"
	"github.com/breeze-rmm/agent/internal/pamactuator"
	"github.com/breeze-rmm/agent/internal/pamlifetime"
	"github.com/breeze-rmm/agent/internal/safemode"
	"github.com/breeze-rmm/agent/internal/secmem"
	"github.com/breeze-rmm/agent/internal/state"
	"github.com/breeze-rmm/agent/internal/unifi"
	"github.com/breeze-rmm/agent/internal/userhelper"
	"github.com/breeze-rmm/agent/internal/websocket"
	"github.com/breeze-rmm/agent/internal/workspaceindex"
	"github.com/breeze-rmm/agent/pkg/api"
	"github.com/spf13/cobra"
)

// unifiAuthTransport injects the agent's bearer token into requests to the
// Breeze API for the UniFi telemetry collector. It reveals the token per-request
// (preserving secmem semantics) and clones the request rather than mutating the
// caller's. Redirect-following is disabled on the owning http.Client so the
// token can never leak to another host (mirrors pkg/api's redirect guard).
type unifiAuthTransport struct {
	base  http.RoundTripper
	token *secmem.SecureString
}

func (t *unifiAuthTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if t.token != nil && !t.token.IsZeroed() {
		r2 := req.Clone(req.Context())
		r2.Header.Set("Authorization", "Bearer "+t.token.Reveal())
		return t.base.RoundTrip(r2)
	}
	return t.base.RoundTrip(req)
}

// newUnifiAPIClient builds an http.Client that authenticates to the Breeze API
// as this agent and refuses redirects (token-leak guard).
func newUnifiAPIClient(token *secmem.SecureString, tlsCfg *tls.Config) *http.Client {
	tr := &http.Transport{}
	if tlsCfg != nil {
		tr.TLSClientConfig = tlsCfg
	}
	return &http.Client{
		Timeout:       30 * time.Second,
		Transport:     &unifiAuthTransport{base: tr, token: token},
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}
}

var (
	version          = "0.5.0"
	cfgFile          string
	serverURL        string
	backupServerURL  string // seeded by bootstrap/enroll responses (#2288)
	enrollmentSecret string
	enrollSiteID     string
	enrollDeviceRole string
	forceEnroll      bool
	quietEnroll      bool
	helperRole       string
	desktopContext   string
)

type pamStartupController interface {
	SetStatePath(string)
	ReconcilePAMLifetime(context.Context) []pamlifetime.Result
}

const pamStartupReconcileTimeout = 2 * time.Minute

func preparePAMLifetimeStartup(ctx context.Context, controller pamStartupController, statePath string) []pamlifetime.Result {
	controller.SetStatePath(statePath)
	reconcileCtx, cancel := context.WithTimeout(ctx, pamStartupReconcileTimeout)
	defer cancel()
	return controller.ReconcilePAMLifetime(reconcileCtx)
}

var log = logging.L("main")

// waitForEnrollmentPollInterval is the interval between config reloads
// in the wait-for-enrollment loop. Tests override this via t.Cleanup to
// shrink the loop to milliseconds.
var waitForEnrollmentPollInterval = 10 * time.Second

// Package-level indirection for testability. Tests override these in
// t.Cleanup-guarded setup to observe Execute and runAgent ordering
// without running the real startup pipeline. Production callers MUST
// use these vars, not the unexported symbols they wrap.
//
// startAgentFn and waitForEnrollmentFn are cross-platform; runServiceLoopFn
// is defined in service_seams_windows.go because its signature references
// Windows-only types.
var (
	startAgentFn                   func(*config.Config) (*agentComponents, error) = startAgent
	waitForEnrollmentFn            func(context.Context, string) *config.Config   = waitForEnrollment
	reconcileServiceUnitIfNeededFn                                                = reconcileServiceUnitIfNeeded
)

// describeLogFileError returns a bounded, secret-free description of a log
// file setup failure — only the path and a short reason ever appear, never
// file contents. When err wraps *logging.ErrUnsafeLogPath (P1-AGENT-LOG-001:
// a symlink was found at the log path, its directory, or a rotation
// backup), the description calls out the security-relevant condition
// explicitly so it stands out from an ordinary I/O failure in stdout/stderr
// fallback logs.
func describeLogFileError(err error) string {
	var unsafePath *logging.ErrUnsafeLogPath
	if errors.As(err, &unsafePath) {
		return fmt.Sprintf("unsafe log path, refusing to open it (%s)", unsafePath.Reason)
	}
	return err.Error()
}

// initBootstrapLogging initializes the logging package with stderr +
// the configured log file so waitForEnrollment can emit Warn/Info
// lines before full startAgent runs. Does NOT start the log shipper,
// heartbeat, or any network I/O — those are initialized later in
// startAgent once enrollment is complete. Safe to call multiple times
// (logging.Init is idempotent).
func initBootstrapLogging(cfg *config.Config) {
	logFile := cfg.LogFile
	if logFile == "" {
		logFile = filepath.Join(config.LogDir(), "agent.log")
	}
	// Best effort: if the log file can't be opened securely (permissions,
	// missing dir, or an unsafe path such as a symlink — see
	// logging.NewRotatingWriter, which now owns directory creation and
	// symlink rejection itself), fall back to stderr only. Bootstrap
	// logging must never fail the agent start, and file logging being
	// disabled must never mean logging is silent: this always emits one
	// warning through the stderr-only logger so the condition is visible.
	rw, err := logging.NewRotatingWriter(logFile, cfg.LogMaxSizeMB, cfg.LogMaxBackups)
	if err != nil {
		logging.Init(cfg.LogFormat, cfg.LogLevel, os.Stderr)
		log.Warn("log file unavailable during bootstrap, using stderr only",
			"logFile", logFile, "reason", describeLogFileError(err))
		return
	}
	logging.Init(cfg.LogFormat, cfg.LogLevel, logging.TeeWriter(os.Stderr, rw))
}

// waitForEnrollment polls agent.yaml + secrets.yaml every
// waitForEnrollmentPollInterval until config.IsEnrolled returns true,
// then returns the enrolled config. Returns nil if ctx is cancelled
// before enrollment completes.
//
// Intended for post-MSI-install scenarios where the service starts
// before a later `breeze-agent enroll` call populates the config. The
// ctx allows the caller to cancel the wait on shutdown (SIGINT/SIGTERM
// via signal.NotifyContext in runAgent, or SCM Stop in the Windows
// service wrapper).
func waitForEnrollment(ctx context.Context, cfgFile string) *config.Config {
	log.Warn("agent not enrolled — waiting for enrollment. "+
		"Run 'breeze-agent enroll <key> --server <url>' to complete setup.",
		"pollInterval", waitForEnrollmentPollInterval)
	eventlog.Info("BreezeAgent",
		"Waiting for enrollment. Run 'breeze-agent enroll <key> --server <url>'.")

	ticker := time.NewTicker(waitForEnrollmentPollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Info("waitForEnrollment cancelled", "reason", ctx.Err().Error())
			return nil
		case <-ticker.C:
			cfg, err := config.Load(cfgFile)
			if err != nil {
				log.Debug("config reload failed while waiting for enrollment",
					"error", err.Error())
				continue
			}
			if config.IsEnrolled(cfg) {
				log.Info("enrollment detected, continuing startup",
					"agentId", cfg.AgentID)
				return cfg
			}
		}
	}
}

var rootCmd = &cobra.Command{
	Use:   "breeze-agent",
	Short: "Breeze RMM Agent",
	Long:  `Breeze Agent - Remote Monitoring and Management agent for Windows, macOS, and Linux`,
}

var startCmd = &cobra.Command{
	Use:   "start",
	Short: "Start the agent",
	Run: func(cmd *cobra.Command, args []string) {
		runAgent()
	},
}

// runCmd is the legacy name for `start`, retained as a hidden alias so
// systemd units and MSI invocations on already-deployed agents continue
// to work after a binary-only upgrade. Safe to remove once every shipped
// unit file references `start`.
var runCmd = &cobra.Command{
	Use:    "run",
	Short:  "Deprecated: alias for 'start'",
	Hidden: true,
	Run: func(cmd *cobra.Command, args []string) {
		runAgent()
	},
}

var enrollCmd = &cobra.Command{
	Use:   "enroll [enrollment-key]",
	Short: "Enroll this device with the Breeze server",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		enrollDevice(args[0])
	},
}

var bootstrapCmd = &cobra.Command{
	Use:    "bootstrap",
	Short:  "Redeem an installer bootstrap token and enroll (used by the MSI)",
	Hidden: true,
	Run: func(cmd *cobra.Command, args []string) {
		runBootstrap()
	},
}

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Print the version number",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Printf("Breeze Agent v%s\n", version)
	},
}

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Check agent status",
	Run: func(cmd *cobra.Command, args []string) {
		checkStatus()
	},
}

// uninstallNotifyCmd is the WiX uninstall CA's target (Return="ignore" —
// see installer/breeze.wxs). It is intentionally NOT wired through
// enrollError/osExit: unlike every other enroll/bootstrap path in this
// package, a failure here must never fail the process. See
// runUninstallNotify.
var uninstallNotifyCmd = &cobra.Command{
	Use:    "uninstall-notify",
	Short:  "Best-effort notify the server that this agent is about to be uninstalled (used by the uninstaller)",
	Hidden: true,
	Run: func(cmd *cobra.Command, args []string) {
		runUninstallNotify()
	},
}

var userHelperCmd = &cobra.Command{
	Use:   "user-helper",
	Short: "Run as a per-user session helper (started automatically by the system)",
	Long: `The user-helper runs in the logged-in user's session context and provides
desktop notifications, system tray icon, screen capture, clipboard access,
and user-context script execution. It communicates with the root daemon
via a local IPC socket and has no direct network access.`,
	Run: func(cmd *cobra.Command, args []string) {
		runUserHelper()
	},
}

var desktopHelperCmd = &cobra.Command{
	Use:   "desktop-helper",
	Short: "Run as the dedicated desktop helper",
	Run: func(cmd *cobra.Command, args []string) {
		runDesktopHelper()
	},
}

func init() {
	rootCmd.PersistentFlags().StringVar(&cfgFile, "config", "", "config file (default is /etc/breeze/agent.yaml)")
	rootCmd.PersistentFlags().StringVar(&serverURL, "server", "", "Breeze server URL")
	enrollCmd.Flags().StringVar(&enrollmentSecret, "enrollment-secret", "", "Enrollment secret (AGENT_ENROLLMENT_SECRET on the server)")
	enrollCmd.Flags().StringVar(&enrollSiteID, "site-id", "", "Site ID to enroll into (optional, overrides enrollment key default)")
	enrollCmd.Flags().StringVar(&enrollDeviceRole, "device-role", "", "Device role override (e.g. workstation, server)")
	enrollCmd.Flags().BoolVar(&forceEnroll, "force", false, "Re-enroll even if already enrolled; replaces AgentID/AuthToken on success (no-op on failure)")
	enrollCmd.Flags().BoolVar(&quietEnroll, "quiet", false, "Suppress stdout progress output (errors still go to stderr). Intended for unattended installs.")
	bootstrapCmd.Flags().StringVar(&bootstrapInstallData, "install-data", "", "Pipe-packed bootstrap inputs from the MSI BootstrapEnroll CA: <OriginalDatabase>|<BOOTSTRAP_TOKEN>|<SERVER_URL>")
	bootstrapCmd.Flags().BoolVar(&quietEnroll, "quiet", false, "Suppress stdout progress output (errors still go to stderr)")
	supportCmd.Flags().StringVar(&supportCode, "code", "", "Quick Support code (overrides the code embedded in the filename)")
	userHelperCmd.Flags().StringVar(&helperRole, "role", string(ipc.HelperRoleUser), "Helper role: 'system' (desktop capture) or 'user' (script execution)")
	desktopHelperCmd.Flags().StringVar(&desktopContext, "context", ipc.DesktopContextUserSession, "Desktop context: 'user_session' or 'login_window'")

	rootCmd.AddCommand(startCmd)
	rootCmd.AddCommand(runCmd)
	rootCmd.AddCommand(enrollCmd)
	rootCmd.AddCommand(bootstrapCmd)
	rootCmd.AddCommand(versionCmd)
	rootCmd.AddCommand(statusCmd)
	rootCmd.AddCommand(supportCmd)
	rootCmd.AddCommand(uninstallNotifyCmd)
	rootCmd.AddCommand(userHelperCmd)
	rootCmd.AddCommand(desktopHelperCmd)
}

// Main is the shared entrypoint for both the breeze-agent and
// breeze-user-helper binaries. They build the same program from the same code
// but live in separate cmd/ packages so each can embed a different Windows
// manifest: breeze-agent ships requireAdministrator, breeze-user-helper ships
// asInvoker (it is spawned into the interactive user's non-elevated session).
// version is injected by each cmd wrapper via -X main.version.
func Main(v string) {
	// PAM Path B two-stage launch helper: when this process was re-exec'd as
	// SYSTEM into a target interactive session (carrying the
	// --pam-session-launch-helper sentinel), run the in-session launch stage
	// and exit before any normal startup. In every other invocation this
	// returns immediately. Must be first — before flag/arg parsing, Sentry, and
	// cobra dispatch — so the helper re-exec short-circuits cleanly. No-op on
	// non-Windows.
	pamactuator.MaybeRunSessionLaunchHelper()

	if v != "" {
		version = v
	}

	// Initialize Sentry as early as possible so panics during cobra
	// command dispatch are still captured. Init is best-effort: when
	// BREEZE_SENTRY_DSN is unset (self-host without telemetry), Init is
	// a no-op and the agent runs unchanged. Any init error is logged
	// and ignored — Sentry MUST NOT block agent startup.
	if err := observability.Init(version); err != nil {
		fmt.Fprintf(os.Stderr, "sentry init failed: %v\n", err)
	}
	defer observability.Flush(2 * time.Second)

	// Smoke-test hook for staging verification of the Sentry pipeline.
	// Operators set BREEZE_SMOKE_PANIC=1 on a staging agent to confirm a
	// panic event reaches the configured DSN. The deferred Flush above
	// ensures the event is transmitted before exit.
	if os.Getenv("BREEZE_SMOKE_PANIC") == "1" {
		panic("sentry-go-smoke: BREEZE_SMOKE_PANIC=1")
	}

	if filepath.Base(os.Args[0]) == "breeze-desktop-helper" {
		for i := 1; i < len(os.Args)-1; i++ {
			if os.Args[i] == "--context" {
				desktopContext = os.Args[i+1]
				break
			}
		}
		runDesktopHelper()
		return
	}

	// Quick Support clients are downloaded under a name that carries the
	// one-time code (breeze-support-<CODE>-<host>.exe) and are double-clicked,
	// so there is no subcommand on the command line. Dispatch to `support` by
	// basename.
	//
	// The second condition guards a future service copy launched with an
	// explicit `support --service-run` argv; without it the dispatch would
	// prepend a SECOND "support" and cobra would parse the duplicate as a
	// positional arg.
	if strings.HasPrefix(strings.ToLower(filepath.Base(os.Args[0])), "breeze-support") &&
		(len(os.Args) < 2 || os.Args[1] != "support") {
		rootCmd.SetArgs(append([]string{"support"}, os.Args[1:]...))
	}

	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// initLogging sets up structured logging from config. Call after config.Load().
func initLogging(cfg *config.Config) {
	var output io.Writer = os.Stdout
	logFileFallback := false
	var logFileFallbackReason string

	if cfg.LogFile != "" {
		rw, err := logging.NewRotatingWriter(cfg.LogFile, cfg.LogMaxSizeMB, cfg.LogMaxBackups)
		if err != nil {
			logFileFallbackReason = describeLogFileError(err)
			fmt.Fprintf(os.Stderr, "Failed to open log file %s: %s (logging to stdout)\n", cfg.LogFile, logFileFallbackReason)
			logFileFallback = true
		} else if !hasConsole() || cfg.SupportMode {
			// Support mode is file-only for a different reason than the
			// headless case below: the console IS the end user's status
			// window ("Waiting for your technician…"), and structured slog
			// lines interleaved with it look like an error to a
			// non-technical user. The lines still land in the workspace log
			// file, which is what the technician gets.
			// No console attached (Windows service, launchd daemon, or systemd
			// service). Use file-only logging — stdout may be invalid or already
			// redirected to a log destination by the init system. Using
			// io.MultiWriter with an invalid stdout would fail the first write
			// and short-circuit all subsequent log output.
			output = rw
		} else {
			output = logging.TeeWriter(os.Stdout, rw)
		}
	}

	logging.Init(cfg.LogFormat, cfg.LogLevel, output)
	// Re-bind package-level logger after Init
	log = logging.L("main")

	// Re-log fallback via structured logger so it appears in journalctl/Event Viewer
	if logFileFallback {
		log.Warn("log file fallback active, logging to stdout only", "requestedFile", cfg.LogFile, "reason", logFileFallbackReason)
	}
}

// agentComponents holds the running components created by startAgent so that
// service wrappers (Windows SCM, etc.) can shut them down gracefully.
type agentComponents struct {
	hb          *heartbeat.Heartbeat
	wsClient    *websocket.Client
	secureToken *secmem.SecureString

	// etwluaCancel cancels the ETW LUA subscriber goroutine and tears
	// down the Breeze-LUA-Discovery real-time ETW session. nil on
	// non-Windows or when ETW init was skipped/failed.
	etwluaCancel context.CancelFunc
	// etwluaDone closes after the ETW subscriber goroutine has fully
	// exited. Always non-nil (closed immediately when nothing was
	// started) so callers don't need a nil check.
	etwluaDone <-chan struct{}

	// supervisorCancel cancels long-lived supervisory goroutines started in
	// startAgent (currently: the Windows watchdog supervisor). nil on
	// platforms or run modes where no supervisor was started.
	supervisorCancel context.CancelFunc
	// supervisorDone closes after the supervisor goroutine has fully
	// exited. nil when supervisorCancel is nil.
	supervisorDone <-chan struct{}

	// unifiCancel cancels the UniFi deep-telemetry collector loop. nil when
	// the collector was not started (no ServerURL/AgentID).
	unifiCancel context.CancelFunc
	// unifiDone closes after the collector loop goroutine has fully exited.
	// nil when unifiCancel is nil.
	unifiDone <-chan struct{}

	// workspaceIndexCancel cancels the server-driven workspace indexing loop.
	// nil when the local kill switch disables the loop.
	workspaceIndexCancel context.CancelFunc
	// workspaceIndexDone closes after crawls and watchers have fully exited.
	// nil when workspaceIndexCancel is nil.
	workspaceIndexDone <-chan struct{}
}

// shutdownAgent gracefully stops all agent components.
//
// Every blocking stage is wrapped with a deadline so that a stuck HTTP flush
// (common during OS shutdown when the network has already gone down) can't pin
// the process past the service manager's stop timeout. Stages run
// sequentially, so their timeouts are additive — they are therefore drawn from
// one shared shutdownBudget rather than each being independent, and the whole
// function is bounded by that budget no matter how many stages apply. See the
// shutdown timing contract in shutdown_budget.go for how the budget relates to
// the unit's TimeoutStopSec (#3323).
func shutdownAgent(comps *agentComponents) {
	if comps == nil {
		return
	}

	clock := newShutdownClock(shutdownBudget)

	// The optional, platform/config-dependent component stops share a
	// sub-budget so they cannot starve the ungated core teardown below.
	components := clock.sub(componentStopBudget)

	// Cancel the ETW LUA subscriber FIRST so the kernel-side ETW
	// session is closed before any later teardown can time out and
	// orphan it. Otherwise Breeze-LUA-Discovery stays registered with
	// the kernel and the next agent restart hits the
	// "two callers on the same machine would conflict" failure from
	// NewETWSubscriber's doc comment.
	//
	// The cancels are issued unconditionally (they are non-blocking); only
	// the wait-for-exit is budgeted. That way a component always gets told to
	// stop even when the sub-budget has run out and we can't wait for it.
	if comps.etwluaCancel != nil {
		comps.etwluaCancel()
		if comps.etwluaDone != nil {
			components.run("etwlua stop", componentStopStage, func() {
				<-comps.etwluaDone
			})
		}
	}

	// Stop the UniFi collector loop so its in-flight controller/API HTTP work
	// is cancelled rather than abandoned, and the loop doesn't outlive the
	// agent's token across an in-process restart.
	if comps.unifiCancel != nil {
		comps.unifiCancel()
		if comps.unifiDone != nil {
			components.run("unifi collector stop", componentStopStage, func() {
				<-comps.unifiDone
			})
		}
	}

	// Cancel workspace indexing before core network teardown. A canceled crawl
	// attempts one terminal CompleteRun, but we do NOT wait out its 30s HTTP
	// timeout — the whole shutdown must fit the shared budget, and a missed
	// terminal flush self-heals server-side (the stale run is marked abandoned
	// on the next crawl start). The cap matches the sibling stages.
	if comps.workspaceIndexCancel != nil {
		comps.workspaceIndexCancel()
		if comps.workspaceIndexDone != nil {
			components.run("workspace index stop", componentStopStage, func() {
				<-comps.workspaceIndexDone
			})
		}
	}

	// Cancel the watchdog supervisor BEFORE we tell the watchdog the agent
	// is intentionally stopping. Otherwise the supervisor could race
	// in-flight and re-start a watchdog the SCM is mid-stop on.
	if comps.supervisorCancel != nil {
		comps.supervisorCancel()
		if comps.supervisorDone != nil {
			components.run("watchdog supervisor stop", componentStopStage, func() {
				<-comps.supervisorDone
			})
		}
	}

	// Write stopping state so the watchdog knows shutdown is intentional.
	statePath := state.PathInDir(config.ConfigDir())
	if err := state.Write(statePath, &state.AgentState{
		Status:    state.StatusStopping,
		Reason:    state.ReasonUserStop,
		PID:       os.Getpid(),
		Version:   version,
		Timestamp: time.Now(),
	}); err != nil {
		log.Warn("failed to write stopping state file", "error", err.Error())
	}

	// Notify the watchdog of intentional shutdown so it doesn't restart us.
	//
	// Budgeted, because this is a blocking socket write: ipc.Conn.Send arms a
	// 30s write deadline (internal/ipc/protocol.go), so a watchdog that has
	// stopped reading its end can park this call for longer than the entire
	// stop window on its own — the same class of unbounded step as the log
	// shipper, and enough to exhaust the whole budget before a single core
	// teardown stage starts. Abandoning it is safe: the stopping-state file
	// written just above is the durable signal the watchdog reconciles
	// against, and this notify is only the fast path.
	if broker := comps.hb.SessionBroker(); broker != nil {
		if sess := broker.PreferredSessionWithScope("watchdog"); sess != nil {
			clock.run("watchdog shutdown notify", watchdogNotifyBudget, func() {
				_ = sess.SendNotify("", ipc.TypeShutdownIntent, ipc.ShutdownIntent{
					Reason: state.ReasonUserStop,
				})
			})
		}
	}

	comps.hb.StopAcceptingCommands()

	// Drain MUST stay ahead of the two transport stops below: draining after
	// the websocket and heartbeat are torn down would strand whatever is in
	// flight. The inner ctx deadline is slightly longer than the stage cap so
	// ordering is deterministic — the stage timer fires first on a hung
	// DrainAndWait and logs the stage, then the still-running goroutine's ctx
	// aborts.
	clock.runCtx("drain in-flight commands", drainStageBudget, drainCtxGrace, comps.hb.DrainAndWait)

	clock.run("websocket stop", websocketStopBudget, comps.wsClient.Stop)
	clock.run("heartbeat stop", heartbeatStopBudget, comps.hb.Stop)

	// Zeroed unconditionally, including while an abandoned teardown goroutine
	// may still be running. That goroutine can then read an empty bearer token
	// and log a single warning instead of authenticating. This is accepted, and
	// predates the shared budget — runWithTimeout has always abandoned an
	// overrunning stage and fallen through to here. Wiping the secret is a
	// hard guarantee at a fixed point in shutdown; the call it degrades is a
	// best-effort one on a stage we already gave up waiting for, moments
	// before the process exits. Deferring the wipe to chase it would trade a
	// security property for a network call that is being dropped anyway.
	if comps.secureToken != nil {
		comps.secureToken.Zero()
	}
}

// runWithTimeout invokes fn on a goroutine and waits up to d for it to return.
// If fn exceeds the deadline, logs a warning and returns; fn continues in the
// background and is abandoned when the process exits. Used on the shutdown
// path where we prefer to drop work rather than let systemd SIGKILL us.
func runWithTimeout(name string, d time.Duration, fn func()) {
	done := make(chan struct{})
	go func() {
		defer close(done)
		fn()
	}()
	select {
	case <-done:
	case <-time.After(d):
		log.Warn("shutdown stage timed out, continuing", "stage", name, "timeout", d.String())
	}
}

// enforceBuildModeGate is startAgent's build-mode self-check, extracted as a
// named helper (mirroring checkPersistedServerAllowed/gateEnrollPrimary
// above) so the gap/strict decision is directly testable without invoking
// startAgent's full initialization (mTLS load, heartbeat bring-up, hardware
// collection). Logs the resolved build mode, then on a persisted-server
// violation either hard-refuses to start (strict — logs, prints an operator
// message, calls osExit(1), and returns the violation error as a
// belt-and-braces measure for a stubbed-osExit test) or warns and returns nil
// (gap — the migration-needed heartbeat signal covers this case; see
// migrationSignal). Self-host and an unenrolled/empty ServerURL always
// return nil (checkPersistedServerAllowed's contract).
func enforceBuildModeGate(cfg *config.Config) error {
	buildModeLogArgs := []any{"mode", hostpolicy.Mode()}
	if hostpolicy.Enforced() {
		buildModeLogArgs = append(buildModeLogArgs, "allowedHosts", hostpolicy.Hosts())
	}
	log.Info("control-plane build mode", buildModeLogArgs...)
	if err := checkPersistedServerAllowed(cfg); err != nil {
		if hostpolicy.Strict() {
			// Belt-and-braces: config.Load -> ValidateTiered already fatals
			// on a persisted out-of-allowlist ServerURL before any caller
			// reaches startAgent, but keeping an explicit refusal here makes
			// the invariant local to the function that actually starts
			// components, instead of depending on every caller having gone
			// through config.Load first.
			log.Error("hosted build refuses to run against this server", "error", err.Error())
			fmt.Fprintf(os.Stderr,
				"This is a Breeze hosted-edition build and cannot manage a self-hosted server.\n"+
					"Use the self-host build instead. Details: %v\n", err)
			osExit(1)
			return err
		}
		// Gap build: warn and keep running. The migration-needed signal
		// (Task 8) surfaces this on the self-hosted dashboard so the admin
		// can migrate before the strict build ships. Do NOT exit.
		log.Warn("hosted-edition agent is managing a self-hosted server; migrate to the self-host build before the enforced release",
			"error", err.Error())
	}
	return nil
}

// startAgent performs all agent initialisation assuming cfg is already
// enrolled. Returns the running components or an error if any
// initialization step fails (mTLS load, log shipper init, heartbeat
// bring-up, etc.). Callers (runAgent on console/Unix, the Windows
// service wrapper) MUST check config.IsEnrolled first and call
// waitForEnrollment if needed — this function no longer performs the
// enrollment check itself.
func startAgent(cfg *config.Config) (*agentComponents, error) {
	if !config.IsEnrolled(cfg) {
		return nil, fmt.Errorf("startAgent called with unenrolled config — caller must waitForEnrollment first")
	}

	// Build-mode self-check. Lives here — not in runAgent — because this is
	// the single choke point every entry point reaches: console/Unix via
	// runAgent's startAgentFn call, the Windows SCM service and the Unix
	// runAsService loop (both call startAgentFn directly), and the Quick
	// Support session in support.go. runAgent alone would miss the two
	// primary service deployment modes, which return into runAsService
	// before ever reaching runAgent's own body.
	if err := enforceBuildModeGate(cfg); err != nil {
		return nil, err
	}

	// Quick Support clients are throwaway, unelevated, and live entirely in a
	// temp workspace. They must never touch the machine-wide install: no
	// self-update (a support session outlives nothing), and every ProgramData
	// path below is skipped because a real permanently-installed agent may be
	// running on this same machine and owns those files. See runSupportSession.
	if cfg.SupportMode {
		cfg.AutoUpdate = false
	}

	// Loosen config directory (0755) and agent.yaml (0644) so the Helper can read
	// them. secrets.yaml stays root-only (0600). Skipped in support mode: this
	// operates on the REAL config dir, which a support client does not own.
	if !cfg.SupportMode {
		config.FixConfigPermissions()
	}

	initLogging(cfg)

	// Record this process's live PID immediately, before any startup step that
	// can wedge (e.g. the mTLS renewal network call below). Otherwise a wedge
	// leaves agent.state holding a prior run's dead PID, and the watchdog reads
	// that stale PID forever — reporting check.process_gone on a process that
	// is actually alive-but-wedged, and force-killing the wrong (dead) PID
	// instead of the live one. Status flips to StatusRunning at the end of
	// startup (below). Fields mirror that running-state write; LastHeartbeat
	// stays zero (watchdog treats zero as a startup grace period) exactly as
	// the running-state write does until the first heartbeat records it.
	// See #1029.
	//
	// NOT in support mode: agent.state lives in the machine-wide config dir
	// and is read by the watchdog as the live agent's PID. A throwaway
	// support client writing its own PID there would make the watchdog
	// supervise (and eventually force-kill) the wrong process, and would
	// report the real agent as gone the moment the support client exits.
	startupStatePath := state.PathInDir(config.ConfigDir())
	if !cfg.SupportMode {
		if err := state.Write(startupStatePath, &state.AgentState{
			Status:    state.StatusStarting,
			PID:       os.Getpid(),
			Version:   version,
			Timestamp: time.Now(),
		}); err != nil {
			log.Warn("failed to write startup state file", "error", err.Error())
		}
	}

	// Auto-clear Safe Mode BCD flag on startup to prevent reboot loops.
	// If the agent triggered a safe mode reboot, the safeboot BCD entry
	// persists until explicitly removed. Clear it so the next reboot is normal.
	// NOTE: Requires BreezeAgent to be registered under SafeBoot\Network in the
	// registry (see breeze.wxs) — otherwise the service won't start in safe mode.
	if safemode.IsSafeMode() {
		log.Warn("system is in Safe Mode — clearing safeboot BCD flag for normal reboot")
		if err := safemode.ClearSafeBootFlag(); err != nil {
			log.Error("failed to clear safeboot BCD flag, machine may be stuck in safe mode", "error", err.Error())
		} else {
			log.Info("safeboot BCD flag cleared, next reboot will be normal mode")
		}
	}

	// Wrap auth token in SecureString for defense-in-depth
	secureToken := secmem.NewSecureString(cfg.AuthToken)
	cfg.AuthToken = "" // Clear plaintext from config struct

	// Shared auth-failure monitor — gates heartbeat and log shipper
	// HTTP calls after 3 consecutive 401s so a deauthorized agent
	// stops spamming the API (#401).
	authMon := authstate.NewMonitor(3)

	// Initialize log shipper for centralized diagnostics.
	//
	// The shipper's URL is a provider, not a copied string: after a
	// backup-server-URL promotion (#2323) diagnostics must follow the promoted
	// primary instead of being shipped at the dead one for the rest of the
	// process lifetime — precisely when those logs are most wanted (#2463).
	// The heartbeat does not exist yet (it owns the promoted URL), so the
	// provider is seeded with the startup value and bound to hb.ServerURL
	// below, before the heartbeat starts.
	shipperServerURL := newServerURLProvider(cfg.ServerURL)
	if cfg.AgentID != "" && cfg.ServerURL != "" {
		logging.InitShipper(logging.ShipperConfig{
			ServerURL:    shipperServerURL.Get,
			AgentID:      cfg.AgentID,
			AuthToken:    secureToken,
			AgentVersion: version,
			HTTPClient:   nil, // will use default
			MinLevel:     cfg.LogShippingLevel,
			AuthMonitor:  authMon,
		})
		// Dev builds ship info-level logs for performance tuning and diagnostics.
		if strings.HasPrefix(version, "dev-") && cfg.LogShippingLevel == "warn" {
			logging.SetShipperLevel("info")
		}
		// desktop_debug forces info-level shipping so the chatty remote-desktop
		// diagnostics surface to the API. Leave off in production. See
		// docs/superpowers/plans/remote-desktop/2026-04-13-ice-turn-fallback-diagnostics.md.
		if cfg.DesktopDebug && (cfg.LogShippingLevel == "" || cfg.LogShippingLevel == "warn") {
			logging.SetShipperLevel("info")
		}
	}

	logProcessStartup(cachedMainProcessStartup())

	// Surface a failed systemd unit auto-heal (reconcileServiceUnitIfNeeded /
	// the reconcile-unit subcommand) to the fleet now that the log shipper is
	// up — those failure paths run before the shipper or in a transient unit
	// whose journal is GC'd, so they'd otherwise be invisible (#1201). No-op
	// off Linux and when there's nothing recorded.
	startReconcileFailureReporter()

	// Self-heal ProgramData ACL drift on the logs/data trees and warn the fleet
	// if the MSI HardenProgramDataAcl action was skipped or blocked (#1481).
	// Runs here, after the shipper is up, so the drift warning actually reaches
	// agent_logs — same constraint as the reconcile reporter above. No-op off
	// Windows and when the dirs are already hardened. Skipped in support mode:
	// an unelevated throwaway client has no business re-ACLing ProgramData.
	if !cfg.SupportMode {
		config.EnforceProgramDataTreePermissions()
	}

	// Load mTLS client certificate if configured
	var tlsCfg *tls.Config
	if cfg.MtlsCertPEM != "" {
		if mtls.IsExpired(cfg.MtlsCertExpires) {
			// FINAL-REVIEW I2: this used to synchronously call the LEGACY
			// bearer-only RenewCert here, with no recovery proof. That request
			// is denied outright under AGENT_MTLS_BINDING_MODE=enforce (an
			// expired active row requires a valid proof — see
			// evaluateRenewalAuthorization), and it also bypassed the
			// two-phase pending/confirm protocol and its durable staging
			// entirely, so a crash mid-renewal could strand a real Cloudflare
			// certificate with no local record.
			//
			// Renewal is now owned solely by the heartbeat's
			// maybeSelfInitiateCertRenewal, which runs at Start() and on every
			// tick: it presents the current certificate when it is still
			// valid, builds a proof-of-possession from the expired
			// certificate's private key when it is not, and stages the result
			// durably before confirming. Startup only needs to avoid loading a
			// dead certificate into the TLS config, so the agent runs
			// bearer-only for at most one tick while that completes.
			//
			// The private key is deliberately LEFT IN PLACE: it is the input
			// to the recovery proof. Clearing it here would destroy the only
			// thing that can re-establish this device's identity.
			// The certificate and key are deliberately LEFT IN PLACE rather
			// than cleared: the expired certificate's private key is the
			// input to the recovery proof, and MtlsCertPEM/MtlsCertExpires
			// are what tell the heartbeat there IS an identity to recover.
			// Clearing either (as this path used to, on renewal failure)
			// destroys the only thing that can re-establish this device's
			// identity and silently downgrades it to bearer-only forever.
			// Only the TLS config is skipped, so the expired certificate is
			// never presented in a handshake.
			log.Warn("mTLS certificate expired; running bearer-only until the heartbeat's recovery renewal completes",
				"expires", cfg.MtlsCertExpires)
		} else {
			var err error
			tlsCfg, err = mtls.BuildTLSConfig(cfg.MtlsCertPEM, cfg.MtlsKeyPEM)
			if err != nil {
				log.Error("failed to load mTLS certificate, continuing without mTLS", "error", err.Error())
				tlsCfg = nil
			} else if tlsCfg != nil {
				log.Info("mTLS client certificate loaded")
			}
		}
	}

	// Propagate service/headless flags. On Windows, desktop sessions route
	// through the IPC user helper. On macOS, the daemon handles desktop
	// directly but uses IPC for user-context operations (run_as_user, helper).
	//
	// Support mode pins BOTH to false: the client is a plain foreground
	// process owning the interactive desktop, so desktop capture takes the
	// in-process path and no SYSTEM/user helper has to be spawned or
	// installed. Pinning here (rather than only in runSupportSession) means a
	// probe misfiring — isHeadless() on a double-clicked .exe with no attached
	// console is the realistic one — cannot silently reroute capture through
	// IPC to a helper that does not exist.
	cfg.IsService = isWindowsService() && !cfg.SupportMode
	cfg.IsHeadless = isHeadless() && !cfg.SupportMode

	// Ensure SAS (Ctrl+Alt+Del) policy allows services to generate it.
	// Only relevant on Windows when running as a service.
	if cfg.IsService {
		ensureSASPolicy()
	}

	// Never in support mode: provisioning a dormant elevation account is a
	// permanent machine change, and the client is unelevated anyway.
	if cfg.PAMEnabled && runtime.GOOS == "windows" && !cfg.SupportMode {
		if err := elevaccount.New().EnsureProvisioned(); err != nil {
			log.Warn("failed to provision PAM dormant elevation account, continuing",
				"error", err.Error())
		}
		logPAMActuatorStrategy(log, cfg.PAMActuatorStrategy)
	}

	if cfg.IsHeadless {
		log.Info("running in headless/daemon mode (no console attached)")
	}

	// Start heartbeat - this implements the main agent run loop
	hb := heartbeat.NewWithVersion(cfg, version, secureToken, tlsCfg)
	hb.SetAuthMonitor(authMon)
	if !cfg.SupportMode {
		for _, result := range preparePAMLifetimeStartup(context.Background(), hb, startupStatePath) {
			log.Info("PAM lifetime startup reconciliation evidence",
				"actuationId", result.ActuationID,
				"generation", result.Generation,
				"state", result.State,
				"failureCode", result.FailureCode,
				"bootId", result.Evidence.BootID)
		}
	}

	// Point the log shipper at the heartbeat's promoted-URL getter (#2463).
	// This MUST happen before hb.Start(): the heartbeat is the only thing that
	// can promote a backup URL, so binding first means there is no window in
	// which a promotion could land while the shipper still holds the startup
	// value.
	shipperServerURL.Bind(hb.ServerURL)

	// Log agent start audit event (nil-safe: Log() is a no-op on nil receiver)
	hb.AuditLog().Log(audit.EventAgentStart, "", map[string]any{
		"version": version,
		"agentId": cfg.AgentID,
	})

	go hb.Start()

	// Start WebSocket client for real-time command delivery
	wsConfig := &websocket.Config{
		ServerURL: cfg.ServerURL,
		AgentID:   cfg.AgentID,
		AuthToken: secureToken,
		TLSConfig: tlsCfg,
	}
	wsClient := websocket.New(wsConfig, hb.HandleCommand)
	hb.SetWebSocketClient(wsClient)
	go wsClient.Start()

	// UniFi Phase 2a: read-only deep-telemetry collector. Polls each assigned
	// on-site UniFi controller's local Network Integration API and uploads
	// per-device PoE/health + client telemetry. Runs for the agent process
	// lifetime and no-ops until the server assigns collectors to this device.
	//
	// Off in support mode: a client that exists to serve one screen-share
	// session has no business polling the customer's network gear.
	var unifiCancel context.CancelFunc
	var unifiDone <-chan struct{}
	if cfg.ServerURL != "" && cfg.AgentID != "" && !cfg.SupportMode {
		var unifiCtx context.Context
		// Scope the loop to a cancellable context registered in agentComponents
		// so shutdownAgent stops it. context.Background() here would never cancel:
		// on self-update/config-reload the orphaned loop keeps polling with a
		// zeroed token and spins auth-failure logs (same class as ETW PR #959).
		unifiCtx, unifiCancel = context.WithCancel(context.Background())
		unifiDone = unifi.StartCollectorLoop(unifiCtx, unifi.CollectorDeps{
			// URL provider, not a copied string: after backup-server-URL
			// promotion (#2323) uploads must follow the promoted primary
			// instead of POSTing to the dead one forever (#2423).
			APIBaseURL: hb.ServerURL,
			AgentID:    cfg.AgentID,
			HTTP:       newUnifiAPIClient(secureToken, tlsCfg),
			// Loop failures here are config-fetch / telemetry-upload errors —
			// operationally significant and, unlike poll errors, never surface
			// via the ingest worker. Log at Warn so the log shipper (MinLevel
			// warn) actually delivers them; Debug was invisible in the field.
			Logf: func(format string, args ...any) { log.Warn(fmt.Sprintf(format, args...)) },
		})
	}

	var workspaceIndexCancel context.CancelFunc
	var workspaceIndexDone <-chan struct{}
	if cfg.SupportMode {
		// Crawling and indexing the customer's filesystem is exactly the kind
		// of thing an ad-hoc support client must never do.
		log.Debug("workspace indexing disabled in Quick Support mode")
	} else if cfg.WorkspaceIndex.Enabled != nil && !*cfg.WorkspaceIndex.Enabled {
		log.Debug("workspace indexing disabled by local configuration")
	} else {
		workspaceClient := workspaceindex.NewClient(workspaceindex.ClientConfig{
			// URL provider, not a copied string — see the UniFi collector
			// wiring above (#2423).
			ServerURL:    hb.ServerURL,
			EndpointBase: cfg.WorkspaceIndex.EndpointBase,
			AuthToken:    secureToken,
			HTTPClient:   newUnifiAPIClient(secureToken, tlsCfg),
			AuthMonitor:  authMon,
		})
		var workspaceIndexCtx context.Context
		workspaceIndexCtx, workspaceIndexCancel = context.WithCancel(context.Background())
		workspaceIndexDeps := workspaceindex.Deps{Client: workspaceClient}
		// Device-audit trace for server-driven indexing activation (#2425).
		// Assign only a non-nil logger: a nil *audit.Logger stored in the
		// AuditLogger interface is a TYPED nil, which passes `!= nil` and would
		// make the loop's audit guard silently decorative.
		if auditLog := hb.AuditLog(); auditLog != nil {
			workspaceIndexDeps.Audit = auditLog
		}
		workspaceIndexDone = workspaceindex.StartLoop(workspaceIndexCtx, workspaceIndexDeps)
	}

	// PAM Track 3: subscribe to Microsoft-Windows-LUA ETW provider for
	// UAC consent discovery. Windows-only; no-op stub on other platforms
	// (see etwlua_start_other.go). ctx scoped to the agent process so
	// shutdownAgent can tear down the ETW session cleanly.
	// context.Background() (the old call) never cancels — defer
	// sub.Stop() at etwlua.Start exit-path never fires and the real-time
	// ETW session leaks across agent restarts (PR #959 review, blocker 1).
	//
	// A real-time kernel ETW session is process-global and machine-wide (two
	// callers conflict — see NewETWSubscriber), so a support client must never
	// open one alongside the installed agent.
	etwCtx, etwCancel := context.WithCancel(context.Background())
	var etwluaDone <-chan struct{}
	if cfg.SupportMode {
		closed := make(chan struct{})
		close(closed)
		etwluaDone = closed
	} else {
		etwluaDone = startETWLua(etwCtx, hb)
	}

	log.Info("agent is running")

	// Write state file so the watchdog can detect a running agent. Support
	// mode never writes or registers it — see the startup-state write above.
	if !cfg.SupportMode {
		statePath := state.PathInDir(config.ConfigDir())
		if err := state.Write(statePath, &state.AgentState{
			Status:    state.StatusRunning,
			PID:       os.Getpid(),
			Version:   version,
			Timestamp: time.Now(),
		}); err != nil {
			log.Warn("failed to write agent state file", "error", err.Error())
		}

	}

	// Mutual supervision: on Windows, when running as the SCM service this
	// agent process supervises BreezeWatchdog the same way BreezeWatchdog
	// supervises us. On macOS/Linux the OS service managers (launchd
	// KeepAlive, systemd Restart=always) already do this — and although
	// LaunchDaemons report cfg.IsService=true via service_unix.go:21-26,
	// startWatchdogSupervisor is a no-op stub on non-Windows builds, so
	// gating on cfg.IsService here is safe across platforms.
	//
	// Support mode is doubly excluded (it always runs with IsService=false):
	// there is no watchdog to supervise, and installing one is precisely the
	// "permanently installed" outcome Quick Support promises not to produce.
	var supervisorCancel context.CancelFunc
	var supervisorDone <-chan struct{}
	if cfg.IsService && !cfg.SupportMode {
		supCtx, supCancel := context.WithCancel(context.Background())
		supervisorCancel = supCancel
		supervisorDone = startWatchdogSupervisor(supCtx)
	}

	return &agentComponents{
		hb:                   hb,
		wsClient:             wsClient,
		secureToken:          secureToken,
		etwluaCancel:         etwCancel,
		etwluaDone:           etwluaDone,
		supervisorCancel:     supervisorCancel,
		supervisorDone:       supervisorDone,
		unifiCancel:          unifiCancel,
		unifiDone:            unifiDone,
		workspaceIndexCancel: workspaceIndexCancel,
		workspaceIndexDone:   workspaceIndexDone,
	}, nil
}

// logPAMActuatorStrategy logs, once at startup, which PAM elevation actuator
// strategy is resolved for this agent — the VM validation matrix depends on
// being able to confirm "token_launch strategy is active" from the logs
// alone. It also warns when the configured value is a non-empty string that
// doesn't match a known strategy (e.g. a typo like "token-launch"), since
// pamActuatorStrategy() silently falls back to sendinput in that case and the
// mismatch would otherwise be invisible. Deliberately minimal: called once
// per agent start, never per-actuation.
func logPAMActuatorStrategy(l *slog.Logger, configured string) {
	switch pamactuator.Strategy(configured) {
	case pamactuator.StrategySendInput, pamactuator.StrategyTokenLaunch:
		l.Info("pam actuator strategy resolved", "strategy", configured)
	case "":
		l.Info("pam actuator strategy resolved", "strategy", string(pamactuator.StrategySendInput))
	default:
		l.Warn("pam_actuator_strategy is not a recognized strategy, falling back to sendinput",
			"configuredStrategy", configured)
	}
}

// runAgent starts the main agent run loop. The heartbeat module handles:
// - Periodic heartbeat calls to the API endpoint
// - Receiving pending commands from the server via heartbeat response
// - Executing commands and reporting results back to the server
func runAgent() {
	serviceMode := isWindowsService()
	startup := currentProcessStartup("run", "", serviceMode)
	cacheMainProcessStartup(startup)
	guard, err := acquireMainAgentGuardFn(startup)
	if err != nil {
		writeInstanceGuardMarkerFn(startup, err)
		if errors.Is(err, ErrMainAgentAlreadyRunning) {
			fmt.Fprintf(
				os.Stderr,
				"Breeze main agent is already running (pid=%d session=%d mode=%s)\n",
				startup.PID,
				startup.WindowsSessionID,
				startup.LaunchMode,
			)
			mainAgentExitFn(exitAlreadyRunning)
			return
		}
		fmt.Fprintf(os.Stderr, "Breeze main-agent instance guard failed: %v\n", err)
		mainAgentExitFn(exitInstanceGuardError)
		return
	}
	defer guard.Close()

	// Self-heal the installed service unit from older installs (launchd plists on
	// macOS; systemd unit on Linux) after a binary-only auto-update.
	reconcileServiceUnitIfNeededFn()

	// On Windows, if launched by the SCM, run under the service framework
	// so we report Running/Stopped status back to the SCM correctly. The
	// service wrapper owns its own config loading, enrollment check, and
	// cancellation via the SCM request channel.
	if serviceMode {
		if err := runAsService(cfgFile); err != nil {
			log.Error("service failed", "error", err.Error())
			mainAgentExitFn(1)
		}
		return
	}

	// Console / Unix service-manager mode. Load config, prepare bootstrap
	// logging, and wait for enrollment if needed. signal.NotifyContext
	// wires SIGINT/SIGTERM to ctx so Ctrl+C in a terminal and
	// `systemctl stop` / `launchctl kickstart -k` all cancel any active
	// wait cleanly.
	cfg, err := config.Load(cfgFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to load config: %v\n", err)
		os.Exit(1)
	}
	initBootstrapLogging(cfg)

	ctx, stop := signal.NotifyContext(context.Background(),
		os.Interrupt, syscall.SIGTERM)
	defer stop()

	if !config.IsEnrolled(cfg) {
		cfg = waitForEnrollmentFn(ctx, cfgFile)
		if cfg == nil {
			log.Info("agent shutting down without enrollment",
				"reason", ctx.Err().Error())
			return
		}
	}

	comps, err := startAgentFn(cfg)
	if err != nil {
		if isPermissionError(err) {
			fmt.Fprintln(os.Stderr, "Error: Permission denied reading agent configuration.")
			fmt.Fprintln(os.Stderr, "The agent runs as a system service and should not be started manually.")
			fmt.Fprintln(os.Stderr, "Check service status with:")
			switch runtime.GOOS {
			case "darwin":
				fmt.Fprintln(os.Stderr, "  sudo breeze-agent status")
				fmt.Fprintln(os.Stderr, "  sudo launchctl list | grep breeze")
			case "linux":
				fmt.Fprintln(os.Stderr, "  sudo breeze-agent status")
				fmt.Fprintln(os.Stderr, "  sudo systemctl status breeze-agent")
			default:
				fmt.Fprintln(os.Stderr, "  Try running with elevated privileges (e.g. sudo).")
			}
			os.Exit(1)
		}
		fmt.Fprintf(os.Stderr, "Failed to start agent: %v\n", err)
		os.Exit(1)
	}
	// StopShipper waits on the shipper goroutine with no deadline of its own,
	// and that goroutine can be parked on a 30s HTTP POST — twice the whole
	// stop window — precisely on the hosts this matters for (network already
	// down during OS shutdown). Unbounded it defeats shutdownAgent's budget,
	// since it runs after shutdownAgent returns (#3323).
	defer func() {
		runWithTimeout("log shipper flush", shipperFlushBudget, logging.StopShipper)
	}()

	// Wait for ctx to be cancelled — SIGINT or SIGTERM via
	// signal.NotifyContext above. Behaviour change: console-mode
	// breeze-agent now treats SIGINT as shutdown instead of ignoring
	// it. The Windows service path is unaffected (SCM signals arrive
	// via the request channel, not Unix signals).
	<-ctx.Done()
	log.Info("shutting down agent", "reason", ctx.Err().Error())

	shutdownAgent(comps)
	log.Info("agent stopped")
}

// enrollDevice handles the enrollment process to register this agent with
// the Breeze server. Respects --force (re-enroll over existing config) and
// --quiet (suppress stdout progress, errors still go to stderr). Writes
// structured logs to the agent log file so MSI-initiated enrollments leave
// the same diagnostic trail as service-initiated ones.
// trimEnrollInputs strips whitespace from the three enrollment argument
// values the MSI passes on the command line. Template MSIs (served by the
// installerBuilder API) space-pad SERVER_URL / ENROLLMENT_KEY /
// ENROLLMENT_SECRET to a fixed 512-char width so the API can byte-patch
// them in-place without relocating any other MSI structures. The padding
// survives argv all the way to this function, and url.Parse rejects
// trailing spaces in a host name — the old PowerShell wrapper trimmed the
// values before exec, and the direct-exe CA has to do the same here.
func trimEnrollInputs(key, server, secret string) (string, string, string) {
	return strings.TrimSpace(key), strings.TrimSpace(server), strings.TrimSpace(secret)
}

// resolveBackupServerURL selects and validates the backup control-plane URL
// seeded during enrollment. The enrollment response takes precedence over the
// bootstrap response; an invalid seed or one matching the primary URL is
// discarded rather than persisted into the fresh agent config. A non-nil
// error means a candidate seed existed but failed validation — callers log
// it; it must never fail enrollment.
func resolveBackupServerURL(enrollSeed, bootstrapSeed, primaryServerURL string) (string, error) {
	seed := enrollSeed
	if seed == "" {
		seed = bootstrapSeed
	}
	if seed == "" || seed == primaryServerURL {
		return "", nil
	}
	if err := config.ValidateBackupServerURL(seed); err != nil {
		return "", err
	}
	return seed, nil
}

// gateEnrollResponseBackup refuses, in a hosted build, an enroll response
// backup control-plane URL outside the compiled allowlist. It runs on the
// RAW response field, BEFORE resolveBackupServerURL's precedence/validation
// logic — exactly where gateRedeemResponse checks res.BackupServerURL in
// bootstrap.go — and is gated at Enforced() tier (gap AND strict), not
// ValidateBackupServerURL's Strict()-only gate on the EXISTING-fleet paths it
// guards (heartbeat configUpdate push, self-heal). Running before
// resolveBackupServerURL matters: that function's own ValidateBackupServerURL
// call already soft-drops (warn + skip) a non-allowlisted backup under
// Strict(), which would otherwise swallow this gate's hard refusal in a
// strict build. Fresh enrollment is a fresh-install path, matching
// gateBootstrapServer/gateRedeemResponse/gateEnrollPrimary. No-op in
// self-host and when the response carries no backup.
func gateEnrollResponseBackup(backup string) error {
	if backup == "" {
		return nil
	}
	return hostpolicy.AllowedURL(backup)
}

// applyEnrollResponseIdentity copies the identity/credential fields an
// EnrollResponse carries into cfg: AgentID, AuthToken, WatchdogAuthToken,
// HelperAuthToken, OrgID, SiteID, and DeviceID.
//
// DeviceID (security remediation Wave 5 Task 5) is the server's devices.id
// UUID — distinct from AgentID/devices.agent_id — and is required to build
// the expired-certificate mTLS renewal recovery proof
// (mtls.BuildRenewalProofCanonicalBytes / config.Config.DeviceID). The
// enrollment route has always returned it; nothing previously copied it into
// the agent's persisted config, which left recovery-proof signing silently
// unavailable end-to-end even though every other piece was wired up and
// tested. Extracted as a named helper, mirroring
// resolveBackupServerURL/assertHostnameNonEmpty above, so it's unit-testable
// without going through enrollDevice's os.Exit-on-error call chain.
func applyEnrollResponseIdentity(cfg *config.Config, enrollResp *api.EnrollResponse) {
	cfg.AgentID = enrollResp.AgentID
	cfg.AuthToken = enrollResp.AuthToken
	cfg.WatchdogAuthToken = enrollResp.WatchdogAuthToken
	cfg.HelperAuthToken = enrollResp.HelperAuthToken
	cfg.OrgID = enrollResp.OrgID
	cfg.SiteID = enrollResp.SiteID
	cfg.DeviceID = enrollResp.DeviceID
}

// assertHostnameNonEmpty enforces the #439 contract: enrollment must
// never proceed with an empty or whitespace-only hostname, because the
// downstream substitution used to write the device UUID there and
// operators couldn't tell real rows from synthetic ones. Returns nil
// iff info is non-nil and info.Hostname has at least one non-whitespace
// character. Exists as a named helper so it's unit-testable — the call
// site in enrollDevice goes through enrollError which calls os.Exit
// and can't be exercised directly from a test.
func assertHostnameNonEmpty(info *collectors.SystemInfo) error {
	if info == nil || strings.TrimSpace(info.Hostname) == "" {
		return errors.New("empty hostname after fallback chain")
	}
	return nil
}

// checkPersistedServerAllowed is a pure predicate: it reports the violation
// when a hosted build (Enforced) has a persisted primary cfg.ServerURL
// outside the compiled allowlist. It does NOT decide warn-vs-hard-fail —
// that split is made by the caller in startAgent, gated on hostpolicy.Strict().
// Empty server (unenrolled) and self-host builds always return nil.
func checkPersistedServerAllowed(cfg *config.Config) error {
	if cfg == nil || cfg.ServerURL == "" {
		return nil
	}
	return hostpolicy.AllowedURL(cfg.ServerURL)
}

// gateEnrollPrimary refuses, in a hosted build, a primary control-plane
// server URL outside the compiled allowlist. serverURL is the one package
// global fed by all three primary-server entry points — filename,
// MSI property, and --server — so this single gate at the point it is
// applied to cfg covers all of them. (The enroll *response* carries no
// primary ServerURL — api.EnrollResponse has only BackupServerURL — so
// there is no second gate needed on the response side, unlike bootstrap's
// gateRedeemResponse.) No-op in self-host builds. Mirrors
// gateBootstrapServer/gateRedeemResponse in bootstrap.go.
func gateEnrollPrimary(server string) error {
	return hostpolicy.AllowedURL(server)
}

func enrollDevice(enrollmentKey string) {
	enrollmentKey, serverURL, enrollmentSecret = trimEnrollInputs(
		enrollmentKey, serverURL, enrollmentSecret,
	)

	cfg, err := config.Load(cfgFile)
	if err != nil {
		cfg = config.Default()
	}

	if serverURL != "" {
		// Gated here, before cfg.ServerURL is ever set: at this point in
		// enrollDevice, logging has not been initialised yet (initEnrollLogging
		// / the scoped enrollLog are set up a few lines below), so this uses
		// enrollError — the function's existing four-sink failure reporter,
		// which logs through the package-level `log` var rather than the
		// not-yet-initialised enrollLog — exactly as the "server URL required"
		// pre-flight check below does. catConfig is correct here: like that
		// check, this fires before any HTTP call is made, so isRefundable4xx
		// correctly treats it as non-refundable.
		if err := gateEnrollPrimary(serverURL); err != nil {
			enrollError(catConfig, "control-plane host not allowed", err)
			return // enrollError does not return in production; belt-and-braces.
		}
		cfg.ServerURL = serverURL
	}

	// Initialise logging so this enrollment leaves a record in agent.log.
	// In quiet mode, force file-only output — errors still reach stderr
	// via explicit fmt.Fprintln calls at error sites below.
	initEnrollLogging(cfg, quietEnroll)

	enrollLog := logging.L("enroll")

	// Clear any stale enroll-last-error.txt from a previous failed
	// attempt BEFORE any validation or early return. Every attempt
	// starts from a clean marker state; a validation failure later
	// in this function must not leave a stale file behind (spec
	// decision 8, issue #411).
	clearEnrollLastError()

	if cfg.ServerURL == "" {
		enrollError(catConfig,
			"server URL required — pass --server or set it in config",
			nil)
	}

	if cfg.AgentID != "" && !forceEnroll {
		enrollLog.Info("agent already enrolled, skipping (use --force to re-enroll)",
			"agentId", cfg.AgentID,
			"server", cfg.ServerURL)
		if !quietEnroll {
			fmt.Printf("Agent is already enrolled with ID: %s\n", cfg.AgentID)
			fmt.Println("Use --force to re-enroll, or delete the config file.")
		}
		return // exit 0 — not an error, allows && chains and MSI CAs to continue
	}

	if cfg.AgentID != "" && forceEnroll {
		enrollLog.Warn("force re-enrollment — existing AgentID will be overwritten on success",
			"previousAgentId", cfg.AgentID,
			"server", cfg.ServerURL)
	}

	secret := enrollmentSecret
	if secret == "" {
		secret = os.Getenv("BREEZE_AGENT_ENROLLMENT_SECRET")
	}

	if err := enrollWithConfig(cfg, cfgFile, enrollmentKey, secret); err != nil {
		var failure *enrollFailure
		if errors.As(err, &failure) {
			enrollError(failure.cat, failure.friendly, failure.detail)
		} else {
			// Unreachable in production: enrollWithConfig only ever returns
			// *enrollFailure. Kept so a future edit that returns a bare error
			// still exits through the four-sink reporter instead of silently
			// falling through to the "start the agent with" guidance below.
			enrollError(catUnknown, err.Error(), nil)
		}
		return // enrollError does not return in production; belt-and-braces.
	}

	if isSystemServiceRunning() {
		if !quietEnroll {
			fmt.Println("Agent is already running via system service.")
		}
	} else if runtime.GOOS == "darwin" || runtime.GOOS == "linux" {
		if !quietEnroll {
			fmt.Println("Start the agent with:")
			fmt.Println("  sudo breeze-agent service start")
		}
	} else {
		if !quietEnroll {
			fmt.Println("Run 'breeze-agent start' to start the agent.")
		}
	}
}

// enrollFailure carries an enrollment failure's category and user-facing
// message out of enrollWithConfig so the caller can report it through
// enrollError (four sinks + category-specific exit code) exactly as the
// inline code used to. It exists because enrollWithConfig is shared with
// Quick Support mode (support.go), which must NOT exit the process on a
// failure — it has its own console to talk to the end user through.
type enrollFailure struct {
	cat      enrollErrCategory
	friendly string
	detail   error
}

func (e *enrollFailure) Error() string {
	if e.detail != nil {
		return fmt.Sprintf("%s (%v)", e.friendly, e.detail)
	}
	return e.friendly
}

func (e *enrollFailure) Unwrap() error { return e.detail }

// enrollWithConfig is the core of enrollment: collect system + hardware
// identity, POST /agents/enroll, apply the response to cfg, and persist it to
// cfgFile (agent.yaml + the sibling root-only secrets.yaml).
//
// This is a verbatim extraction of enrollDevice's core so the `enroll`
// command and Quick Support mode enroll through exactly one code path. The
// only behavioural difference from the inline version is that failures are
// RETURNED (as *enrollFailure) instead of calling enrollError inline;
// enrollDevice immediately forwards them to enrollError, so the CLI command's
// messages, sinks and exit codes are unchanged.
//
// The enrollment secret is a parameter rather than being read from the
// enrollmentSecret flag / BREEZE_AGENT_ENROLLMENT_SECRET here, because
// support mode presents a PER-KEY secret unique to its session. Everything
// else still reads the package-level command flags (quietEnroll,
// enrollDeviceRole, backupServerURL) — only one command runs per process.
func enrollWithConfig(cfg *config.Config, cfgFile, enrollmentKey, secret string) error {
	enrollLog := logging.L("enroll")

	enrollLog.Info("starting enrollment", "server", cfg.ServerURL)
	if !quietEnroll {
		fmt.Printf("Enrolling with server: %s\n", cfg.ServerURL)
	}

	hwCollector := collectors.NewHardwareCollector()

	systemInfo, err := hwCollector.CollectSystemInfo()
	if err != nil {
		enrollLog.Warn("system info collection failed, using defaults", "error", err.Error())
		fmt.Fprintf(os.Stderr, "Warning: Failed to collect system info: %v\n", err)
		systemInfo = &collectors.SystemInfo{}
	}

	// WMIC-based hardware collection can take ~75s on Windows, which would
	// block enrollment under an MSI custom action. Fall back to defaults
	// after 10s; heartbeat will populate full hardware info later.
	hardwareInfo := &collectors.HardwareInfo{}
	hwDone := make(chan *collectors.HardwareInfo, 1)
	go func() {
		info, hwErr := hwCollector.CollectHardware()
		if hwErr != nil {
			// Can't use enrollLog here — this goroutine may still be running
			// after enrollDevice has returned or called os.Exit. stderr is
			// safe from any goroutine and lands in the MSI install.log.
			fmt.Fprintf(os.Stderr, "Warning: Hardware collection failed: %v; using defaults for enrollment\n", hwErr)
			hwDone <- &collectors.HardwareInfo{}
			return
		}
		hwDone <- info
	}()
	select {
	case info := <-hwDone:
		hardwareInfo = info
	case <-time.After(10 * time.Second):
		enrollLog.Warn("hardware collection timed out, using defaults for enrollment")
		fmt.Fprintln(os.Stderr, "Warning: Hardware collection timed out; using defaults for enrollment")
	}

	enrollLog.Info("collected system info",
		"hostname", systemInfo.Hostname,
		"os", systemInfo.OSVersion,
		"arch", systemInfo.Architecture)
	if !quietEnroll {
		fmt.Printf("Hostname: %s\n", systemInfo.Hostname)
		fmt.Printf("OS: %s (%s)\n", systemInfo.OSVersion, systemInfo.Architecture)
	}

	// Refuse to enroll with an empty hostname rather than let a fallback
	// downstream (or an older server) substitute the device UUID. See
	// issue #439 — one prod device ended up with its UUID in the hostname
	// column, which is worse than a loud failure because it looks legit.
	if err := assertHostnameNonEmpty(systemInfo); err != nil {
		return &enrollFailure{cat: catConfig, friendly: "hostname resolution failed on this machine — tried " +
			collectors.HostnameSourcesDescription() +
			"; all returned empty. Refusing to enroll with an empty hostname.", detail: err}
	}

	// Carry any existing device token into the enroll client. On a fresh
	// enroll cfg.AuthToken is empty (no-op); on `--force` re-enroll it holds
	// the token loaded from secrets.yaml, which Enroll presents as
	// x-agent-reenrollment-token so the server re-enrolls the existing device
	// row instead of 409-ing on a hostname collision with the agent's own
	// active row (e.g. after a rename/re-image). See #1028.
	client := api.NewClient(cfg.ServerURL, cfg.AuthToken, cfg.AgentID)

	deviceRole := enrollDeviceRole
	if deviceRole == "" {
		deviceRole = collectors.ClassifyDeviceRole(systemInfo, hardwareInfo)
	}
	enrollLog.Info("classified device role", "role", deviceRole)
	if !quietEnroll {
		fmt.Printf("Device role: %s\n", deviceRole)
	}

	// Orthogonal virtualization attribute (issue #1387): is this a VM, and on
	// what hypervisor. Derived from the hardware identity strings already
	// collected above; a virtual box keeps its role-based policies.
	virt := collectors.ClassifyVirtualization(hardwareInfo)
	if virt.IsVirtual {
		enrollLog.Info("detected virtualization", "platform", virt.Platform)
		if !quietEnroll {
			fmt.Printf("Virtualization: %s\n", virt.Platform)
		}
	}

	enrollReq := &api.EnrollRequest{
		EnrollmentKey:          enrollmentKey,
		EnrollmentSecret:       secret,
		Hostname:               systemInfo.Hostname,
		OSType:                 systemInfo.OSType,
		OSVersion:              systemInfo.OSVersion,
		Architecture:           systemInfo.Architecture,
		AgentVersion:           version,
		DeviceRole:             deviceRole,
		IsVirtual:              virt.IsVirtual,
		VirtualizationPlatform: virt.Platform,
		HardwareInfo: &api.HardwareInfo{
			CPUModel:                hardwareInfo.CPUModel,
			CPUCores:                hardwareInfo.CPUCores,
			CPUThreads:              hardwareInfo.CPUThreads,
			RAMTotalMB:              hardwareInfo.RAMTotalMB,
			DiskTotalGB:             hardwareInfo.DiskTotalGB,
			GPUModel:                hardwareInfo.GPUModel,
			SerialNumber:            hardwareInfo.SerialNumber,
			Manufacturer:            hardwareInfo.Manufacturer,
			Model:                   hardwareInfo.Model,
			MotherboardManufacturer: hardwareInfo.MotherboardManufacturer,
			MotherboardProduct:      hardwareInfo.MotherboardProduct,
			MotherboardVersion:      hardwareInfo.MotherboardVersion,
			BIOSVersion:             hardwareInfo.BIOSVersion,
		},
	}

	enrollLog.Info("sending enrollment request")
	if !quietEnroll {
		fmt.Println("Sending enrollment request...")
	}

	enrollResp, err := client.Enroll(enrollReq)
	if err != nil {
		cat, friendly := classifyEnrollError(err, cfg.ServerURL)
		return &enrollFailure{cat: cat, friendly: friendly, detail: err}
	}

	applyEnrollResponseIdentity(cfg, enrollResp)

	// Refused, in a hosted build, BEFORE resolveBackupServerURL's own
	// Strict()-only validation gets a chance to soft-drop it — see
	// gateEnrollResponseBackup's doc comment. bootstrapServerURL (the
	// fallback seed below) needs no separate gate here: it only ever arrives
	// via the bootstrap flow, which already hard-refused it through
	// gateRedeemResponse before enrollDevice ever ran.
	if err := gateEnrollResponseBackup(enrollResp.BackupServerURL); err != nil {
		return &enrollFailure{cat: catConfig, friendly: "enrollment refused: backup control-plane host not allowed", detail: err}
	}

	// Backup control-plane URL (#2288): enroll response wins; bootstrap value
	// is the fallback. Validated before persisting — a bad value must not
	// poison a fresh enrollment.
	resolvedBackupURL, backupSeedErr := resolveBackupServerURL(enrollResp.BackupServerURL, backupServerURL, cfg.ServerURL)
	if backupSeedErr != nil {
		enrollLog.Warn("dropped invalid backup server URL seed from enrollment", "error", backupSeedErr)
	}
	if resolvedBackupURL != "" {
		cfg.BackupServerURL = resolvedBackupURL
	}

	if enrollResp.Config.HeartbeatIntervalSeconds > 0 {
		cfg.HeartbeatIntervalSeconds = enrollResp.Config.HeartbeatIntervalSeconds
	}
	if enrollResp.Config.MetricsCollectionIntervalSeconds > 0 {
		cfg.MetricsIntervalSeconds = enrollResp.Config.MetricsCollectionIntervalSeconds
	}
	if len(enrollResp.Config.EnabledCollectors) > 0 {
		cfg.EnabledCollectors = enrollResp.Config.EnabledCollectors
	}

	if enrollResp.Mtls != nil {
		cfg.MtlsCertPEM = enrollResp.Mtls.Certificate
		cfg.MtlsKeyPEM = enrollResp.Mtls.PrivateKey
		cfg.MtlsCertExpires = enrollResp.Mtls.ExpiresAt
		enrollLog.Info("mTLS certificate issued", "expiresAt", enrollResp.Mtls.ExpiresAt)
		if !quietEnroll {
			fmt.Printf("mTLS certificate issued (expires: %s)\n", enrollResp.Mtls.ExpiresAt)
		}
	}

	// Pin per-deployment manifest trust keys delivered at enrollment (#625).
	// Self-host (BINARY_SOURCE=local) deployments sign update manifests with
	// a per-deployment Ed25519 key whose public half is delivered here.
	//
	// Enrollment is fresh-trust: no existing pin to defend against rotation, so
	// we set the pinned set directly. Subsequent updates flow through
	// config.PinManifestKeys (TOFU). See #625.
	//
	// It goes through config.BootstrapPinnedManifestKeys rather than
	// hand-serializing the response so the same rules apply as on the
	// heartbeat path: every entry must be a well-formed "<keyId>:<base64
	// Ed25519 key>", and the delivery establishes exactly ONE deployment key.
	// Writing the response through unvalidated made enrollment a TOFU bypass
	// (several keys could be seeded at once) and could persist bytes that are
	// not a usable key, which the updater now treats as an unusable trust set.
	if len(enrollResp.ManifestTrustKeys) > 0 {
		delivered := make([]config.ManifestTrustKey, 0, len(enrollResp.ManifestTrustKeys))
		for _, k := range enrollResp.ManifestTrustKeys {
			delivered = append(delivered, config.ManifestTrustKey{KeyID: k.KeyID, PublicKeyB64: k.PublicKeyB64})
		}
		pinned, err := config.BootstrapPinnedManifestKeys(delivered)
		if err != nil {
			// Preserve any pre-existing pinned set rather than silently
			// destroying trust state. err carries a bounded reason and key
			// IDs only — never key material.
			enrollLog.Warn("rejected manifest trust keys delivered at enrollment; not overwriting existing pinned set",
				"received", len(enrollResp.ManifestTrustKeys), "error", err.Error())
		} else {
			cfg.PinnedManifestPubKeys = pinned
			enrollLog.Info("pinned manifest trust keys from enrollment", "count", len(pinned))
		}
	}

	if err := config.SaveTo(cfg, cfgFile); err != nil {
		return &enrollFailure{cat: catConfig, friendly: fmt.Sprintf(
			"enrollment succeeded but could not save config to %s — check that the directory exists and SYSTEM has write access (agentID=%s)",
			cfgFile, cfg.AgentID), detail: err}
	}

	enrollLog.Info("enrollment successful",
		"agentId", cfg.AgentID,
		"orgId", cfg.OrgID,
		"siteId", cfg.SiteID)
	if !quietEnroll {
		fmt.Println("Enrollment successful!")
		fmt.Printf("Agent ID: %s\n", cfg.AgentID)
		fmt.Println("Configuration saved.")
	}

	return nil
}

// initEnrollLogging configures the agent logging package for the enroll
// command. In quiet mode the slog sink is the log file only; otherwise it
// tees stdout + file (or file-only when no console is attached, matching
// the runtime behaviour of initLogging). Errors within enrollDevice
// always additionally go to stderr via explicit fmt.Fprintln calls at
// error sites. Logging-setup failures inside this helper fall back to
// stdout logging and also write a warning to stderr.
func initEnrollLogging(cfg *config.Config, quiet bool) {
	if cfg.LogFile == "" {
		cfg.LogFile = filepath.Join(config.LogDir(), "agent.log")
	}

	// 0700, not 0755: even this best-effort pre-create (NewRotatingWriter
	// below secures/repairs the directory itself regardless) should never
	// leave the log directory group/world-readable, even momentarily.
	if err := os.MkdirAll(filepath.Dir(cfg.LogFile), 0o700); err != nil {
		// Rare in production (MSI CA runs as SYSTEM), but if it happens
		// the admin needs to see it in install.log — write to stderr
		// unconditionally so the MSI verbose log captures it.
		fmt.Fprintf(os.Stderr, "Warning: could not create log directory %s: %v — structured logs will go to stdout\n", filepath.Dir(cfg.LogFile), err)
		logging.Init(cfg.LogFormat, cfg.LogLevel, os.Stdout)
		log = logging.L("main")
		return
	}

	rw, err := logging.NewRotatingWriter(cfg.LogFile, cfg.LogMaxSizeMB, cfg.LogMaxBackups)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not open log file %s: %s — structured logs will go to stdout\n", cfg.LogFile, describeLogFileError(err))
		logging.Init(cfg.LogFormat, cfg.LogLevel, os.Stdout)
		log = logging.L("main")
		return
	}

	var output io.Writer
	switch {
	case quiet:
		output = rw
	case !hasConsole():
		output = rw
	default:
		output = logging.TeeWriter(os.Stdout, rw)
	}

	logging.Init(cfg.LogFormat, cfg.LogLevel, output)
	log = logging.L("main")
}

func checkStatus() {
	cfg, err := config.Load(cfgFile)
	if err != nil {
		if isPermissionError(err) {
			fmt.Println("Status: Unable to read configuration (permission denied)")
			switch runtime.GOOS {
			case "darwin":
				fmt.Println("  The agent runs as a system service. Check status with:")
				fmt.Println("    sudo breeze-agent status")
				fmt.Println("    sudo launchctl list | grep breeze")
			case "linux":
				fmt.Println("  The agent runs as a system service. Check status with:")
				fmt.Println("    sudo breeze-agent status")
				fmt.Println("    sudo systemctl status breeze-agent")
			default:
				fmt.Println("  Try running with elevated privileges (e.g. sudo).")
			}
			return
		}
		fmt.Println("Status: Not configured")
		return
	}

	if cfg.AgentID == "" {
		fmt.Println("Status: Not enrolled")
		return
	}

	if isSystemServiceRunning() {
		fmt.Println("Status: Enrolled & Active")
	} else {
		fmt.Println("Status: Enrolled (stopped)")
	}
	fmt.Printf("Version: %s\n", version)
	fmt.Printf("Agent ID: %s\n", cfg.AgentID)
	fmt.Printf("Server: %s\n", cfg.ServerURL)
	fmt.Printf("Heartbeat Interval: %d seconds\n", cfg.HeartbeatIntervalSeconds)
	fmt.Printf("Metrics Interval: %d seconds\n", cfg.MetricsIntervalSeconds)
	fmt.Printf("Enabled Collectors: %v\n", cfg.EnabledCollectors)
}

// runUninstallNotify posts the best-effort uninstall-intent signal (Task 6,
// #2764) — POST /agents/:id/uninstall-intent — before the MSI's RemoveFiles
// standard action deletes secrets.yaml (see the UninstallNotify CA,
// installer/breeze.wxs, sequenced Before="RemoveFiles"). This is a
// diagnostic courtesy to the server (it lets the offline-detector reaper
// distinguish "cleanly uninstalled" from "just went dark"), never a
// precondition for uninstalling.
//
// Every branch below returns without calling osExit at all, let alone with
// a nonzero code: no readable config, an unenrolled config, a network
// error, and a non-2xx response (including the 403 tenant_offboarding
// drain response returned while the device's org is mid-offboarding) are
// all treated identically — logged, then return. Combined with the WiX
// CA's own Return="ignore", this is belt-and-suspenders: the process must
// exit 0 even if some future edit here forgets that contract.
func runUninstallNotify() {
	cfg, err := config.Load(cfgFile)
	if err != nil {
		cfg = config.Default()
	}
	initEnrollLogging(cfg, true)
	uLog := logging.L("uninstall-notify")

	if !config.IsEnrolled(cfg) {
		// Covers both "never enrolled" and "secrets.yaml already gone" —
		// IsEnrolled requires AuthToken, which only ever lives in
		// secrets.yaml. Nothing to notify either way.
		uLog.Info("uninstall-notify: agent is not enrolled (or secrets.yaml is missing); nothing to notify")
		return
	}

	client := api.NewClient(cfg.ServerURL, cfg.AuthToken, cfg.AgentID)
	resp, err := client.UninstallIntent()
	if err != nil {
		// Includes the 403 tenant_offboarding drain response and any
		// network/timeout error — both are expected/benign here and must
		// never block or slow down the uninstall.
		uLog.Info("uninstall-notify: server call failed (non-fatal, uninstall proceeds)", "error", err.Error())
		return
	}
	uLog.Info("uninstall-notify: acknowledged by server", "acknowledged", resp.Acknowledged)
}

// runUserHelper starts the per-user session helper process.
// It connects to the root daemon via IPC and handles user-context operations.
func runUserHelper() {
	// helperRole is bound to the cobra --role string flag; convert at this
	// CLI boundary into the typed HelperRole used everywhere downstream.
	runHelperProcess("user helper", ipc.HelperRole(helperRole), "", ipc.HelperBinaryUserHelper)
}

func runDesktopHelper() {
	runHelperProcess("desktop helper", desktopHelperRole(), desktopContext, ipc.HelperBinaryDesktopHelper)
}

func desktopHelperRole() ipc.HelperRole {
	if runtime.GOOS == "darwin" {
		return ipc.HelperRoleUser
	}
	return ipc.HelperRoleSystem
}

func runHelperProcess(name string, role ipc.HelperRole, context, binaryKind string) {
	// Detach any inherited console immediately. This runs at the top of
	// every helper role — user-helper, desktop-helper, and any future
	// helper subcommand routed through runHelperProcess — because all of
	// them risk inheriting a console window when the parent path uses the
	// legacy console-subsystem breeze-agent.exe (e.g. operators running
	// the helper manually from cmd.exe, or partially-upgraded installs
	// where the new MSI hasn't repointed the scheduled task at
	// breeze-user-helper.exe yet). The GUI-subsystem sibling built per
	// agent/Makefile build-windows-user-helper has no console to free, so
	// the call is a documented no-op there. Cross-platform stub on
	// macOS/Linux.
	detachHelperConsole()

	// Log to file in the same logs folder as the main agent
	logDir := filepath.Dir(config.Default().LogFile) // e.g. C:\ProgramData\Breeze\logs
	os.MkdirAll(logDir, 0700)
	logFileName := "user-helper.log"
	if binaryKind == ipc.HelperBinaryDesktopHelper {
		logFileName = "desktop-helper.log"
	}
	logPath := filepath.Join(logDir, logFileName)
	var output io.Writer = os.Stdout
	if f, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600); err == nil {
		// When spawned with CREATE_NO_WINDOW (service helper), stdout is invalid.
		// Use file-only to avoid io.MultiWriter aborting on stdout write errors.
		if hasConsole() {
			output = io.MultiWriter(os.Stdout, f)
		} else {
			output = f
		}
		// Redirect stderr to the same log file so Go panic stack traces
		// are captured instead of being lost to NUL when spawned with
		// CREATE_NO_WINDOW from the service.
		redirectStderr(f)
	}
	logging.Init("text", "info", output)

	// Load agent config for IPC socket path and helper-scoped log shipping
	// credentials. Use LoadHelperConfig, NOT Load: this process runs as the
	// logged-in user on the user-helper path, and Load() unconditionally reads
	// root-only secrets.yaml and returns an error there, leaving the helper with
	// no shipper at all (#2483). LoadHelperConfig reads agent.yaml only.
	cfg, err := config.LoadHelperConfig(cfgFile)
	if err != nil {
		slog.Warn("helper config load failed; helper log shipping disabled", "error", err)
		cfg = config.Default()
	}

	socketPath := ipc.DefaultSocketPath()
	if cfg.IPCSocketPath != "" {
		socketPath = cfg.IPCSocketPath
	}

	// Ship helper logs to the API under the same agent identity.
	//
	// The helper is a SEPARATE, long-lived process with no heartbeat of its
	// own, and nothing respawns it when the agent promotes a backup server URL
	// (#2323) — so a copied cfg.ServerURL would keep shipping helper
	// diagnostics at the dead primary for the rest of the logon session
	// (#2463). The agent persists the promotion swap to agent.yaml, which is
	// world-readable precisely so the helper can read its server URL, so the
	// provider re-reads it there on a TTL.
	//
	// This block is reachable in BOTH user- and SYSTEM-context helpers: the
	// LoadHelperConfig above reads agent.yaml (world-readable) and skips
	// root-only secrets.yaml, so the AgentID/ServerURL/HelperAuthToken this gate
	// needs are populated in a user session too (#2483). Everything the gate
	// checks lives in agent.yaml by design (see secretKeyAllowedInAgentYAML).
	if cfg.AgentID != "" && cfg.ServerURL != "" && cfg.HelperAuthToken != "" {
		helperToken := secmem.NewSecureString(cfg.HelperAuthToken)
		cfg.AuthToken = ""
		cfg.HelperAuthToken = ""
		helperAuthMon := authstate.NewMonitor(3)
		logging.InitShipper(logging.ShipperConfig{
			ServerURL:    config.NewPersistedServerURLProvider(cfgFile, cfg.ServerURL, 0),
			AgentID:      cfg.AgentID,
			AuthToken:    helperToken,
			AgentVersion: version + "-helper",
			MinLevel:     cfg.LogShippingLevel,
			AuthMonitor:  helperAuthMon,
		})
		// Dev builds ship info-level logs for performance tuning and diagnostics.
		if strings.HasPrefix(version, "dev-") && cfg.LogShippingLevel == "warn" {
			logging.SetShipperLevel("info")
		}
		// desktop_debug forces info-level shipping so the chatty remote-desktop
		// diagnostics surface to the API. Leave off in production. See
		// docs/superpowers/plans/remote-desktop/2026-04-13-ice-turn-fallback-diagnostics.md.
		if cfg.DesktopDebug && (cfg.LogShippingLevel == "" || cfg.LogShippingLevel == "warn") {
			logging.SetShipperLevel("info")
		}
		defer logging.StopShipper()
	}

	// Top-level panic recovery for the main goroutine of runHelperProcess.
	// NOTE: recover() only catches panics in THIS goroutine. Panics in
	// sub-goroutines (pion RTCP reader, capture loops, IPC dispatch in
	// userhelper.Client.safeGo, etc.) still exit the process with code 2
	// (Go's default panic exit code), which the lifecycle manager
	// classifies as a permanent-reject cooldown. For sub-goroutines that
	// need the same transient classification, wrap them in their own
	// recover() + os.Exit(3).
	//
	// What this defer DOES catch: startup/shutdown panics on the main
	// goroutine. Without it, those surface as exit code 2 and trigger the
	// 10-minute lockout meant for genuinely fatal errors. Catch the panic,
	// log the stack trace at error level (which ships), flush synchronously,
	// then exit with code 3 so lifecycle.go treats it as transient.
	defer func() {
		if r := recover(); r != nil {
			stack := debug.Stack()
			log.Error("helper panic caught at top level",
				"name", name,
				"role", role,
				"panic", fmt.Sprint(r),
				"stack", string(stack),
			)
			// Also write directly to stderr so the panic is in the on-disk
			// log file regardless of the shipper state.
			fmt.Fprintf(os.Stderr, "helper panic: %v\n%s\n", r, stack)
			logging.StopShipper() // synchronous flush
			os.Exit(3)            // code 3 = panic, not permanent reject
		}
	}()

	logProcessStartup(currentProcessStartup("user-helper", role, false))

	// Handle shutdown signals via a done channel so multiple selects
	// can observe the shutdown without racing on a buffered sigChan.
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	done := make(chan struct{})
	go func() {
		<-sigChan
		close(done)
	}()

	// Reconnect loop: when the IPC socket disappears (e.g. agent self-update
	// recreates it), retry with exponential backoff instead of exiting. The
	// loop itself lives in internal/userhelper so the standalone macOS
	// breeze-desktop-helper binary runs the identical logic — it used to have
	// its own single-shot copy that exited on the first IPC error (#4194).
	//
	// The 30s floor is intentionally conservative because most helper
	// disconnects in production are caused by permanent identity/auth problems
	// (binary path mismatch, SID lookup failure on headless Windows, etc.),
	// not transient socket hiccups. See issue #387.
	sup := &userhelper.Supervisor{
		Name: name,
		Policy: userhelper.ReconnectPolicy{
			MinBackoff:      30 * time.Second,
			MaxBackoff:      5 * time.Minute,
			StableThreshold: 60 * time.Second,
			WarnLimit:       3,
			WarnWindow:      5 * time.Minute,
		},
		NewClient: func() userhelper.SupervisedClient {
			return userhelper.NewWithOptions(socketPath, role, binaryKind, context)
		},
		Log: log,
	}

	res := sup.Run(done)
	if res.Reason != userhelper.StopFatal {
		if res.Err != nil {
			log.Info("helper stopped after error", "name", name, "error", res.Err.Error())
		} else {
			log.Info("helper stopped", "name", name)
		}
		return
	}

	// Fatal permanent rejection from the broker: exit with code 2 so
	// the lifecycle manager knows not to respawn immediately.
	//
	// Exit code 2 semantics: signals to the lifecycle manager that
	// this helper should not be respawned immediately — the rejection
	// is permanent (binary hash mismatch, SID lookup failure, etc.).
	var permErr *userhelper.PermanentRejectError
	if errors.As(res.Err, &permErr) {
		if permErr.Code == "not_desired" {
			// On-demand lifecycle: this helper's session/role is simply not
			// leased right now. That is the normal state on an RDS host at
			// rest — exit 0 so the logon scheduled task records success and
			// does not retry-loop on every user logon.
			log.Info("helper not currently desired by lifecycle; exiting clean",
				"name", name, "reason", permErr.ReasonOr(res.Err.Error()))
			logging.StopShipper()
			os.Exit(0)
		}
		log.Error("helper permanently rejected, exiting fatal",
			"name", name,
			"code", permErr.CodeOr("unknown"),
			"reason", permErr.ReasonOr(res.Err.Error()),
		)
		logging.StopShipper() // flush before os.Exit tears down goroutines
		os.Exit(2)
	}
	// Not a *PermanentRejectError. Identify what it actually is rather than
	// assuming — IsFatalHelperError decides the fatal set, and hardcoding a
	// code here mislabels every future addition to it as a SID failure.
	code := "unknown"
	if errors.Is(res.Err, userhelper.ErrSIDLookupFailed) {
		code = "sid_lookup_failed"
	}
	log.Error("helper permanently rejected, exiting fatal",
		"name", name,
		"code", code,
		"reason", res.Err.Error(),
	)
	logging.StopShipper() // flush before os.Exit tears down goroutines
	os.Exit(2)
}
