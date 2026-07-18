package heartbeat

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shirou/gopsutil/v3/host"

	"github.com/breeze-rmm/agent/internal/audit"
	"github.com/breeze-rmm/agent/internal/authstate"
	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/executor"
	"github.com/breeze-rmm/agent/internal/health"
	"github.com/breeze-rmm/agent/internal/helper"
	"github.com/breeze-rmm/agent/internal/httputil"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/mgmtdetect"
	"github.com/breeze-rmm/agent/internal/monitoring"
	"github.com/breeze-rmm/agent/internal/mtls"
	"github.com/breeze-rmm/agent/internal/netcache"
	"github.com/breeze-rmm/agent/internal/observability"
	"github.com/breeze-rmm/agent/internal/onedrivehelper"
	"github.com/breeze-rmm/agent/internal/patching"
	"github.com/breeze-rmm/agent/internal/peripheral"
	"github.com/breeze-rmm/agent/internal/privilege"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/remote/desktop/x11"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/secmem"
	"github.com/breeze-rmm/agent/internal/security"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
	"github.com/breeze-rmm/agent/internal/state"
	"github.com/breeze-rmm/agent/internal/tcc"
	"github.com/breeze-rmm/agent/internal/terminal"
	"github.com/breeze-rmm/agent/internal/tunnel"
	"github.com/breeze-rmm/agent/internal/updater"
	"github.com/breeze-rmm/agent/internal/websocket"
	"github.com/breeze-rmm/agent/internal/workerpool"
	"github.com/breeze-rmm/agent/pkg/api"
)

var log = logging.L("heartbeat")
var desktopSessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

const backupProbeThreshold = 10 // keep in sync with agent/cmd/breeze-watchdog

type HeartbeatPayload struct {
	Metrics          *collectors.SystemMetrics `json:"metrics,omitempty"`
	MetricsAvailable *bool                     `json:"metricsAvailable,omitempty"`
	Status           string                    `json:"status"`
	AgentVersion     string                    `json:"agentVersion"`
	IPHistoryUpdate  *IPHistoryUpdate          `json:"ipHistoryUpdate,omitempty"`
	PendingReboot    bool                      `json:"pendingReboot"`
	LastUser         string                    `json:"lastUser,omitempty"`
	UptimeSeconds    int64                     `json:"uptime,omitempty"`
	DeviceRole       string                    `json:"deviceRole,omitempty"`
	// Orthogonal virtualization attribute (issue #1387). IsVirtual is a
	// pointer so an old-agent omission (nil) is distinguishable from a
	// genuine "physical" report (false) — the server only overwrites the
	// stored value when the agent actually sends one.
	IsVirtual              *bool          `json:"isVirtual,omitempty"`
	VirtualizationPlatform string         `json:"virtualizationPlatform,omitempty"`
	HealthStatus           map[string]any `json:"healthStatus,omitempty"`
	DroppedLogs            int64          `json:"droppedLogs,omitempty"`
	HelperVersion          string         `json:"helperVersion,omitempty"`
	WatchdogVersion        string         `json:"watchdogVersion,omitempty"`
	// ServerURL is the control-plane base URL this heartbeat is POSTed to
	// (#2288). Set per-attempt in postHeartbeat, so a backup probe reports
	// the backup URL and the device row shows real fleet position.
	ServerURL      string              `json:"serverUrl,omitempty"`
	TCCPermissions *ipc.TCCStatus      `json:"tccPermissions,omitempty"`
	DesktopAccess  *DesktopAccessState `json:"desktopAccess,omitempty"`
	Hostname       string              `json:"hostname,omitempty"`
	OSVersion      string              `json:"osVersion,omitempty"`
	OSBuild        string              `json:"osBuild,omitempty"`
	IsHeadless     bool                `json:"isHeadless"`
	// Current-state power/battery telemetry (#2142). Pointer + omitempty so an
	// old agent (or a platform that can't report power state) omits the field
	// and the server keeps whatever it last knew rather than clobbering it.
	Battery *collectors.BatteryInfo `json:"battery,omitempty"`
	// OneDrive helper state (Phase 2). Nil until a config has been applied on a
	// Windows box — omitempty then drops the field entirely.
	OneDriveDeviceState *onedrivehelper.DeviceState `json:"onedriveDeviceState,omitempty"`
	// Agent's own Go runtime memory gauges (#2389). Collected every heartbeat
	// (runtime.ReadMemStats is microseconds) so fleet-wide agent memory leaks
	// are visible from the server without shell access to the device.
	AgentRuntime *collectors.RuntimeStats `json:"agentRuntime,omitempty"`
}

type DesktopAccessState struct {
	Mode                    string    `json:"mode"`
	LoginUIReachable        bool      `json:"loginUiReachable"`
	VirtualDisplayReady     bool      `json:"virtualDisplayReady"`
	Reason                  string    `json:"reason,omitempty"`
	RemoteDesktopPermission *bool     `json:"remoteDesktopPermission,omitempty"`
	CheckedAt               time.Time `json:"checkedAt"`
}

type HeartbeatResponse struct {
	Commands               []Command              `json:"commands"`
	ConfigUpdate           map[string]any         `json:"configUpdate,omitempty"`
	UpgradeTo              string                 `json:"upgradeTo,omitempty"`
	RenewCert              bool                   `json:"renewCert,omitempty"`
	RotateToken            bool                   `json:"rotateToken,omitempty"`
	HelperEnabled          bool                   `json:"helperEnabled,omitempty"`
	UacInterceptionEnabled *bool                  `json:"uacInterceptionEnabled,omitempty"`
	HelperSettings         *HelperSettings        `json:"helperSettings,omitempty"`
	HelperUpgradeTo        string                 `json:"helperUpgradeTo,omitempty"`
	WatchdogUpgradeTo      string                 `json:"watchdogUpgradeTo,omitempty"`
	ManageRemoteManagement bool                   `json:"manageRemoteManagement,omitempty"`
	ManifestTrustKeys      []api.ManifestTrustKey `json:"manifestTrustKeys,omitempty"`
}

type HelperSettings struct {
	Enabled            bool   `json:"enabled"`
	ShowOpenPortal     bool   `json:"showOpenPortal"`
	ShowDeviceInfo     bool   `json:"showDeviceInfo"`
	ShowRequestSupport bool   `json:"showRequestSupport"`
	PortalUrl          string `json:"portalUrl,omitempty"`
}

type Command struct {
	ID      string         `json:"id"`
	Type    string         `json:"type"`
	Payload map[string]any `json:"payload"`
}

type helperLifecycleController interface {
	Stop()
	Done() <-chan struct{}
}

type Heartbeat struct {
	config           *config.Config
	secureToken      *secmem.SecureString
	client           *http.Client
	clientMu         sync.RWMutex
	stopChan         chan struct{}
	metricsCol       *collectors.MetricsCollector
	hardwareCol      *collectors.HardwareCollector
	softwareCol      *collectors.SoftwareCollector
	inventoryCol     *collectors.InventoryCollector
	vpnCol           *collectors.VPNCollector
	changeTrackerCol *collectors.ChangeTrackerCollector
	sessionCol       *collectors.SessionCollector
	policyStateCol   *collectors.PolicyStateCollector
	patchCol         *collectors.PatchCollector
	patchMgr         *patching.PatchManager
	connectionsCol   *collectors.ConnectionsCollector
	eventLogCol      *collectors.EventLogCollector
	bootCol          *collectors.BootPerformanceCollector
	reliabilityCol   *collectors.ReliabilityCollector
	agentVersion     string
	desktopMgr       *desktop.SessionManager
	wsDesktopMgr     *desktop.WsSessionManager
	terminalMgr      *terminal.Manager
	tunnelMgr        *tunnel.Manager
	executor         *executor.Executor
	backupBinaryPath string
	rebootMgr        *patching.RebootManager
	securityScanner  *security.SecurityScanner
	wsClient         *websocket.Client
	// backupOutbox persists terminal backup results that failed to send over
	// the WS connection, so a transient blip doesn't orphan the job
	// server-side. Flushed on WS reconnect (see SetWebSocketClient). Never
	// nil in production — always constructed in NewWithVersion.
	backupOutbox          *backupResultOutbox
	mu                    sync.Mutex
	lastInventoryUpdate   time.Time
	lastEventLogUpdate    time.Time
	lastSecurityUpdate    time.Time
	lastRecoveryKeysFP    string
	pendingRecoveryKeys   []security.RecoveryKey
	lastSessionUpdate     time.Time
	lastPostureUpdate     time.Time
	lastReliabilityUpdate time.Time
	lastHardwareUpdate    time.Time // stamped at startup; gate then re-runs every 24 h
	lastPatchUpdate       time.Time // stamped at startup; gate then re-runs every PatchScanIntervalHours

	// User session helper (IPC)
	helperToken     string // retained copy of the helper-scoped token for connect-time pushes
	helperTokenMu   sync.RWMutex
	sessionBroker   *sessionbroker.Broker
	helperLifecycle helperLifecycleController
	lifecycleCancel context.CancelFunc
	shutdownTimeout time.Duration
	isService       bool
	isHeadless      bool
	// headlessCachedAt memoizes the Linux resolver-backed headless probe used by
	// currentHeadless() for the outgoing heartbeat payload. Stores a
	// headlessCache; an atomic.Value so the heartbeat and command-handler
	// goroutines never race on a plain bool (isHeadless itself is never mutated
	// after construction).
	headlessCachedAt atomic.Value
	scmSessionCh     chan sessionbroker.SCMSessionEvent // fed by SCM handler
	helperFinder     func(targetSession string) *sessionbroker.Session
	spawnHelper      func(targetSession string) error

	// Shutdown seams keep lifecycle ordering directly testable without opening
	// sockets or spawning Windows processes. Production leaves these nil.
	stopBrokerAcceptingAndWait func(context.Context) error
	stopHelperLifecycleAndWait func(context.Context) error
	closeSessionBroker         func()
	// PAM seams default to the real broker methods in RunPamFlow/denyConsent
	// when nil; overridden in pam_flow_test.go.
	pamFindSession    func(capability, targetWinSession string) *sessionbroker.Session
	pamRequestDialog  func(session *sessionbroker.Session, id string, req ipc.PamRequestDialog, timeout time.Duration) (ipc.PamDialogResult, error)
	pamDismissConsent func(session *sessionbroker.Session, id string, timeout time.Duration) (ipc.PamDismissConsentResult, error)
	// pamActuateMu serializes consent.exe actuation/dismissal so the local
	// etwlua flow (RunPamFlow) and the remote actuate_elevation command never
	// drive SendInput/SetThreadDesktop against the same live consent.exe prompt
	// concurrently (e.g. an await_remote technician approval firing
	// actuate_elevation while a re-fired ETW event re-enters RunPamFlow).
	pamActuateMu sync.Mutex
	// pamDismissalUncertain is protected by pamActuateMu. It keeps later PAM
	// input fail-closed after a broker failure until the helper's correlated
	// response proves the old dismissal command has stopped.
	pamDismissalUncertain bool
	wsDesktopStart        func(sessionID string, displayIndex int, config desktop.StreamConfig, sendFrame desktop.SendFrameFunc) (int, int, error)
	desktopOwners         sync.Map // desktop session ID -> helper session ID

	// Resilience & observability
	pool        *workerpool.Pool
	healthMon   *health.Monitor
	auditLog    *audit.Logger
	accepting   atomic.Bool
	wg          sync.WaitGroup
	inventoryWg sync.WaitGroup
	retryCfg    httputil.RetryConfig
	stopOnce    sync.Once
	authMon     *authstate.Monitor

	// Command deduplication: prevents the same commandId from being
	// executed twice when delivered via both WebSocket and heartbeat.
	seenCommands   map[string]time.Time
	seenCommandsMu sync.Mutex

	// commandInFlightWarnAfter overrides the wedged-worker watchdog interval
	// in executeCommandViaPool for non-ephemeral commands; non-positive means
	// defaultCommandInFlightWarnAfter. Set before the heartbeat runs (tests
	// only) — never mutated afterwards.
	commandInFlightWarnAfter time.Duration

	// ephemeralCommandInFlightWarnAfter is the same override for the short
	// watchdog tier applied to ephemeral commands (isEphemeralCommand:
	// terminal/tunnel/desktop data, which should complete in milliseconds);
	// non-positive means defaultEphemeralCommandInFlightWarnAfter. Tests only.
	ephemeralCommandInFlightWarnAfter time.Duration

	// inFlightCommands tracks every command currently executing on the worker
	// pool (keyed by a per-dispatch sequence number so duplicate command IDs
	// can't clobber each other), with its start time and watchdog tier. Read
	// by inFlightCommandStats to put wedged-worker gauges on the heartbeat
	// (issue #2400).
	inFlightMu       sync.Mutex
	inFlightCommands map[uint64]inFlightCommand
	inFlightSeq      atomic.Uint64

	// Guard against concurrent cert renewals from successive heartbeats
	certRenewing      atomic.Bool
	tokenRotating     atomic.Bool
	upgradeInProgress atomic.Bool

	// Set when PinManifestKeys returns ErrManifestTrustRotationRejected.
	// Suspends auto-update until the rotation conflict is resolved (server
	// stops sending the conflicting key, restoring an idempotent re-pin) or
	// the agent restarts. Without this gate, a single SECURITY log line is
	// the only signal of a possible API compromise — auto-update would
	// otherwise continue against the still-pinned (legitimate) key, masking
	// the rejection from the operator.
	manifestTrustRotationRejected atomic.Bool

	// Helper chat enabled flag from org settings
	helperEnabled atomic.Bool
	helperMgr     *helper.Manager

	// uacInterceptionEnabled is set when the server's resolved 'pam' config
	// policy turns UAC capture ON for this device. Opt-in: the zero value
	// (disabled) means no capture until the server explicitly enables it, so a
	// device with no PAM policy — or one talking to a server that never sends
	// the field — never prompts the user before the first heartbeat says so.
	uacInterceptionEnabled atomic.Bool

	// Service & process monitoring
	monitor *monitoring.Monitor

	// OneDrive helper state captured on config apply, reported next heartbeat.
	onedriveMu    sync.Mutex
	onedriveState *onedrivehelper.DeviceState

	// Cached device role classification (computed once at startup)
	cachedDeviceRole string

	// Cached virtualization classification (issue #1387) — the orthogonal
	// "is this a VM and on what hypervisor" attribute. Computed in the same
	// hardware-collection pass as cachedDeviceRole and guarded by h.mu.
	//
	// cachedVirtComputed gates the heartbeat send: virtualization is derivable
	// ONLY from full hardware collection (CollectHardware), which runs in a
	// background goroutine that can take ~75s on Windows and may fail. Until it
	// succeeds, cachedIsVirtual is its zero value (false) — an affirmative
	// "physical" claim we have NOT actually established. Sending that false
	// would overwrite the correct is_virtual/platform that synchronous
	// enrollment already persisted for a real VM (the server treats a present
	// false as authoritative and clears the platform). So we send the
	// virtualization fields only once cachedVirtComputed is true; before that
	// the heartbeat omits them (nil) and the server leaves the stored value
	// untouched — same "don't touch" semantics as an old agent that lacks the
	// field entirely.
	cachedIsVirtual    bool
	cachedVirtPlatform string
	cachedVirtComputed bool

	// Cached system info (hostname, OS version) — refreshed every 10 min
	cachedSysInfo      *collectors.SystemInfo
	lastSysInfoRefresh time.Time

	// Tracks whether the read-only FS error has been logged (prevents log spam)
	updateReadOnlyLogged bool

	// Path to the agent state file, set by main after startup.
	statePath string

	// sendHeartbeatFn is an optional override used by tests to replace the
	// real sendHeartbeat call inside sendHeartbeatWithWatchdog. nil in
	// production — the real sendHeartbeat method is invoked.
	sendHeartbeatFn func()

	// sendInventoryFn is an optional override used by tests to replace the
	// real sendInventory call inside handleRefreshInventory. nil in
	// production — the real sendInventory method is invoked.
	sendInventoryFn func()

	// userHelperDownloader is an optional test seam: when non-nil,
	// prefetchUserHelper calls this instead of constructing a real
	// updater.Updater and invoking DownloadBinary. nil in production.
	// Signature mirrors updater.Updater.DownloadBinary so the production
	// default can be a one-line shim.
	userHelperDownloader func(targetVersion string) (string, error)

	// userHelperGOOS is an optional test seam: when non-empty, replaces
	// runtime.GOOS in prefetchUserHelper. nil/"" in production — the real
	// runtime.GOOS value is used so the prefetch only runs on Windows.
	userHelperGOOS string

	// userHelperInstaller is an optional test seam: when non-nil,
	// reconcileUserHelper calls this instead of performing the real on-disk
	// install (copy into place + broker hash-allowlist refresh). nil in
	// production. Signature is (tempPath, installPath, version).
	userHelperInstaller func(tempPath, installPath, version string) error

	// userHelperInstallMu serializes installUserHelperBinary so a manual
	// dev_update and the periodic reconcile can't run the
	// taskkill→copy→rename→allowlist-refresh sequence concurrently and race on
	// the shared backup target / install path.
	userHelperInstallMu sync.Mutex

	// userHelperReconcileFailures counts consecutive reconcileUserHelper
	// failures so a permanently-unfetchable helper escalates from WARN to a
	// distinct, greppable ERROR instead of looping at WARN forever. Reset to 0
	// on the first success.
	userHelperReconcileFailures atomic.Int32

	// watchdogUpgradeInProgress guards handleWatchdogUpgrade so overlapping
	// heartbeat-delivered watchdogUpgradeTo signals don't run the
	// download→replace→service-restart sequence concurrently.
	watchdogUpgradeInProgress atomic.Bool

	// watchdogInstaller is an optional test seam: when non-nil,
	// handleWatchdogUpgrade calls this instead of the real platform-specific
	// installAndRestartWatchdog (which downloads the watchdog component, swaps
	// the on-disk binary, and restarts the watchdog service). nil in production.
	watchdogInstaller func(targetVersion string) error

	// watchdogVersionReader is an optional test seam: when non-nil,
	// installedWatchdogVersion calls this instead of the real on-disk read
	// (readInstalledWatchdogVersion, which execs `breeze-watchdog status`). It
	// returns (version, stable) — stable=false marks a transient failure that
	// must NOT be cached. nil in production.
	watchdogVersionReader func() (string, bool)

	// watchdog upgrade bookkeeping, guarded by watchdogUpgradeMu. The server
	// keeps sending watchdogUpgradeTo until a watchdog FAILOVER heartbeat
	// reports the new version — but a healthy (monitoring) watchdog doesn't
	// heartbeat, so the signal can repeat indefinitely after a successful swap.
	// watchdogInstalledVersion is a permanent (process-lifetime) skip for a
	// target we already installed; watchdogLastAttempt* throttles retries of a
	// FAILING target so we don't re-download + restart the service every tick.
	watchdogUpgradeMu        sync.Mutex
	watchdogInstalledVersion string
	watchdogLastAttemptVer   string
	watchdogLastAttemptAt    time.Time
	// watchdogVersionDisk caches the version parsed from the on-disk watchdog
	// binary so we exec it at most once per process run; watchdogVersionRead
	// records that a STABLE read happened (not installed, or a successful read).
	// A transient read failure is not cached, so it retries next tick. A
	// successful swap sets watchdogInstalledVersion, which takes priority here.
	// watchdogVersionReadWarned throttles the ship-to-server WARN for a
	// present-but-unreadable watchdog to once per failure streak (re-armed on the
	// next stable read) so a wedged/old watchdog doesn't emit ~1 warn/heartbeat.
	watchdogVersionDisk       string
	watchdogVersionRead       bool
	watchdogVersionReadWarned bool
	hbConsecutiveFailures     int // guarded by h.mu
}

func New(cfg *config.Config) *Heartbeat {
	return NewWithVersion(cfg, "0.1.0", nil, nil)
}

func newHeartbeatHTTPClient(tlsCfg *tls.Config) *http.Client {
	// Clone DefaultTransport so proxy support (ProxyFromEnvironment) and the
	// idle-conn/timeout defaults survive; a bare &http.Transport{} would
	// silently strand proxied agents. Dials then go through the
	// last-known-good DNS cache (#2288); TLS (including the mTLS client
	// cert) sits above it, so hostname verification is unchanged — the cache
	// alters where we dial, never what we trust.
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = netcache.Shared().DialContext
	if tlsCfg != nil {
		transport.TLSClientConfig = tlsCfg
	}
	return &http.Client{Timeout: 30 * time.Second, Transport: transport}
}

func NewWithVersion(cfg *config.Config, version string, token *secmem.SecureString, tlsCfg *tls.Config) *Heartbeat {
	secToken := token
	if secToken == nil && cfg.AuthToken != "" {
		secToken = secmem.NewSecureString(cfg.AuthToken)
	}

	// Build HTTP client with optional mTLS transport
	httpClient := newHeartbeatHTTPClient(tlsCfg)

	h := &Heartbeat{
		config:       cfg,
		secureToken:  secToken,
		client:       httpClient,
		stopChan:     make(chan struct{}),
		metricsCol:   collectors.NewMetricsCollector(),
		hardwareCol:  collectors.NewHardwareCollector(),
		softwareCol:  collectors.NewSoftwareCollector(),
		inventoryCol: collectors.NewInventoryCollector(),
		vpnCol:       collectors.NewVPNCollector(),
		changeTrackerCol: collectors.NewChangeTrackerCollector(
			filepath.Join(config.GetDataDir(), "change_tracker_snapshot.json"),
		),
		sessionCol:      collectors.NewSessionCollector(),
		policyStateCol:  collectors.NewPolicyStateCollector(),
		patchCol:        collectors.NewPatchCollector(),
		patchMgr:        patching.NewDefaultManager(cfg),
		connectionsCol:  collectors.NewConnectionsCollector(),
		eventLogCol:     collectors.NewEventLogCollector(),
		bootCol:         collectors.NewBootPerformanceCollector(),
		reliabilityCol:  collectors.NewReliabilityCollector(),
		agentVersion:    version,
		executor:        executor.New(cfg),
		desktopMgr:      desktop.NewSessionManager(),
		wsDesktopMgr:    desktop.NewWsSessionManager(),
		terminalMgr:     terminal.NewManager(),
		tunnelMgr:       tunnel.NewManager(false),
		securityScanner: &security.SecurityScanner{Config: cfg},
		pool:            workerpool.New(cfg.MaxConcurrentCommands, cfg.CommandQueueSize),
		healthMon:       health.NewMonitor(),
		retryCfg:        httputil.DefaultRetryConfig(),
		seenCommands:    make(map[string]time.Time),
		backupOutbox:    newBackupResultOutbox(backupResultOutboxDir()),
	}
	h.accepting.Store(true)
	h.isService = cfg.IsService
	h.isHeadless = cfg.IsHeadless

	// Classify device role once at startup and cache system info.
	// CollectHardware spawns WMIC processes on Windows which can take up to
	// ~75 s and would delay the service reporting "Running" to the SCM,
	// causing the MSI installer to stall. Compute an initial role from
	// CollectSystemInfo (fast) then refine it in a goroutine once hardware
	// data is available. The goroutine holds h.mu only for the final write;
	// sysInfo is a freshly allocated pointer not mutated after this point.
	if sysInfo, err := h.hardwareCol.CollectSystemInfo(); err == nil {
		h.cachedSysInfo = sysInfo
		h.lastSysInfoRefresh = time.Now()
		h.mu.Lock()
		h.cachedDeviceRole = collectors.ClassifyDeviceRole(sysInfo, nil)
		h.mu.Unlock()
		go func(sysInfo *collectors.SystemInfo) {
			defer observability.Recoverer("heartbeat.hardwareCollect")
			hwInfo, err := h.hardwareCol.CollectHardware()
			if err != nil {
				log.Warn("hardware collection failed in background; device role will use system-info-only classification and virtualization detection (#1387) is unavailable — heartbeat will omit is_virtual so the enroll-time value is preserved", "error", err.Error())
				return
			}
			virt := collectors.ClassifyVirtualization(hwInfo)
			h.mu.Lock()
			h.cachedDeviceRole = collectors.ClassifyDeviceRole(sysInfo, hwInfo)
			h.cachedIsVirtual = virt.IsVirtual
			h.cachedVirtPlatform = virt.Platform
			h.cachedVirtComputed = true
			h.mu.Unlock()
		}(sysInfo)
	} else {
		log.Warn("system info collection failed at startup; device role defaulting to workstation", "error", err.Error())
		h.mu.Lock()
		h.cachedDeviceRole = "workstation"
		h.mu.Unlock()
	}

	// Initialize Breeze Assist manager
	helperCtx, helperCancel := context.WithCancel(context.Background())
	go func() { <-h.stopChan; helperCancel() }()

	if runtime.GOOS == "windows" && cfg.IsService {
		h.helperMgr = helper.New(helperCtx, cfg.ServerURL, secToken, cfg.AgentID,
			helper.WithSessionEnumerator(helper.NewPlatformEnumerator()),
			helper.WithAgentVersion(version),
			helper.WithManifestKeys(cfg.PinnedManifestPubKeys),
			helper.WithSpawnFunc(func(sessionKey, binaryPath string, args ...string) (int, error) {
				// Try launching via connected user-role helper first (runs as
				// the logged-in user, so the Tauri app inherits user identity).
				if h.sessionBroker != nil {
					if err := h.sessionBroker.LaunchProcessViaUserHelperForSession(sessionKey, binaryPath, args...); err == nil {
						return 0, nil // PID unknown when launched via IPC; refreshPID will reconcile
					} else {
						log.Debug("user helper launch failed, falling back to direct spawn",
							"error", err.Error())
					}
				}

				sessionNum, err := strconv.ParseUint(sessionKey, 10, 32)
				if err != nil {
					return 0, fmt.Errorf("invalid session key %q: %w", sessionKey, err)
				}
				return 0, sessionbroker.SpawnProcessInSessionWithArgs(binaryPath, args, uint32(sessionNum))
			}),
		)
	} else {
		// NOTE: h.sessionBroker is not constructed until later in this constructor
		// (the needsBroker block below), so a broker-backed headless spawn arm here
		// would always be dead code; the user-role IPC spawn path is wired via the
		// session broker after it exists.
		h.helperMgr = helper.New(helperCtx, cfg.ServerURL, secToken, cfg.AgentID,
			helper.WithSessionEnumerator(helper.NewPlatformEnumerator()),
			helper.WithAgentVersion(version),
			helper.WithManifestKeys(cfg.PinnedManifestPubKeys),
		)
	}

	// Initialize service & process monitoring
	h.monitor = monitoring.New(h.sendMonitoringResults)

	// Trigger wallpaper crash recovery (restores wallpaper if agent crashed mid-session)
	_ = desktop.GetWallpaperManager()

	// Initialize audit logger if enabled
	if cfg.AuditEnabled {
		auditLogger, err := audit.NewLogger(cfg)
		if err != nil {
			log.Error("failed to start audit logger", "error", err.Error())
			h.healthMon.Update("audit", health.Unhealthy, err.Error())
		} else {
			h.auditLog = auditLogger
		}
	}

	// Initialize session broker for user helpers (IPC).
	// Enable IPC session broker when running as a service, headless, or when
	// explicitly configured. macOS daemons handle desktop capture directly
	// but still need the broker for user-context operations (run_as_user
	// scripts and Breeze Helper launch).
	needsBroker := cfg.UserHelperEnabled || cfg.IsService || cfg.IsHeadless
	if needsBroker {
		socketPath := cfg.IPCSocketPath
		if socketPath == "" {
			socketPath = ipc.DefaultSocketPath()
		}
		h.sessionBroker = sessionbroker.New(socketPath, h.handleUserHelperMessage)
		h.sessionBroker.SetSessionClosedHandler(h.handleHelperSessionClosed)
		h.sessionBroker.SetSessionAuthenticatedHandler(h.handleHelperSessionAuthenticated)
		// Retain the helper-scoped token so connect-time pushes have it even after
		// the config copy is cleared post-persist during rotation.
		h.setHelperToken(h.config.HelperAuthToken)
		reason := "config"
		if cfg.IsService {
			reason = "system-service"
		} else if cfg.IsHeadless {
			reason = "headless-daemon"
		}
		log.Info("user helper IPC enabled", "socket", socketPath, "reason", reason)

		// Pre-create the SCM session event channel so it's available before
		// Start() runs. The service handler (service_windows.go) can begin
		// forwarding events as soon as startAgent() returns.
		if cfg.IsService && runtime.GOOS == "windows" {
			h.scmSessionCh = make(chan sessionbroker.SCMSessionEvent, 16)
		}
	}

	// Register winget provider (SYSTEM/machine-scope; see winget_register_windows.go)
	h.registerSystemWinget()

	// Initialize reboot manager (uses session broker for user notifications)
	h.rebootMgr = patching.NewRebootManager(func(title, body, urgency string) {
		if h.sessionBroker != nil {
			h.sessionBroker.BroadcastNotification(title, body, urgency)
		}
	}, cfg.PatchRebootMaxPerDay)

	// Set backup binary path for IPC forwarding to breeze-backup helper
	h.backupBinaryPath = cfg.BackupBinaryPath

	// For direct mode (non-service), notify API when WebRTC peer drops.
	// In service/headless mode this is handled via IPC from the user helper.
	// Linux always registers it: a Linux box may boot headless (no graphical
	// session yet) but still serve desktop captures directly (there is no IPC
	// helper on Linux in Phase 1), so its WebRTC disconnects must be reported
	// here. The callback is nil-checked at every fire site and inert in helper
	// mode, so registering it unconditionally on Linux is safe.
	if (!cfg.IsService && !cfg.IsHeadless) || runtime.GOOS == "linux" {
		h.desktopMgr.OnSessionStopped = func(sessionID string) {
			h.sendDesktopDisconnectNotification(sessionID)
		}
	}

	// Clean up any orphaned Screen Sharing left running from a previous crash.
	h.tunnelMgr.CleanupOrphanedVNC()

	return h
}

// SetWebSocketClient sets the WebSocket client for terminal output streaming
func (h *Heartbeat) SetWebSocketClient(ws *websocket.Client) {
	h.wsClient = ws
	// Opt-in diagnostic logger that reports per-tunnel bytesRecv/bytesSent
	// and the WS binary-frame channel depth every 5s. Off by default; set
	// BREEZE_TUNNEL_DIAG=1 in the agent's environment to enable when
	// debugging tunnel stalls or backpressure.
	if os.Getenv("BREEZE_TUNNEL_DIAG") == "1" && h.tunnelMgr != nil && ws != nil {
		h.tunnelMgr.StartDiagLogger(5*time.Second, ws.BinaryFrameChanStats)
	}
	// Retry any backup results that couldn't be delivered before the last
	// disconnect as soon as the handshake completes on every (re)connect —
	// set here, before Start() is ever called on ws, so there's no race with
	// the read pump goroutine that invokes it (terminal-result outbox).
	if ws != nil {
		ws.OnConnected = h.flushBackupResultOutbox
		// Re-persist any command result that writePump popped but failed to
		// deliver (conn torn down mid-write, or a WriteMessage error) so it
		// isn't silently lost after SendResult already reported success. The
		// next reconnect's OnConnected flush redelivers it. (FIX 3)
		ws.OnResultWriteFailed = h.preserveUndeliveredResult
	}
}

// preserveUndeliveredResult persists a command result whose WS write failed to
// the backup-result outbox for redelivery on the next reconnect. Invoked from
// the websocket write pump (see Client.OnResultWriteFailed). This catches all
// failed command-result writes, not just backup results — the write pump can't
// distinguish them — which is safe: the outbox re-sends via SendResult and the
// server tolerates a late or duplicate terminal result.
func (h *Heartbeat) preserveUndeliveredResult(result websocket.CommandResult) {
	if h.backupOutbox == nil {
		return
	}
	h.backupOutbox.Enqueue(result)
}

// flushBackupResultOutbox retries delivery of any backup results persisted
// because a prior SendResult failed (WS blip). Called on every WS
// (re)connect via wsClient.OnConnected. A flush failure just leaves the
// entry on disk for the next reconnect.
func (h *Heartbeat) flushBackupResultOutbox() {
	if h.backupOutbox == nil || h.wsClient == nil {
		return
	}
	h.backupOutbox.Flush(h.wsClient.SendResult)
}

// SetAuthMonitor sets the shared auth-failure monitor.
func (h *Heartbeat) SetAuthMonitor(m *authstate.Monitor) {
	h.authMon = m
}

// SetStatePath sets the path to the agent state file for heartbeat updates.
func (h *Heartbeat) SetStatePath(path string) {
	h.statePath = path
}

func (h *Heartbeat) httpClient() *http.Client {
	h.clientMu.RLock()
	defer h.clientMu.RUnlock()
	return h.client
}

func (h *Heartbeat) setHTTPClient(client *http.Client) {
	h.clientMu.Lock()
	h.client = client
	h.clientMu.Unlock()
}

// AuditLog returns the audit logger for use by other components.
func (h *Heartbeat) AuditLog() *audit.Logger {
	return h.auditLog
}

// HealthMonitor returns the health monitor for use by other components.
func (h *Heartbeat) HealthMonitor() *health.Monitor {
	return h.healthMon
}

// SessionBroker returns the session broker for user helper connections.
func (h *Heartbeat) SessionBroker() *sessionbroker.Broker {
	return h.sessionBroker
}

// handleUserHelperMessage processes messages from user helpers that aren't
// responses to pending commands (e.g., tray actions).
func (h *Heartbeat) handleUserHelperMessage(session *sessionbroker.Session, env *ipc.Envelope) {
	switch env.Type {
	case ipc.TypeTrayAction:
		log.Info("tray action from user helper", "uid", session.UID, "sessionId", session.SessionID)
	case ipc.TypeNotifyResult:
		log.Debug("notify result from user helper", "uid", session.UID)
	case ipc.TypeSASRequest:
		go func() {
			defer func() {
				if r := recover(); r != nil {
					log.Error("panic in handleSASFromHelper", "error", fmt.Sprint(r))
				}
			}()
			h.handleSASFromHelper(session, env)
		}()
	case ipc.TypeDesktopPeerDisconnected:
		var notice ipc.DesktopPeerDisconnectedNotice
		if err := json.Unmarshal(env.Payload, &notice); err != nil {
			log.Warn("invalid desktop peer disconnect payload", "error", err.Error())
			return
		}
		if !desktopSessionIDPattern.MatchString(notice.SessionID) {
			log.Warn("dropping desktop peer disconnect with invalid session ID",
				"sessionId", notice.SessionID, "helperSession", session.SessionID)
			return
		}
		if owner := h.desktopOwnerSession(notice.SessionID); owner == nil || owner.SessionID != session.SessionID {
			log.Warn("dropping desktop peer disconnect for non-owned session",
				"sessionId", notice.SessionID, "helperSession", session.SessionID)
			return
		}
		h.forgetDesktopOwner(notice.SessionID)
		go h.sendDesktopDisconnectNotification(notice.SessionID)
	case backupipc.TypeBackupResult:
		// NOTE: do NOT early-return when wsClient is nil. The outbox needs no
		// live WS client, and a terminal backup result that arrives during
		// startup or a WS teardown gap must still be persisted so the next
		// reconnect flushes it — otherwise the server-side job is stuck
		// "running" until a reaper falsely fails it. (FIX 2)
		var backupResult backupipc.BackupCommandResult
		if err := json.Unmarshal(env.Payload, &backupResult); err != nil {
			log.Warn("invalid backup result payload", "error", err.Error())
			return
		}

		result := websocket.CommandResult{
			Type:      "command_result",
			CommandID: backupResult.CommandID,
			Status:    "failed",
		}
		if backupResult.Success {
			result.Status = "completed"
		}
		if backupResult.Stderr != "" {
			result.Error = backupResult.Stderr
		} else if backupResult.Stdout != "" {
			var parsed any
			if err := json.Unmarshal([]byte(backupResult.Stdout), &parsed); err == nil {
				result.Result = parsed
			} else {
				result.Result = backupResult.Stdout
			}
		}

		// No live WS client yet (startup) or the connection is torn down: skip
		// the send entirely and persist to the outbox so redelivery happens on
		// the next reconnect rather than dropping the result outright. (FIX 2)
		if h.wsClient == nil {
			if h.backupOutbox != nil {
				log.Info("no WS client for terminal backup result, persisting to outbox for retry on reconnect",
					"commandId", backupResult.CommandID)
				h.backupOutbox.Enqueue(result)
			} else {
				log.Warn("dropping terminal backup result: no WS client and no outbox configured",
					"commandId", backupResult.CommandID)
			}
			return
		}

		if err := h.wsClient.SendResult(result); err != nil {
			log.Warn("failed to send backup result, persisting to outbox for retry on reconnect",
				"commandId", backupResult.CommandID, "error", err.Error())
			if h.backupOutbox != nil {
				h.backupOutbox.Enqueue(result)
			}
		}
	case backupipc.TypeBackupProgress:
		if h.wsClient == nil {
			return
		}
		var progress backupipc.BackupProgress
		if err := json.Unmarshal(env.Payload, &progress); err != nil {
			log.Warn("invalid backup progress payload", "error", err.Error())
			return
		}
		if err := h.wsClient.SendBackupProgress(progress.CommandID, progress); err != nil {
			log.Warn("failed to send backup progress", "commandId", progress.CommandID, "error", err.Error())
		}
	default:
		log.Debug("unhandled user helper message", "type", env.Type, "uid", session.UID)
	}
}

// sendTerminalOutput streams terminal output via WebSocket
func (h *Heartbeat) sendTerminalOutput(sessionId string, data []byte) {
	if h.wsClient != nil {
		if err := h.wsClient.SendTerminalOutput(sessionId, data); err != nil {
			log.Warn("terminal output streaming failed", "sessionId", sessionId, "error", err.Error())
		}
	}
}

// sendUpdateStatus notifies the server that an agent self-update is about
// to start, so the device transitions to "updating" status.
func (h *Heartbeat) sendUpdateStatus(targetVersion string) {
	if h.wsClient == nil {
		log.Error("cannot send update_status: no WS client", "targetVersion", targetVersion)
		return
	}
	if err := h.wsClient.SendUpdateStatus(targetVersion); err != nil {
		log.Error("failed to send update_status, device will not show 'updating' in dashboard",
			"targetVersion", targetVersion, "error", err.Error())
	}
}

// sendDesktopDisconnectNotification tells the API that a WebRTC peer
// connection dropped so it can mark the session as disconnected and allow
// the viewer to reconnect.
func (h *Heartbeat) sendDesktopDisconnectNotification(sessionID string) {
	// Fire the end-of-session UX (banner hide + ended notice) for any session
	// that carried a consent/notify prompt. Runs on every disconnect path
	// (direct OnSessionStopped, IPC peer-disconnect, darwin handoff) and is a
	// no-op for un-prompted sessions. Done before the wsClient guard so the
	// local UX still tears down even if the WS link is gone.
	h.handleConsentSessionEnd(sessionID)

	if h.wsClient == nil {
		return
	}
	if !desktopSessionIDPattern.MatchString(sessionID) {
		log.Warn("refusing to send desktop disconnect notification with invalid session ID", "sessionId", sessionID)
		return
	}
	result := websocket.CommandResult{
		Type:      "command_result",
		CommandID: "desk-disconnect-" + sessionID,
		Status:    "completed",
		Result: map[string]any{
			"sessionId": sessionID,
			"event":     "peer_disconnected",
		},
	}
	if err := h.wsClient.SendResult(result); err != nil {
		log.Warn("failed to send desktop disconnect notification", "session", sessionID, "error", err.Error())
	}
}

// SCMSessionCh returns the channel for forwarding SCM session-change events
// to the helper lifecycle manager. Returns nil if the lifecycle manager is not
// active (non-service mode or non-Windows). Safe to call before Start().
func (h *Heartbeat) SCMSessionCh() chan<- sessionbroker.SCMSessionEvent {
	if h.scmSessionCh == nil {
		return nil
	}
	return h.scmSessionCh
}

// checkUpdateMarker looks for the transient .update-restart file written
// by the updater before restart. If found, deletes it and returns true
// so the caller can skip the startup jitter and heartbeat immediately.
func checkUpdateMarker() bool {
	markerPath := filepath.Join(config.ConfigDir(), ".update-restart")
	_, err := os.Stat(markerPath)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Warn("failed to check update marker", "path", markerPath, "error", err.Error())
		}
		return false
	}
	if removeErr := os.Remove(markerPath); removeErr != nil {
		log.Warn("failed to remove update marker", "path", markerPath, "error", removeErr.Error())
	}
	log.Info("update marker found, skipping startup jitter for immediate heartbeat")
	return true
}

func bootstrapThenListen(bootstrap func() error, listen func()) error {
	if bootstrap != nil {
		if err := bootstrap(); err != nil {
			return err
		}
	}
	if listen != nil {
		listen()
	}
	return nil
}

// lifecycleBootstrapRetryInterval matches the lifecycle reconcile cadence: both
// recover from the same transient WTS enumeration failure.
const lifecycleBootstrapRetryInterval = 30 * time.Second

// bootstrapThenListenWithRetry keeps the fail-closed contract of
// bootstrapThenListen — never listen without desired state — while making the
// failure recoverable. Bootstrap reaches WTSEnumerateSessionsW, which fails
// transiently when the agent service starts before Remote Desktop Services' RPC
// endpoint is ready. Without a retry, one boot-order flake costs the agent its
// pipe listener for the entire process lifetime: no remote desktop, no PAM, no
// helper IPC, while the machine keeps heartbeating healthy. The reconcile loop
// already treats this same error as transient and retries it.
//
// Blocks until bootstrap succeeds (then listens exactly once) or ctx is done.
func bootstrapThenListenWithRetry(ctx context.Context, bootstrap func() error, listen func(), retry time.Duration) {
	for {
		err := bootstrapThenListen(bootstrap, listen)
		if err == nil {
			return
		}
		log.Warn("helper lifecycle bootstrap failed; retrying before starting broker listener",
			"retryIn", retry.String(), "error", err.Error())
		select {
		case <-ctx.Done():
			log.Error("helper lifecycle bootstrap never succeeded; broker listener not started",
				"error", ctx.Err().Error())
			return
		case <-time.After(retry):
		}
	}
}

func (h *Heartbeat) Start() {
	// Proactively spawn helpers into user sessions so remote desktop works
	// instantly after reboot (Windows service only). The SCM session event
	// channel (created in constructor) is fed by the service handler
	// (service_windows.go) for instant notification; the lifecycle manager
	// also runs a slow reconcile tick as a safety net for helper crashes
	// and early-boot edge cases.
	var lifecycle *sessionbroker.HelperLifecycleManager
	if h.scmSessionCh != nil && h.sessionBroker != nil {
		ctx, cancel := context.WithCancel(context.Background())
		lifecycle = sessionbroker.NewHelperLifecycleManager(h.sessionBroker, h.scmSessionCh)
		h.mu.Lock()
		h.helperLifecycle = lifecycle
		h.lifecycleCancel = cancel
		h.mu.Unlock()
		go bootstrapThenListenWithRetry(ctx, lifecycle.Bootstrap, func() {
			go h.sessionBroker.Listen(h.stopChan)
		}, lifecycleBootstrapRetryInterval)
		go lifecycle.Start(ctx)
	} else if h.sessionBroker != nil {
		go h.sessionBroker.Listen(h.stopChan)
	}
	if h.sessionBroker != nil {
		h.startDarwinDesktopWatcher()
	}
	if h.sessionCol != nil {
		h.sessionCol.Start(h.stopChan)
	}

	// Jitter: random delay before first heartbeat to avoid thundering herd
	// after mass restart of agents. Skip jitter if restarting after self-update
	// so the new version is reported immediately.
	interval := time.Duration(h.config.HeartbeatIntervalSeconds) * time.Second
	if checkUpdateMarker() {
		log.Info("post-update restart: sending immediate heartbeat (jitter skipped)")
		// On macOS, the agent self-update recreates the IPC socket. The
		// desktop helpers lose their connection and may be waiting on
		// backoff. Kickstart them so remote desktop recovers immediately.
		if runtime.GOOS == "darwin" {
			go func() {
				time.Sleep(500 * time.Millisecond) // let IPC socket bind before kickstarting
				kickstartDarwinDesktopHelpers()
			}()
		}
	} else {
		jitter := time.Duration(rand.Int64N(int64(interval)))
		log.Info("initial heartbeat jitter", "delay", jitter)
		select {
		case <-time.After(jitter):
		case <-h.stopChan:
			return
		}
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	const bootCheckInterval = 5 * time.Minute
	var lastBootCheck time.Time
	// Self-heal a missing breeze-user-helper.exe (Windows), decoupled from
	// upgrades. Zero-valued timer → fires on the first tick (≈startup), then
	// every interval after (issue #816 follow-up).
	const userHelperCheckInterval = 30 * time.Minute
	var lastUserHelperCheck time.Time

	// Send initial heartbeat after jitter
	h.sendHeartbeatWithWatchdog()

	// Send initial inventory in background. Hardware and patch inventory are not
	// part of the sendInventory fan-out (they run on a daily cadence), so kick
	// them off here too — a freshly started/enrolled agent should report hardware
	// and pending patches promptly rather than waiting for the first daily tick.
	go h.sendInventory()
	go h.sendHardwareInventory()
	go h.sendPatchInventory()
	go h.runProcessSampler()

	// Reliability cadence persists across restarts (#1906). Seed the in-memory
	// timer from the last persisted post instead of "now", and only post on
	// startup if at least 24h have actually elapsed since then. Without this, a
	// restart-prone device (POS/checkout box, crash, auto-update) re-posted an
	// overlapping event-log window on every boot → duplicate reliability rows.
	// A zero persisted time (first-ever run / unreadable state) is older than
	// any threshold, so the very first post still goes out. The persisted
	// timestamp is advanced only on a confirmed send (see sendReliabilityMetrics),
	// so a failed startup post still retries after the next restart.
	startupNow := time.Now()
	persistedReliability := h.loadLastReliabilityUpdate()
	postReliability := reliabilityPostDue(persistedReliability, startupNow)
	h.mu.Lock()
	h.lastPostureUpdate = startupNow
	if postReliability {
		h.lastReliabilityUpdate = startupNow
	} else {
		h.lastReliabilityUpdate = persistedReliability
	}
	h.lastHardwareUpdate = startupNow
	h.lastPatchUpdate = startupNow
	h.mu.Unlock()
	if postReliability {
		go h.sendReliabilityMetrics(startupNow)
	}

	for {
		select {
		case <-ticker.C:
			if h.authMon != nil && h.authMon.ShouldSkip() {
				log.Debug("skipping heartbeat tick, auth-dead",
					"backoff", h.authMon.BackoffDuration())
				// continue here re-arms the ticker without running
				// sendHeartbeatWithWatchdog or any inventory/posture/security
				// scheduling — all of that work requires a valid auth token.
				continue
			}
			h.sendHeartbeatWithWatchdog()
			now := time.Now()
			// Send inventory every 15 minutes
			h.mu.Lock()
			shouldSendInventory := now.Sub(h.lastInventoryUpdate) > 15*time.Minute
			if shouldSendInventory {
				h.lastInventoryUpdate = now
			}
			shouldSendEventLogs := now.Sub(h.lastEventLogUpdate) > time.Duration(h.eventLogCol.IntervalMinutes())*time.Minute
			if shouldSendEventLogs {
				h.lastEventLogUpdate = now
			}
			shouldSendSecurity := now.Sub(h.lastSecurityUpdate) > 5*time.Minute
			if shouldSendSecurity {
				h.lastSecurityUpdate = now
			}
			shouldSendSessions := now.Sub(h.lastSessionUpdate) > 5*time.Minute
			if shouldSendSessions {
				h.lastSessionUpdate = now
			}
			shouldSendPosture := now.Sub(h.lastPostureUpdate) > 15*time.Minute
			if shouldSendPosture {
				h.lastPostureUpdate = now
			}
			shouldSendReliability := reliabilityPostDue(h.lastReliabilityUpdate, now)
			if shouldSendReliability {
				h.lastReliabilityUpdate = now
			}
			// Hardware identity rarely changes; collect once per day. The initial
			// send happens via the explicit startup dispatch (see Start), which
			// stamps lastHardwareUpdate; this gate handles every subsequent day.
			shouldSendHardware := dueForRun(now, h.lastHardwareUpdate, 24*time.Hour)
			if shouldSendHardware {
				h.lastHardwareUpdate = now
			}
			// Patch scan cadence is configurable (PatchScanIntervalHours, default 24 h).
			// Initial send is the explicit startup dispatch; this gate handles the rest.
			patchIntervalHours := clampPatchScanIntervalHours(h.config.PatchScanIntervalHours)
			shouldSendPatch := dueForRun(now, h.lastPatchUpdate, time.Duration(patchIntervalHours)*time.Hour)
			if shouldSendPatch {
				h.lastPatchUpdate = now
			}
			h.mu.Unlock()

			// Check for recent boot every few minutes (not every heartbeat tick).
			if now.Sub(lastBootCheck) >= bootCheckInterval {
				lastBootCheck = now
				if bootTime, err := host.BootTime(); err == nil && bootTime > 0 {
					uptimeSec := now.Unix() - int64(bootTime)
					bt := time.Unix(int64(bootTime), 0)
					if h.bootCol.ShouldCollect(uptimeSec, bt) {
						h.bootCol.MarkCollected(bt)
						go func() {
							defer observability.Recoverer("heartbeat.bootPerformance")
							log.Info("detected recent boot, collecting boot performance")
							metrics, err := h.bootCol.Collect()
							if err != nil {
								log.Error("failed to collect boot performance", "error", err.Error())
								return
							}
							// Check if agent is shutting down before sending
							select {
							case <-h.stopChan:
								return
							default:
							}
							h.sendBootPerformance(metrics)
						}()
					}
				}
			}

			// Reconcile a missing user-helper binary on Windows (issue #816
			// follow-up). Gated on an interval; the download only happens on the
			// genuine-absence path. Runs in a goroutine because it does network
			// I/O on the miss path. The auth-dead skip above already prevents
			// this block from running without a valid token.
			if now.Sub(lastUserHelperCheck) >= userHelperCheckInterval {
				lastUserHelperCheck = now
				go func() {
					defer observability.Recoverer("heartbeat.reconcileUserHelper")
					h.reconcileUserHelperFromExecutable()
				}()
			}

			if shouldSendInventory {
				go h.sendInventory()
			}
			// Send event logs every 5 minutes
			if shouldSendEventLogs {
				go h.sendEventLogs()
			}
			// Send security status every 5 minutes
			if shouldSendSecurity {
				go h.sendSecurityStatus()
				go h.sendRecoveryKeys()
			}
			if shouldSendSessions {
				go h.sendSessionInventory()
			}
			if shouldSendPosture {
				go h.sendManagementPosture()
			}
			if shouldSendReliability {
				// `now` was captured under the lock above; the persisted gate is
				// advanced to it only on a confirmed send (#1906).
				go h.sendReliabilityMetrics(now)
			}
			if shouldSendHardware {
				go h.sendHardwareInventory()
			}
			if shouldSendPatch {
				go h.sendPatchInventory()
			}
		case <-h.stopChan:
			return
		}
	}
}

// StopAcceptingCommands prevents new commands from being dispatched.
func (h *Heartbeat) StopAcceptingCommands() {
	h.accepting.Store(false)
	h.pool.StopAccepting()
}

// DrainAndWait waits for all in-flight commands and inventory goroutines to complete,
// respecting the context deadline.
func (h *Heartbeat) DrainAndWait(ctx context.Context) {
	log.Info("draining in-flight commands and inventory goroutines")
	h.pool.Drain(ctx)
	h.wg.Wait()

	// Wait for inventory goroutines with deadline
	done := make(chan struct{})
	go func() {
		h.inventoryWg.Wait()
		close(done)
	}()
	select {
	case <-done:
		log.Info("all commands and inventory goroutines drained")
	case <-ctx.Done():
		log.Warn("inventory goroutine drain timed out")
	}
}

func (h *Heartbeat) Stop() {
	h.stopOnce.Do(func() {
		shutdownTimeout := h.shutdownTimeout
		if shutdownTimeout <= 0 {
			shutdownTimeout = 5 * time.Second
		}
		ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()

		if h.stopBrokerAcceptingAndWait != nil {
			if err := h.stopBrokerAcceptingAndWait(ctx); err != nil {
				log.Warn("session broker pre-auth drain timed out", "error", err.Error())
			}
		} else if h.sessionBroker != nil {
			if err := h.sessionBroker.StopAcceptingAndWait(ctx); err != nil {
				log.Warn("session broker pre-auth drain timed out", "error", err.Error())
			}
		}

		if h.stopHelperLifecycleAndWait != nil {
			if err := h.stopHelperLifecycleAndWait(ctx); err != nil {
				log.Warn("helper lifecycle shutdown timed out", "error", err.Error())
			}
		} else {
			h.mu.Lock()
			lifecycle := h.helperLifecycle
			lifecycleCancel := h.lifecycleCancel
			h.mu.Unlock()
			if lifecycleCancel != nil {
				lifecycleCancel()
			}
			if lifecycle != nil {
				// Stop bounds its own cleanup work. Keep this synchronous so broker
				// close cannot overlap a still-running lifecycle cleanup goroutine.
				lifecycle.Stop()
				select {
				case <-lifecycle.Done():
				case <-ctx.Done():
					log.Warn("helper lifecycle reconcile loop did not stop before deadline")
				}
			}
		}

		if h.sessionBroker != nil {
			h.sessionBroker.StopBackupHelper()
		}
		if h.closeSessionBroker != nil {
			h.closeSessionBroker()
		} else if h.sessionBroker != nil {
			h.sessionBroker.Close()
		}

		if h.stopChan != nil {
			close(h.stopChan)
		}
		if h.rebootMgr != nil {
			h.rebootMgr.Stop()
		}
		if h.monitor != nil {
			h.monitor.Stop()
		}
		if h.auditLog != nil {
			h.auditLog.Log(audit.EventAgentStop, "", nil)
			h.auditLog.Close()
		}
		if h.helperMgr != nil {
			h.helperMgr.Shutdown()
		}
		if h.tunnelMgr != nil {
			h.tunnelMgr.Stop()
		}
	})
}

// sendMonitoringResults ships service/process check results to the API.
func (h *Heartbeat) sendMonitoringResults(results []monitoring.CheckResult) {
	if len(results) == 0 {
		return
	}

	payload := map[string]any{
		"results": results,
	}

	body, err := json.Marshal(payload)
	if err != nil {
		log.Error("failed to marshal monitoring results", "error", err.Error())
		return
	}

	url := h.monitoringResultsURL()
	headers := http.Header{
		"Content-Type":  {"application/json"},
		"Authorization": {h.authHeader()},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	resp, err := httputil.Do(ctx, h.httpClient(), "PUT", url, body, headers, h.retryCfg)
	if err != nil {
		log.Warn("failed to send monitoring results", "error", err.Error(), "count", len(results))
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Warn("monitoring results returned non-OK status", "status", resp.StatusCode, "count", len(results))
	}
}

// sendInventory collects and sends the 15-minute inventory set: software, disk,
// network, configuration changes, connections, policy registry/config state, and
// Apple warranty info. All goroutines are tracked via inventoryWg for graceful shutdown.
//
// Note: hardware inventory, patch inventory, security status, and session inventory
// are intentionally absent here — each runs on its own independent cadence:
//   - hardware / patch:   daily (or configured), dispatched from the tick gate
//   - security / sessions: every 5 minutes, dispatched from their own tick gates
func (h *Heartbeat) sendInventory() {
	fns := []func(){
		h.sendSoftwareInventory,
		h.sendDiskInventory,
		h.sendNetworkInventory,
		h.sendConfigurationChanges,
		h.sendConnectionsInventory,
		h.sendPolicyRegistryState,
		h.sendPolicyConfigState,
		h.sendAppleWarrantyInfo,
	}
	for _, fn := range fns {
		h.inventoryWg.Add(1)
		go func(f func()) {
			defer h.inventoryWg.Done()
			defer observability.Recoverer("heartbeat.inventory")
			f()
		}(fn)
	}
}

// authHeader returns the Bearer token for HTTP Authorization headers.
// Prefers secureToken; falls back to config plaintext only if secureToken is nil.
func (h *Heartbeat) authHeader() string {
	if h.secureToken != nil && !h.secureToken.IsZeroed() {
		return "Bearer " + h.secureToken.Reveal()
	}
	if h.config.AuthToken != "" {
		return "Bearer " + h.config.AuthToken
	}
	log.Warn("authHeader called with no available token")
	return "Bearer "
}

// sendInventoryData marshals the payload and sends it to the given endpoint via PUT.
func (h *Heartbeat) sendInventoryData(endpoint string, payload any, label string) error {
	body, err := json.Marshal(payload)
	if err != nil {
		log.Error("failed to marshal inventory", "label", label, "error", err.Error())
		return err
	}

	url := fmt.Sprintf("%s/api/v1/agents/%s/%s", h.serverURL(), h.config.AgentID, endpoint)
	headers := http.Header{
		"Content-Type":  {"application/json"},
		"Authorization": {h.authHeader()},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	resp, err := httputil.Do(ctx, h.httpClient(), "PUT", url, body, headers, h.retryCfg)
	if err != nil {
		log.Error("failed to send inventory", "label", label, "error", err.Error())
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= http.StatusOK && resp.StatusCode < http.StatusMultipleChoices {
		log.Debug("inventory sent", "label", label)
		return nil
	} else {
		log.Warn("inventory send failed", "label", label, "status", resp.StatusCode)
	}
	return fmt.Errorf("inventory send failed for %s: status %d", label, resp.StatusCode)
}

// processSampleTopN is the per-dimension top-N (CPU and RAM); the union is
// capped at 2×this and must stay ≤ the API ingest schema's processes.max(16).
const processSampleTopN = 8

// clampProcessSampleInterval bounds the configured sampler interval to a safe
// [60, 3600] second range. Pure (no side effects) so it can be unit-tested and
// so time.NewTicker never receives a non-positive duration.
func clampProcessSampleInterval(secs int) int {
	if secs < 60 {
		return 60
	}
	if secs > 3600 {
		return 3600
	}
	return secs
}

// clampPatchScanIntervalHours bounds the configured patch scan interval to
// [1, 168] hours (1 hour to 7 days). Pure (no side effects) so it can be
// unit-tested independently. A value ≤0 (unset/zero) returns the default.
func clampPatchScanIntervalHours(hours int) int {
	if hours <= 0 {
		return config.DefaultPatchScanIntervalHours
	}
	if hours > 168 {
		return 168
	}
	return hours
}

// dueForRun reports whether a periodic task is due — true once at least interval
// has elapsed since its last run. A zero-value last (never run) is always due.
// Pure, so the cadence math can be unit-tested independently of the tick loop.
func dueForRun(now, last time.Time, interval time.Duration) bool {
	return now.Sub(last) > interval
}

// runProcessSampler periodically captures a top-N process snapshot and POSTs it,
// on its own ticker decoupled from the heartbeat (spec: process-sample pipeline).
func (h *Heartbeat) runProcessSampler() {
	configured := h.config.ProcessSampleIntervalSeconds
	secs := clampProcessSampleInterval(configured)
	if secs != configured {
		log.Warn("clamped process_sample_interval_seconds", "configured", configured, "clamped", secs)
	}
	ticker := time.NewTicker(time.Duration(secs) * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			// Per-iteration recovery: a panic in a single sample must not kill the
			// long-lived sampler goroutine (a top-level defer Recoverer would).
			func() {
				defer observability.Recoverer("heartbeat.processSampler")
				if h.authMon != nil && h.authMon.ShouldSkip() {
					return
				}
				h.sendProcessSample()
			}()
		case <-h.stopChan:
			return
		}
	}
}

// sendProcessSample builds a top-N process snapshot and POSTs it to the ingest
// route, mirroring sendInventoryData's auth/retry/timeout handling.
func (h *Heartbeat) sendProcessSample() {
	entries, err := tools.TopProcessSample(processSampleTopN)
	if err != nil {
		log.Error("failed to collect process sample", "error", err.Error())
		return
	}

	payload := map[string]any{
		"timestamp": time.Now().UTC().Format(time.RFC3339),
		"processes": entries,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		log.Error("failed to marshal process sample", "error", err.Error())
		return
	}

	url := fmt.Sprintf("%s/api/v1/agents/%s/process-sample", h.serverURL(), h.config.AgentID)
	headers := http.Header{
		"Content-Type":  {"application/json"},
		"Authorization": {h.authHeader()},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	resp, err := httputil.Do(ctx, h.httpClient(), "POST", url, body, headers, h.retryCfg)
	if err != nil {
		log.Error("failed to send process sample", "error", err.Error())
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= http.StatusOK && resp.StatusCode < http.StatusMultipleChoices {
		log.Debug("process sample sent", "count", len(entries))
	} else {
		log.Warn("process sample send failed", "status", resp.StatusCode)
	}
}

// submitPeripheralEvents sends detected peripheral events to the server.
func (h *Heartbeat) submitPeripheralEvents(events []peripheral.PeripheralEvent) error {
	body, err := json.Marshal(peripheral.EventSubmission{Events: events})
	if err != nil {
		return fmt.Errorf("marshal peripheral events: %w", err)
	}

	url := fmt.Sprintf("%s/api/v1/agents/%s/peripherals/events", h.serverURL(), h.config.AgentID)
	headers := http.Header{
		"Content-Type":  {"application/json"},
		"Authorization": {h.authHeader()},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	resp, err := httputil.Do(ctx, h.httpClient(), "PUT", url, body, headers, h.retryCfg)
	if err != nil {
		return fmt.Errorf("PUT peripheral events: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("peripheral events submission failed: HTTP %d", resp.StatusCode)
	}
	return nil
}

func (h *Heartbeat) sendHardwareInventory() {
	hw, err := h.hardwareCol.CollectHardware()
	if err != nil {
		log.Error("failed to collect hardware info", "error", err.Error())
		return
	}
	h.sendInventoryData("hardware", hw, "hardware")
}

func (h *Heartbeat) sendAppleWarrantyInfo() {
	if runtime.GOOS != "darwin" {
		return
	}
	info, err := collectors.CollectAppleWarranty()
	if err != nil {
		log.Warn("failed to collect Apple warranty info", "error", err.Error())
		return
	}
	if info == nil {
		log.Debug("no Apple warranty plist data found")
		return
	}

	payload := map[string]any{
		"source":            "agent_plist",
		"manufacturer":      "Apple",
		"coverageEndDate":   info.CoverageEndDate,
		"coverageStartDate": info.CoverageStartDate,
		"coverageType":      info.CoverageType,
		"deviceName":        info.DeviceName,
	}
	// Only include coverageKind when the NDO verb is recognized; omit the key for
	// timestamp-only/labelless/localized/plist-fallback coverage where it can't be
	// classified (#1320). The API schema tolerates an empty/absent value and treats
	// it as fixed for back-compat (#1344), so omitting it here is safe — no 400.
	if info.CoverageKind != "" {
		payload["coverageKind"] = info.CoverageKind
	}
	h.sendInventoryData("warranty-info", payload, "apple warranty")
}

func (h *Heartbeat) sendSoftwareInventory() {
	software, err := h.softwareCol.Collect()
	if err != nil {
		log.Error("failed to collect software inventory", "error", err.Error())
		return
	}

	items := make([]map[string]any, len(software))
	for i, item := range software {
		items[i] = map[string]any{
			"name":            item.Name,
			"version":         item.Version,
			"vendor":          item.Vendor,
			"installDate":     item.InstallDate,
			"installLocation": item.InstallLocation,
			"uninstallString": item.UninstallString,
		}
	}

	h.sendInventoryData("software", map[string]any{"software": items}, fmt.Sprintf("software (%d items)", len(software)))
}

func (h *Heartbeat) sendDiskInventory() {
	disks, err := h.inventoryCol.CollectDisks()
	if err != nil {
		log.Error("failed to collect disk inventory", "error", err.Error())
		return
	}

	h.sendInventoryData("disks", map[string]any{"disks": disks}, fmt.Sprintf("disks (%d)", len(disks)))
}

func (h *Heartbeat) sendNetworkInventory() {
	adapters, err := h.inventoryCol.CollectNetworkAdapters()
	if err != nil {
		log.Error("failed to collect network inventory", "error", err.Error())
		return
	}

	// Active-VPN-client presence (#2139) rides along with the network payload
	// on the same cached-inventory cadence. Non-fatal: if VPN detection fails
	// we still ship the adapter list. Crucially we OMIT the `vpns` key on
	// failure rather than sending `[]` — an empty array means "collected, no
	// active VPN", and the API only overwrites the stored snapshot when the key
	// is present, so a transient failure preserves last-known state instead of
	// clobbering a live tunnel to "no VPN".
	payload := map[string]any{"adapters": adapters}
	vpnLabel := "vpns skipped"
	if h.vpnCol != nil {
		if detected, vErr := h.vpnCol.Collect(); vErr != nil {
			log.Warn("failed to collect VPN presence", "error", vErr.Error())
		} else {
			if detected == nil {
				detected = []collectors.VpnPresence{}
			}
			payload["vpns"] = detected
			vpnLabel = fmt.Sprintf("%d vpns", len(detected))
		}
	}

	h.sendInventoryData(
		"network",
		payload,
		fmt.Sprintf("network (%d adapters, %s)", len(adapters), vpnLabel),
	)
}

func (h *Heartbeat) sendConfigurationChanges() {
	if h.changeTrackerCol == nil {
		return
	}

	changes, err := h.changeTrackerCol.CollectChanges()
	if err != nil {
		log.Error("failed to collect configuration changes", "error", err.Error())
		return
	}

	if len(changes) == 0 {
		return
	}

	h.sendInventoryData("changes", map[string]any{"changes": changes}, fmt.Sprintf("changes (%d)", len(changes)))
}

func (h *Heartbeat) policyRegistryProbes() []collectors.RegistryProbe {
	h.mu.Lock()
	configured := slices.Clone(h.config.PolicyRegistryStateProbes)
	h.mu.Unlock()

	probes := make([]collectors.RegistryProbe, 0, len(configured))
	for _, probe := range configured {
		registryPath := strings.TrimSpace(probe.RegistryPath)
		valueName := strings.TrimSpace(probe.ValueName)
		if registryPath == "" || valueName == "" {
			continue
		}
		probes = append(probes, collectors.RegistryProbe{
			RegistryPath: registryPath,
			ValueName:    valueName,
		})
	}
	return probes
}

func (h *Heartbeat) policyConfigProbes() []collectors.ConfigProbe {
	h.mu.Lock()
	configured := slices.Clone(h.config.PolicyConfigStateProbes)
	h.mu.Unlock()

	probes := make([]collectors.ConfigProbe, 0, len(configured))
	for _, probe := range configured {
		filePath := strings.TrimSpace(probe.FilePath)
		configKey := strings.TrimSpace(probe.ConfigKey)
		if filePath == "" || configKey == "" {
			continue
		}
		probes = append(probes, collectors.ConfigProbe{
			FilePath:  filePath,
			ConfigKey: configKey,
		})
	}
	return probes
}

func normalizeProbePath(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func normalizeProbeKey(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func parsePolicyRegistryProbeList(raw any) ([]config.PolicyRegistryStateProbe, bool) {
	items, ok := raw.([]any)
	if !ok {
		return nil, false
	}

	probes := make([]config.PolicyRegistryStateProbe, 0, len(items))
	seen := make(map[string]struct{})
	for _, item := range items {
		record, ok := item.(map[string]any)
		if !ok {
			continue
		}

		registryPath := ""
		if value, exists := record["registry_path"]; exists {
			if typed, ok := value.(string); ok {
				registryPath = strings.TrimSpace(typed)
			}
		}
		if registryPath == "" {
			if value, exists := record["registryPath"]; exists {
				if typed, ok := value.(string); ok {
					registryPath = strings.TrimSpace(typed)
				}
			}
		}

		valueName := ""
		if value, exists := record["value_name"]; exists {
			if typed, ok := value.(string); ok {
				valueName = strings.TrimSpace(typed)
			}
		}
		if valueName == "" {
			if value, exists := record["valueName"]; exists {
				if typed, ok := value.(string); ok {
					valueName = strings.TrimSpace(typed)
				}
			}
		}

		if registryPath == "" || valueName == "" {
			continue
		}

		dedupeKey := normalizeProbePath(registryPath) + "::" + normalizeProbeKey(valueName)
		if _, exists := seen[dedupeKey]; exists {
			continue
		}
		seen[dedupeKey] = struct{}{}
		probes = append(probes, config.PolicyRegistryStateProbe{
			RegistryPath: registryPath,
			ValueName:    valueName,
		})
	}

	return probes, true
}

func parsePolicyConfigProbeList(raw any) ([]config.PolicyConfigStateProbe, bool) {
	items, ok := raw.([]any)
	if !ok {
		return nil, false
	}

	probes := make([]config.PolicyConfigStateProbe, 0, len(items))
	seen := make(map[string]struct{})
	for _, item := range items {
		record, ok := item.(map[string]any)
		if !ok {
			continue
		}

		filePath := ""
		if value, exists := record["file_path"]; exists {
			if typed, ok := value.(string); ok {
				filePath = strings.TrimSpace(typed)
			}
		}
		if filePath == "" {
			if value, exists := record["filePath"]; exists {
				if typed, ok := value.(string); ok {
					filePath = strings.TrimSpace(typed)
				}
			}
		}

		configKey := ""
		if value, exists := record["config_key"]; exists {
			if typed, ok := value.(string); ok {
				configKey = strings.TrimSpace(typed)
			}
		}
		if configKey == "" {
			if value, exists := record["configKey"]; exists {
				if typed, ok := value.(string); ok {
					configKey = strings.TrimSpace(typed)
				}
			}
		}

		if filePath == "" || configKey == "" {
			continue
		}

		dedupeKey := normalizeProbePath(filePath) + "::" + normalizeProbeKey(configKey)
		if _, exists := seen[dedupeKey]; exists {
			continue
		}
		seen[dedupeKey] = struct{}{}
		probes = append(probes, config.PolicyConfigStateProbe{
			FilePath:  filePath,
			ConfigKey: configKey,
		})
	}

	return probes, true
}

func equalPolicyRegistryProbes(left, right []config.PolicyRegistryStateProbe) bool {
	if len(left) != len(right) {
		return false
	}
	for idx := range left {
		if !strings.EqualFold(strings.TrimSpace(left[idx].RegistryPath), strings.TrimSpace(right[idx].RegistryPath)) {
			return false
		}
		if !strings.EqualFold(strings.TrimSpace(left[idx].ValueName), strings.TrimSpace(right[idx].ValueName)) {
			return false
		}
	}
	return true
}

func equalPolicyConfigProbes(left, right []config.PolicyConfigStateProbe) bool {
	if len(left) != len(right) {
		return false
	}
	for idx := range left {
		if !strings.EqualFold(strings.TrimSpace(left[idx].FilePath), strings.TrimSpace(right[idx].FilePath)) {
			return false
		}
		if !strings.EqualFold(strings.TrimSpace(left[idx].ConfigKey), strings.TrimSpace(right[idx].ConfigKey)) {
			return false
		}
	}
	return true
}

// decideBackupURLUpdate is the pure decision core for a pushed
// backup_server_url value. Empty string = clear, equal-to-primary and
// invalid values are ignored. Returns (newValue, apply).
func decideBackupURLUpdate(raw any, primary, current string) (string, bool) {
	s, ok := raw.(string)
	if !ok {
		log.Warn("ignoring non-string backup_server_url config update payload")
		return "", false
	}
	s = strings.TrimSpace(s)
	if s == current {
		return "", false
	}
	if s == "" {
		return "", true // clear
	}
	if s == primary {
		log.Debug("ignoring backup_server_url identical to primary server_url")
		return "", false
	}
	if err := config.ValidateBackupServerURL(s); err != nil {
		log.Warn("ignoring invalid backup_server_url config update", "error", err.Error())
		return "", false
	}
	return s, true
}

func (h *Heartbeat) applyBackupServerURLConfig(raw any) {
	h.mu.Lock()
	primary, current := h.config.ServerURL, h.config.BackupServerURL
	h.mu.Unlock()

	val, apply := decideBackupURLUpdate(raw, primary, current)
	if !apply {
		return
	}
	h.mu.Lock()
	h.config.BackupServerURL = val
	h.mu.Unlock()
	if err := config.SetAndPersist("backup_server_url", val); err != nil {
		log.Warn("failed to persist backup_server_url", "error", err.Error())
		return
	}
	if val == "" {
		log.Info("cleared backup server URL")
	} else {
		log.Info("stored backup server URL", "backupServerUrl", val)
	}
}

func (h *Heartbeat) applyConfigUpdate(update map[string]any) {
	if len(update) == 0 {
		return
	}

	// Apply event_log_settings if present
	elRaw, hasEL := update["event_log_settings"]
	if !hasEL {
		elRaw, hasEL = update["eventLogSettings"]
	}
	if hasEL {
		h.applyEventLogConfig(elRaw)
	}

	// Apply monitoring_settings if present.
	// The API may send config keys in either snake_case or camelCase; check both.
	monRaw, hasMon := update["monitoring_settings"]
	if !hasMon {
		monRaw, hasMon = update["monitoringSettings"]
	}
	if hasMon && h.monitor != nil {
		if cfg, ok := monitoring.ParseMonitorConfig(monRaw); ok {
			h.monitor.ApplyConfig(cfg)
		}
	}

	// Apply patch_source_settings if present (#1872): enforce/revert Breeze as
	// the sole Windows Update source. No-op on non-Windows.
	psRaw, hasPS := update["patch_source_settings"]
	if !hasPS {
		psRaw, hasPS = update["patchSourceSettings"]
	}
	if hasPS {
		h.applyPatchSourceConfig(psRaw)
	}

	// Backup control-plane URL (#2288). Key absent = no change; present
	// empty string = clear. Snake_case and camelCase both accepted.
	bsRaw, hasBS := update["backup_server_url"]
	if !hasBS {
		bsRaw, hasBS = update["backupServerUrl"]
	}
	if hasBS {
		h.applyBackupServerURLConfig(bsRaw)
	}

	// Apply onedrive_helper_settings if present (Phase 2). No-op on non-Windows.
	odRaw, hasOD := update["onedrive_helper_settings"]
	if !hasOD {
		odRaw, hasOD = update["onedriveHelperSettings"]
	}
	if hasOD {
		h.applyOneDriveHelperConfig(odRaw)
	}

	registryRaw, hasRegistry := update["policy_registry_state_probes"]
	if !hasRegistry {
		registryRaw, hasRegistry = update["policyRegistryStateProbes"]
	}

	configRaw, hasConfig := update["policy_config_state_probes"]
	if !hasConfig {
		configRaw, hasConfig = update["policyConfigStateProbes"]
	}

	if !hasRegistry && !hasConfig {
		return
	}

	var (
		parsedRegistry []config.PolicyRegistryStateProbe
		parsedConfig   []config.PolicyConfigStateProbe
		ok             bool
	)

	if hasRegistry {
		parsedRegistry, ok = parsePolicyRegistryProbeList(registryRaw)
		if !ok {
			log.Warn("ignoring invalid policy_registry_state_probes config update payload")
			hasRegistry = false
		}
	}
	if hasConfig {
		parsedConfig, ok = parsePolicyConfigProbeList(configRaw)
		if !ok {
			log.Warn("ignoring invalid policy_config_state_probes config update payload")
			hasConfig = false
		}
	}

	if !hasRegistry && !hasConfig {
		return
	}

	registryChanged := false
	configChanged := false
	registryCount := 0
	configCount := 0

	h.mu.Lock()
	if hasRegistry && !equalPolicyRegistryProbes(h.config.PolicyRegistryStateProbes, parsedRegistry) {
		h.config.PolicyRegistryStateProbes = parsedRegistry
		registryChanged = true
	}
	if hasConfig && !equalPolicyConfigProbes(h.config.PolicyConfigStateProbes, parsedConfig) {
		h.config.PolicyConfigStateProbes = parsedConfig
		configChanged = true
	}
	registryCount = len(h.config.PolicyRegistryStateProbes)
	configCount = len(h.config.PolicyConfigStateProbes)
	h.mu.Unlock()

	if registryChanged || configChanged {
		log.Info(
			"applied config update",
			"policyRegistryStateProbes", registryCount,
			"policyConfigStateProbes", configCount,
		)
	}
}

func (h *Heartbeat) applyEventLogConfig(raw any) {
	m, ok := raw.(map[string]any)
	if !ok {
		log.Warn("ignoring invalid event_log_settings payload: not an object")
		return
	}

	// JSON numbers are float64 in Go
	asInt := func(key string) int {
		if v, ok := m[key]; ok {
			switch n := v.(type) {
			case float64:
				return int(n)
			case int:
				return n
			}
		}
		return 0
	}

	asString := func(key string) string {
		if v, ok := m[key].(string); ok {
			return v
		}
		return ""
	}

	asStringSlice := func(key string) []string {
		arr, ok := m[key].([]any)
		if !ok {
			return nil
		}
		var result []string
		for _, item := range arr {
			if s, ok := item.(string); ok {
				result = append(result, s)
			}
		}
		return result
	}

	maxEvents := asInt("max_events_per_cycle")
	if maxEvents == 0 {
		maxEvents = asInt("maxEventsPerCycle")
	}
	categories := asStringSlice("collect_categories")
	if len(categories) == 0 {
		categories = asStringSlice("collectCategories")
	}
	minLevel := asString("minimum_level")
	if minLevel == "" {
		minLevel = asString("minimumLevel")
	}
	interval := asInt("collection_interval_minutes")
	if interval == 0 {
		interval = asInt("collectionIntervalMinutes")
	}

	if maxEvents > 0 || len(categories) > 0 || minLevel != "" || interval > 0 {
		changed := h.eventLogCol.UpdateConfig(maxEvents, categories, minLevel, interval)
		if changed {
			logFields := []any{}
			if maxEvents > 0 {
				logFields = append(logFields, "maxEventsPerCycle", maxEvents)
			}
			if len(categories) > 0 {
				logFields = append(logFields, "collectCategories", categories)
			}
			if minLevel != "" {
				logFields = append(logFields, "minimumLevel", minLevel)
			}
			if interval > 0 {
				logFields = append(logFields, "collectionIntervalMinutes", interval)
			}
			log.Info("applied event log config update", logFields...)
		}
	} else if len(m) > 0 {
		keys := make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		log.Warn("event_log_settings received but no recognized fields found", "keys", keys)
	}
}

func (h *Heartbeat) sendPolicyRegistryState() {
	entries, err := h.policyStateCol.CollectRegistryState(h.policyRegistryProbes())
	if err != nil {
		log.Warn("failed to collect policy registry state", "error", err.Error())
	}

	h.sendInventoryData(
		"registry-state",
		map[string]any{
			"entries": entries,
			"replace": true,
		},
		fmt.Sprintf("registry state (%d entries)", len(entries)),
	)
}

func (h *Heartbeat) sendPolicyConfigState() {
	entries, err := h.policyStateCol.CollectConfigState(h.policyConfigProbes())
	if err != nil {
		log.Warn("failed to collect policy config state", "error", err.Error())
	}

	h.sendInventoryData(
		"config-state",
		map[string]any{
			"entries": entries,
			"replace": true,
		},
		fmt.Sprintf("config state (%d entries)", len(entries)),
	)
}

func (h *Heartbeat) sendPatchInventory() {
	pendingItems, installedItems, coveredSources, err := h.collectPatchInventory()
	if err != nil {
		log.Warn("patch inventory collection warning", "error", err.Error())
	}
	installedItems = installedPatchStateItems(installedItems)

	if len(pendingItems) == 0 && len(installedItems) == 0 {
		log.Debug("no patches found")
		return
	}

	pendingErr, installedErr := h.sendPatchInventoryData(pendingItems, installedItems, "", true, coveredSources)
	if pendingErr != nil {
		log.Warn("failed to send pending patch inventory", "error", pendingErr.Error())
	}
	if installedErr != nil {
		log.Warn("failed to send installed patch inventory", "error", installedErr.Error())
	}
}

// sendPatchInventoryData uploads pending then installed patch inventory.
// coveredSources only applies to full uploads: when non-nil it tells the API
// which source buckets this scan actually covered, so pending rows from
// skipped providers (e.g. winget without a helper session) aren't swept to
// 'missing' (#2217). A nil coveredSources preserves the legacy full sweep.
func (h *Heartbeat) sendPatchInventoryData(pendingItems, installedItems []map[string]any, source string, full bool, coveredSources []string) (error, error) {
	installedItems = installedPatchStateItems(installedItems)
	pendingPayload := map[string]any{
		"patches": pendingItems,
	}
	if source != "" {
		pendingPayload["source"] = source
	} else if full {
		pendingPayload["full"] = true
		if coveredSources != nil {
			pendingPayload["coveredSources"] = coveredSources
		}
	}

	pendingErr := h.sendInventoryData(
		"patches/pending",
		pendingPayload,
		fmt.Sprintf("pending patches (%d)", len(pendingItems)),
	)
	if pendingErr != nil {
		return pendingErr, nil
	}
	if len(installedItems) == 0 {
		return nil, nil
	}
	installedErr := h.sendInventoryData(
		"patches/installed",
		map[string]any{"installed": installedItems},
		fmt.Sprintf("installed patches (%d)", len(installedItems)),
	)
	return nil, installedErr
}

func installedPatchStateItems(items []map[string]any) []map[string]any {
	filtered := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if source, ok := item["source"].(string); ok && source == "linux" {
			continue
		}
		filtered = append(filtered, item)
	}
	return filtered
}

// collectPatchInventory gathers pending + installed patch inventory. The third
// return value lists the source buckets the scan actually covered (see
// coveredPatchSources); it is nil on the legacy collector path, which carries
// no per-provider coverage information.
func (h *Heartbeat) collectPatchInventory() ([]map[string]any, []map[string]any, []string, error) {
	if h.patchMgr != nil && len(h.patchMgr.ProviderIDs()) > 0 {
		available, coveredProviders, scanErr := h.patchMgr.ScanWithCoverage()
		installed, installedErr := h.patchMgr.GetInstalled()

		pendingItems := h.availablePatchesToMaps(available)
		installedItems := h.installedPatchesToMaps(installed)
		coveredSources := h.coveredPatchSources(h.patchMgr.ProviderIDs(), coveredProviders)

		// Surface the coverage decision so a field operator can correlate a
		// narrowed full-scan sweep on the server with which providers actually
		// ran on the agent (#2217). When some registered source buckets weren't
		// covered (a provider was skipped/failed — e.g. winget with no helper
		// session), log at Info which buckets will NOT be swept this scan, so the
		// chronically-unswept-bucket case is explainable in the field rather than
		// mute on the happy path. Full coverage stays at Debug.
		if uncovered := h.uncoveredPatchSources(h.patchMgr.ProviderIDs(), coveredSources); len(uncovered) > 0 {
			log.Info("patch scan partial coverage; these source buckets will not be swept to missing this scan",
				"coveredSources", coveredSources,
				"uncoveredSources", uncovered)
		} else {
			log.Debug("patch scan full coverage", "coveredSources", coveredSources)
		}

		if scanErr != nil && installedErr != nil {
			return pendingItems, installedItems, coveredSources, fmt.Errorf("patch scan failed: %v; installed scan failed: %v", scanErr, installedErr)
		}
		if scanErr != nil {
			return pendingItems, installedItems, coveredSources, scanErr
		}
		if installedErr != nil {
			return pendingItems, installedItems, coveredSources, installedErr
		}

		return pendingItems, installedItems, coveredSources, nil
	}

	pendingItems, installedItems, err := h.collectPatchInventoryFromCollectors()
	return pendingItems, installedItems, nil, err
}

// coveredPatchSources maps the provider IDs that actually scanned to the API
// source buckets they feed. A bucket only counts as covered when EVERY
// registered provider mapping to it ran: multiple providers can share a bucket
// (winget + chocolatey → third_party), and sweeping the bucket while one of
// them was skipped would tombstone the skipped provider's rows — the exact bug
// this guards against (#2217). Always returns a non-nil slice so a scan where
// everything was skipped serializes as an empty coveredSources array (sweep
// nothing) rather than being omitted (legacy sweep-all).
//
// INTERIM LIMITATION (until #2216 lands): the coverage mechanism keys off
// providers returning patching.ErrScanSkipped, but the current winget provider
// still returns (nil, nil) when it can't run (no connected user helper session)
// instead of the sentinel. So a skipped winget is counted as "scanned and found
// nothing" and its third_party bucket is treated as COVERED — the coverage guard
// is inert-but-correct for winget: it never wrongly narrows the sweep, it just
// can't yet protect winget's own rows. #2216 splits winget.go and has its SYSTEM
// provider adopt ErrScanSkipped, at which point this mechanism becomes fully
// effective for winget with no change here. Do not edit winget.go for #2217.
func (h *Heartbeat) coveredPatchSources(providerIDs, coveredProviders []string) []string {
	coveredSet := make(map[string]bool, len(coveredProviders))
	for _, id := range coveredProviders {
		coveredSet[id] = true
	}

	fullyCovered := make(map[string]bool)
	for _, id := range providerIDs {
		source := h.mapPatchProviderSource(id)
		if _, seen := fullyCovered[source]; !seen {
			fullyCovered[source] = true
		}
		if !coveredSet[id] {
			fullyCovered[source] = false
		}
	}

	sources := make([]string, 0, len(fullyCovered))
	for source, covered := range fullyCovered {
		if covered {
			sources = append(sources, source)
		}
	}
	slices.Sort(sources)
	return sources
}

// uncoveredPatchSources returns the source buckets that the registered
// providers map to but that coveredSources does NOT include — i.e. buckets a
// full scan will leave untouched because a provider feeding them was skipped or
// failed. Used purely for operator-facing logging (#2217).
func (h *Heartbeat) uncoveredPatchSources(providerIDs, coveredSources []string) []string {
	coveredSet := make(map[string]bool, len(coveredSources))
	for _, s := range coveredSources {
		coveredSet[s] = true
	}

	seen := make(map[string]bool)
	uncovered := make([]string, 0)
	for _, id := range providerIDs {
		source := h.mapPatchProviderSource(id)
		if coveredSet[source] || seen[source] {
			continue
		}
		seen[source] = true
		uncovered = append(uncovered, source)
	}
	slices.Sort(uncovered)
	return uncovered
}

func (h *Heartbeat) availablePatchesToMaps(patches []patching.AvailablePatch) []map[string]any {
	items := make([]map[string]any, len(patches))
	for i, p := range patches {
		severity := p.Severity
		if severity == "" {
			severity = "unknown"
		}
		source := h.mapPatchProviderSource(p.Provider)
		category := p.Category
		if category == "" {
			category = h.mapPatchProviderCategory(p.Provider)
		}
		// Homebrew provider IDs encode casks as "homebrew:cask:<name>".
		// Preserve that distinction so UI can show richer macOS package details.
		if p.Provider == "homebrew" {
			if strings.HasPrefix(p.ID, "homebrew:cask:") {
				category = "homebrew-cask"
			} else {
				category = "homebrew"
			}
		}
		externalId := p.KBNumber
		if externalId == "" {
			externalId = p.ID
			if source == "linux" && p.Version != "" {
				externalId = p.ID + "@" + p.Version
			}
		}
		items[i] = map[string]any{
			"name":            p.Title,
			"version":         p.Version,
			"category":        category,
			"severity":        severity,
			"description":     p.Description,
			"source":          source,
			"externalId":      externalId,
			"packageId":       p.ID,
			"vendor":          extractVendor(p.Provider, p.ID),
			"kbNumber":        p.KBNumber,
			"size":            p.Size,
			"requiresRestart": p.RebootRequired,
			"releaseDate":     p.ReleaseDate,
		}
	}
	return items
}

func (h *Heartbeat) installedPatchesToMaps(patches []patching.InstalledPatch) []map[string]any {
	items := make([]map[string]any, len(patches))
	for i, p := range patches {
		category := p.Category
		if category == "" {
			category = h.mapPatchProviderCategory(p.Provider)
		}
		externalId := p.KBNumber
		if externalId == "" {
			externalId = p.ID
		}
		m := map[string]any{
			"name":       p.Title,
			"version":    p.Version,
			"category":   category,
			"source":     h.mapPatchProviderSource(p.Provider),
			"externalId": externalId,
			"packageId":  p.ID,
			"vendor":     extractVendor(p.Provider, p.ID),
		}
		if p.KBNumber != "" {
			m["kbNumber"] = p.KBNumber
		}
		if p.InstalledAt != "" {
			m["installedAt"] = p.InstalledAt
		}
		items[i] = m
	}
	return items
}

func (h *Heartbeat) collectPatchInventoryFromCollectors() ([]map[string]any, []map[string]any, error) {
	patches, collectErr := h.patchCol.Collect()
	installedPatches, installedErr := h.patchCol.CollectInstalled(90 * 24 * time.Hour)

	pendingItems := make([]map[string]any, len(patches))
	for i, patch := range patches {
		pendingItems[i] = map[string]any{
			"name":            patch.Name,
			"version":         patch.Version,
			"currentVersion":  patch.CurrentVer,
			"kbNumber":        patch.KBNumber,
			"externalId":      patch.KBNumber,
			"category":        patch.Category,
			"severity":        h.mapPatchSeverity(patch.Severity),
			"size":            patch.Size,
			"requiresRestart": patch.IsRestart,
			"releaseDate":     patch.ReleaseDate,
			"description":     patch.Description,
			"source":          h.mapPatchSource(patch.Source),
		}
	}

	installedItems := make([]map[string]any, len(installedPatches))
	for i, patch := range installedPatches {
		m := map[string]any{
			"name":        patch.Name,
			"version":     patch.Version,
			"category":    patch.Category,
			"source":      h.mapPatchSource(patch.Source),
			"installedAt": patch.InstalledAt,
			"externalId":  patch.KBNumber,
		}
		if patch.KBNumber != "" {
			m["kbNumber"] = patch.KBNumber
		}
		installedItems[i] = m
	}

	if collectErr != nil && installedErr != nil {
		return pendingItems, installedItems, fmt.Errorf("patch collect failed: %v; installed collect failed: %v", collectErr, installedErr)
	}
	if collectErr != nil {
		return pendingItems, installedItems, collectErr
	}
	if installedErr != nil {
		return pendingItems, installedItems, installedErr
	}

	return pendingItems, installedItems, nil
}

func (h *Heartbeat) mapPatchSource(source string) string {
	switch source {
	case "apple", "homebrew":
		return "apple"
	case "microsoft":
		return "microsoft"
	case "apt", "yum", "dnf":
		return "linux"
	default:
		return "custom"
	}
}

func (h *Heartbeat) mapPatchProviderSource(provider string) string {
	switch provider {
	case "windows-update":
		return "microsoft"
	case "apple-softwareupdate":
		return "apple"
	case "homebrew":
		return "third_party"
	case "chocolatey":
		return "third_party"
	case "winget":
		return "third_party"
	case "apt", "yum":
		return "linux"
	default:
		return "custom"
	}
}

func (h *Heartbeat) mapPatchProviderCategory(provider string) string {
	switch provider {
	case "windows-update", "apple-softwareupdate":
		return "system"
	case "homebrew", "chocolatey", "winget":
		return "application"
	case "apt", "yum":
		return "system"
	default:
		return "application"
	}
}

func extractVendor(provider, packageID string) string {
	if provider != "winget" {
		return ""
	}
	if i := strings.Index(packageID, "."); i > 0 {
		return packageID[:i]
	}
	return ""
}

func (h *Heartbeat) mapPatchSeverity(severity string) string {
	switch severity {
	case "critical", "important", "moderate", "low":
		return severity
	default:
		return "unknown"
	}
}

func (h *Heartbeat) sendConnectionsInventory() {
	connections, err := h.connectionsCol.Collect()
	if err != nil {
		log.Error("failed to collect connections", "error", err.Error())
		return
	}

	if len(connections) == 0 {
		log.Debug("no active connections found")
		return
	}

	items := make([]map[string]any, len(connections))
	for i, conn := range connections {
		items[i] = map[string]any{
			"protocol":    conn.Protocol,
			"localAddr":   conn.LocalAddr,
			"localPort":   conn.LocalPort,
			"remoteAddr":  conn.RemoteAddr,
			"remotePort":  conn.RemotePort,
			"state":       conn.State,
			"pid":         conn.Pid,
			"processName": conn.ProcessName,
		}
	}

	h.sendInventoryData("connections", map[string]any{"connections": items}, fmt.Sprintf("connections (%d active)", len(connections)))
}

func (h *Heartbeat) sendEventLogs() {
	events, err := h.eventLogCol.Collect()
	if err != nil {
		log.Error("failed to collect event logs", "error", err.Error())
		return
	}

	if len(events) == 0 {
		return
	}

	h.sendInventoryData("eventlogs", map[string]any{"events": events}, fmt.Sprintf("event logs (%d events)", len(events)))
}

func (h *Heartbeat) sendSecurityStatus() {
	status, err := security.CollectStatus(h.config)
	if err != nil {
		log.Warn("security status collection warning", "error", err.Error())
	}

	h.sendInventoryData("security/status", status, "security status")
}

// sendRecoveryKeys escrows the device's BitLocker recovery keys. Runs on the
// security tick but only transmits when the key set changed (fingerprint
// gate) — recovery keys should not transit the wire every 5 minutes. Also
// drains rotation results whose upload previously failed.
func (h *Heartbeat) sendRecoveryKeys() {
	h.mu.Lock()
	pending := h.pendingRecoveryKeys
	h.pendingRecoveryKeys = nil
	h.mu.Unlock()
	if len(pending) > 0 {
		if err := h.pushRecoveryKeys("rotation", pending); err != nil {
			h.mu.Lock()
			h.pendingRecoveryKeys = append(pending, h.pendingRecoveryKeys...)
			h.mu.Unlock()
			// Re-park failed: these rotated keys are still unescrowed and remain
			// in memory only (lost on restart). Escalate above the generic
			// inventory WARN so the risk is greppable; no key material logged.
			log.Error("parked recovery key escrow retry failed — keys remain in memory only and will be LOST on agent restart",
				"count", len(pending), "error", err.Error())
		}
	}

	keys, err := security.CollectRecoveryKeys()
	if err != nil {
		log.Warn("recovery key collection failed", "error", err.Error())
		return
	}
	fp := security.FingerprintRecoveryKeys(keys)
	h.mu.Lock()
	last := h.lastRecoveryKeysFP
	h.mu.Unlock()
	if fp == last {
		return
	}
	if err := h.pushRecoveryKeys("snapshot", keys); err != nil {
		return
	}
	h.mu.Lock()
	h.lastRecoveryKeysFP = fp
	h.mu.Unlock()
}

// pushRecoveryKeys uploads keys for escrow. Key material is never logged —
// sendInventoryData logs only the label.
func (h *Heartbeat) pushRecoveryKeys(source string, keys []security.RecoveryKey) error {
	if keys == nil {
		keys = []security.RecoveryKey{} // marshal as [], not null (zod rejects null)
	}
	payload := map[string]any{"source": source, "keys": keys}
	return h.sendInventoryData("security/recovery-keys", payload, fmt.Sprintf("recovery keys (%s, %d)", source, len(keys)))
}

func (h *Heartbeat) sendManagementPosture() {
	posture := mgmtdetect.CollectPosture()
	total := 0
	for _, dets := range posture.Categories {
		total += len(dets)
	}
	h.sendInventoryData("management/posture", posture, fmt.Sprintf("management posture (%d detections)", total))
}

func (h *Heartbeat) sendSessionInventory() {
	if h.sessionCol == nil {
		return
	}

	sessions, err := h.sessionCol.Collect()
	if err != nil {
		log.Warn("failed to collect sessions", "error", err.Error())
		return
	}
	events := h.sessionCol.DrainEvents(256)
	if events == nil {
		events = []collectors.UserSessionEvent{}
	}

	payload := map[string]any{
		"sessions":    sessions,
		"events":      events,
		"collectedAt": time.Now().UTC(),
	}
	h.sendInventoryData("sessions", payload, fmt.Sprintf("sessions (%d active, %d events)", len(sessions), len(events)))
}

func (h *Heartbeat) sendBootPerformance(metrics *collectors.BootPerformanceMetrics) {
	body, err := json.Marshal(metrics)
	if err != nil {
		log.Error("failed to marshal boot performance", "error", err.Error())
		return
	}
	url := fmt.Sprintf("%s/api/v1/agents/%s/boot-performance", h.serverURL(), h.config.AgentID)
	headers := http.Header{
		"Content-Type":  {"application/json"},
		"Authorization": {h.authHeader()},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	resp, err := httputil.Do(ctx, h.httpClient(), "POST", url, body, headers, h.retryCfg)
	if err != nil {
		log.Error("failed to send boot performance", "error", err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		errBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		log.Warn("boot performance upload returned non-success",
			"status", resp.StatusCode,
			"body", string(errBody))
	} else {
		log.Info("boot performance uploaded successfully")
	}
}

// sendReliabilityMetrics collects and uploads reliability metrics. On a
// confirmed 2xx it persists sentAt as the last-send time so the 24h cadence
// survives restarts (#1906); on any failure the persisted gate is left stale
// so the next restart retries.
func (h *Heartbeat) sendReliabilityMetrics(sentAt time.Time) {
	if h.reliabilityCol == nil {
		return
	}

	metrics, err := h.reliabilityCol.Collect()
	if err != nil {
		log.Error("failed to collect reliability metrics", "error", err.Error())
		return
	}

	body, err := json.Marshal(metrics)
	if err != nil {
		log.Error("failed to marshal reliability metrics", "error", err.Error())
		return
	}

	url := fmt.Sprintf("%s/api/v1/agents/%s/reliability", h.serverURL(), h.config.AgentID)
	headers := http.Header{
		"Content-Type":  {"application/json"},
		"Authorization": {h.authHeader()},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	resp, err := httputil.Do(ctx, h.httpClient(), "POST", url, body, headers, h.retryCfg)
	if err != nil {
		log.Error("failed to send reliability metrics", "error", err.Error())
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		errBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		log.Warn("reliability metrics upload returned non-success",
			"status", resp.StatusCode,
			"body", string(errBody))
		return
	}

	// Confirmed success — advance the persisted 24h gate (#1906).
	h.persistReliabilitySent(sentAt)

	log.Info("reliability metrics uploaded successfully",
		"crashes", len(metrics.CrashEvents),
		"hangs", len(metrics.AppHangs),
		"serviceFailures", len(metrics.ServiceFailures),
		"hardwareErrors", len(metrics.HardwareErrors))
}

// heartbeatWatchdogTimeoutNs is the duration (in nanoseconds) after which
// sendHeartbeatWithWatchdog dumps all goroutine stacks if the wrapped send
// has not returned. Stored as an int64 via sync/atomic so tests can override
// it from another goroutine without tripping -race. Tests may shorten it via
// setHeartbeatWatchdogTimeout().
//
// Production default is 90s. The watchdog times the WHOLE runHeartbeat() —
// metrics collection, the primary POST (one 30s-capped context around the
// retry loop), and once consecutive failures reach backupProbeThreshold
// (with a backup URL configured) a second full backup-probe POST (another
// 30s cap) — so a routine slow/flapping uplink legitimately takes up to
// ~60-65s. The watchdog exists to catch indefinite broker-mutex starvation
// (#387), which blows past any finite bound, so 90s keeps the diagnostic
// while never firing on a merely degraded link (#2386: a 15s timeout fired
// on every heartbeat for days on a slow macOS uplink).
var heartbeatWatchdogTimeoutNs atomic.Int64

// heartbeatWatchdogDumpIntervalNs rate-limits the expensive part of a
// watchdog fire (stop-the-world runtime.Stack over all goroutines + a multi-KB
// WARN log the shipper uploads): at most one goroutine dump per interval,
// across invocations. Fires inside the interval log a cheap one-line WARN
// with a suppressed counter instead. Atomic so tests can shrink it.
var heartbeatWatchdogDumpIntervalNs atomic.Int64

// heartbeatWatchdogLastDumpNs is the unix-nano timestamp of the last emitted
// goroutine dump (0 = never). heartbeatWatchdogSuppressedDumps counts fires
// whose dump was rate-limited since the last emitted dump.
var (
	heartbeatWatchdogLastDumpNs      atomic.Int64
	heartbeatWatchdogSuppressedDumps atomic.Int64
)

// heartbeatWatchdogMaxDumpBytes caps the raw goroutine dump put in the WARN
// log's `goroutines` field. The API's log endpoint rejects any entry whose
// stringified `fields` object exceeds 32,000 chars — and one oversized entry
// 400s the WHOLE shipped batch (#2386). Typical dumps inflate only a few
// percent under JSON escaping (one \n + one \t per frame line), but the cap
// is sized for the ~2x worst case where every char escapes to two
// (TestWatchdogDumpFitsAPIFieldsLimit models this): 12KB*2 leaves headroom
// under the ceiling. Pathological dumps heavy in <>& (six-byte \u00XX
// escapes) are backstopped by the shipper's capFields, which replaces
// oversized fields with a marker rather than burning the batch.
const heartbeatWatchdogMaxDumpBytes = 12 * 1024

func init() {
	heartbeatWatchdogTimeoutNs.Store(int64(90 * time.Second))
	heartbeatWatchdogDumpIntervalNs.Store(int64(10 * time.Minute))
}

// heartbeatWatchdogTimeout returns the current watchdog timeout as a duration.
func heartbeatWatchdogTimeout() time.Duration {
	return time.Duration(heartbeatWatchdogTimeoutNs.Load())
}

// setHeartbeatWatchdogTimeout overrides the watchdog timeout and returns the
// previous value. Intended for tests — production code should leave the
// default alone.
func setHeartbeatWatchdogTimeout(d time.Duration) time.Duration {
	return time.Duration(heartbeatWatchdogTimeoutNs.Swap(int64(d)))
}

// heartbeatWatchdogDumpInterval returns the current minimum interval between
// emitted goroutine dumps.
func heartbeatWatchdogDumpInterval() time.Duration {
	return time.Duration(heartbeatWatchdogDumpIntervalNs.Load())
}

// setHeartbeatWatchdogDumpInterval overrides the dump rate-limit interval and
// returns the previous value. Intended for tests.
func setHeartbeatWatchdogDumpInterval(d time.Duration) time.Duration {
	return time.Duration(heartbeatWatchdogDumpIntervalNs.Swap(int64(d)))
}

// resetHeartbeatWatchdogDumpState clears the cross-invocation rate-limit
// state (last-dump timestamp + suppressed counter). Intended for tests.
func resetHeartbeatWatchdogDumpState() {
	heartbeatWatchdogLastDumpNs.Store(0)
	heartbeatWatchdogSuppressedDumps.Store(0)
}

// heartbeatWatchdogTryAcquireDump reports whether a goroutine dump may be
// emitted now, atomically claiming the slot if so. Safe for concurrent
// watchdog goroutines (overlapping invocations race for one slot).
//
// The slot is consumed even if the resulting WARN entry is later dropped by
// a full shipper buffer — acceptable because the dump still reaches the
// local log via the base handler, and when the buffer is full (network
// dead) nothing would ship anyway.
func heartbeatWatchdogTryAcquireDump(now time.Time, interval time.Duration) bool {
	for {
		last := heartbeatWatchdogLastDumpNs.Load()
		if last != 0 && now.UnixNano()-last < int64(interval) {
			return false
		}
		if heartbeatWatchdogLastDumpNs.CompareAndSwap(last, now.UnixNano()) {
			return true
		}
	}
}

// truncateGoroutineDump caps a runtime.Stack dump at max bytes, cutting at a
// goroutine boundary when possible so the tail isn't a half-printed frame.
func truncateGoroutineDump(dump string, max int) string {
	if len(dump) <= max {
		return dump
	}
	total := len(dump)
	cut := dump[:max]
	if i := strings.LastIndex(cut, "\n\ngoroutine "); i > 0 {
		cut = cut[:i]
	}
	return cut + fmt.Sprintf("\n... [truncated, %d of %d bytes]", len(cut), total)
}

// sendHeartbeatFn is the function invoked inside sendHeartbeatWithWatchdog.
// Tests may replace it via the sendHeartbeatFn field on *Heartbeat to inject
// a blocking/fast implementation without spawning a real HTTP client.
// In production it's always h.sendHeartbeat.
func (h *Heartbeat) runHeartbeat() {
	if fn := h.sendHeartbeatFn; fn != nil {
		fn()
		return
	}
	h.sendHeartbeat()
}

func (h *Heartbeat) serverURL() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.config.ServerURL
}

// ServerURL returns the current server base URL, reflecting any
// backup-server-URL promotion (#2323). Long-lived client loops (UniFi
// telemetry, workspace indexing) must read the URL through this getter on
// every request instead of copying cfg.ServerURL once at startup — a copied
// string keeps pointing at a dead primary after failover (#2423).
func (h *Heartbeat) ServerURL() string {
	return h.serverURL()
}

func (h *Heartbeat) monitoringResultsURL() string {
	return fmt.Sprintf("%s/api/v1/agents/%s/monitoring-results", h.serverURL(), h.config.AgentID)
}

func (h *Heartbeat) resetHeartbeatFailures() {
	h.mu.Lock()
	h.hbConsecutiveFailures = 0
	h.mu.Unlock()
}

// recordHeartbeatFailure advances the consecutive-failure counter and, past
// the threshold, probes the backup URL with a full authenticated heartbeat.
// A successful response from the backup is the validate-before-persist gate:
// only then do we promote-and-swap. A failed probe persists nothing; we
// re-probe every subsequent failed cycle.
func (h *Heartbeat) recordHeartbeatFailure(payload *HeartbeatPayload) {
	h.mu.Lock()
	h.hbConsecutiveFailures++
	failures := h.hbConsecutiveFailures
	backup := h.config.BackupServerURL
	h.mu.Unlock()

	if failures < backupProbeThreshold || backup == "" {
		return
	}
	log.Warn("primary server unreachable, probing backup", "failures", failures, "backupServerUrl", backup)
	response, ok := h.doHeartbeatPost(backup, payload)
	if !ok {
		return
	}
	// Promote BEFORE processing the response: its directives (commands,
	// upgrades, token/cert rotation) must run against the control plane that
	// issued them, and their result/rotation requests read h.serverURL().
	// Promotion is synchronous (in-memory swap + single-write persist), so by
	// the time any directive runs, the probed URL is current everywhere.
	h.promoteBackupServerURL(backup)
	h.resetHeartbeatFailures()
	// Drop the probe response's own backup_server_url directive: promotion
	// just installed the old primary as the rollback backup, and letting the
	// probe clear/replace it one cycle earlier than the next regular
	// heartbeat buys nothing while costing the rollback if this promotion
	// turns out to be a false positive.
	delete(response.ConfigUpdate, "backup_server_url")
	delete(response.ConfigUpdate, "backupServerUrl")
	h.processHeartbeatResponse(response)
}

// promoteBackupServerURL swaps probedURL — the backup that just answered a
// fully authenticated heartbeat — to primary in the shared in-memory config
// and persists both sides of the swap. The old primary remains the backup so
// the same probe logic can roll back a false-positive promotion.
//
// probedURL is a parameter, NOT re-read from config: the probe response's
// own configUpdate is applied inside postHeartbeat and may have already
// rewritten or cleared BackupServerURL (the API sends the key on every
// heartbeat — a backup instance with the env var unset pushes a clear).
// Only the URL that actually passed the probe may be promoted; re-reading
// config here bricked stragglers with server_url="" during migrations.
func (h *Heartbeat) promoteBackupServerURL(probedURL string) {
	if probedURL == "" {
		log.Error("refusing to promote empty backup server URL")
		return
	}
	h.mu.Lock()
	oldPrimary := h.config.ServerURL
	newPrimary := probedURL
	h.config.ServerURL = newPrimary
	h.config.BackupServerURL = oldPrimary
	h.mu.Unlock()

	if h.wsClient != nil {
		h.wsClient.SetServerURL(newPrimary)
	}

	if err := config.SetAllAndPersist(map[string]any{
		"server_url":        newPrimary,
		"backup_server_url": oldPrimary,
	}); err != nil {
		log.Error("failed to persist promoted server URL swap", "error", err.Error())
	}
	log.Warn("PROMOTED backup server URL to primary",
		"newServerUrl", newPrimary, "rollbackBackupUrl", oldPrimary)
}

// sendHeartbeatWithWatchdog wraps sendHeartbeat with a watchdog that dumps all
// goroutine stacks if the call blocks longer than heartbeatWatchdogTimeout.
// This instruments the heartbeat starvation symptom described in issue #387:
// the heartbeat loop can block indefinitely waiting on broker mutex reads
// while the reconnect storm holds write locks.
//
// `done` is closed via defer so that a panic in sendHeartbeat still cancels
// the watchdog instead of letting it fire a misleading "exceeded" warning.
func (h *Heartbeat) sendHeartbeatWithWatchdog() {
	start := time.Now()
	// Snapshot the current timeout into a local so any test that overrides
	// heartbeatWatchdogTimeoutNs after this call returns cannot race with
	// the watchdog goroutine.
	timeout := heartbeatWatchdogTimeout()
	done := make(chan struct{})
	defer close(done)

	go func() {
		// The select fires at most once per invocation, so sync.Once is
		// unnecessary — a plain select is sufficient.
		select {
		case <-done:
			// Normal return — watchdog cancelled.
		case <-time.After(timeout):
			elapsedMs := time.Since(start).Milliseconds()
			if !heartbeatWatchdogTryAcquireDump(time.Now(), heartbeatWatchdogDumpInterval()) {
				// Rate-limited: skip the stop-the-world stack dump and the
				// multi-KB log entry; note the fire cheaply instead.
				suppressed := heartbeatWatchdogSuppressedDumps.Add(1)
				log.Warn("heartbeat send exceeded watchdog timeout (goroutine dump rate-limited)",
					"elapsed_ms", elapsedMs,
					"timeout_ms", timeout.Milliseconds(),
					"suppressed_dumps", suppressed)
				return
			}
			suppressed := heartbeatWatchdogSuppressedDumps.Swap(0)
			buf := make([]byte, 1<<20) // 1 MiB stack buffer
			n := runtime.Stack(buf, true)
			dump := truncateGoroutineDump(string(buf[:n]), heartbeatWatchdogMaxDumpBytes)
			log.Warn("heartbeat send exceeded watchdog timeout — dumping goroutine stacks",
				"elapsed_ms", elapsedMs,
				"timeout_ms", timeout.Milliseconds(),
				"goroutine_count", runtime.NumGoroutine(),
				"suppressed_dumps_since_last", suppressed,
				"goroutines", dump)
		}
	}()

	h.runHeartbeat()

	log.Debug("heartbeat sent", "duration_ms", time.Since(start).Milliseconds())
}

// headlessCache is the memoized result of a Linux headless probe.
type headlessCache struct {
	headless bool
	at       time.Time
}

// currentHeadless reports whether the device currently lacks an attachable
// graphical session, for the outgoing heartbeat payload ONLY. On non-Linux it
// returns the boot-time flag. On Linux it is resolver-backed (cached ≤30s) so
// xrdp session churn is reflected without an agent restart. It never mutates
// h.isHeadless — that flag is read unsynchronized by pool-worker goroutines and
// also drives helper stop-routing, so flipping it would both race and misroute.
// The probe result is stored in an atomic so heartbeat and command-handler
// goroutines never race on a plain bool.
func (h *Heartbeat) currentHeadless() bool {
	if runtime.GOOS != "linux" {
		return h.isHeadless
	}
	now := time.Now()
	if cached := h.headlessCachedAt.Load(); cached != nil {
		if c, ok := cached.(headlessCache); ok && now.Sub(c.at) < 30*time.Second {
			return c.headless
		}
	}
	_, err := x11.SelectX11Target()
	headless := err != nil
	h.headlessCachedAt.Store(headlessCache{headless: headless, at: now})
	return headless
}

func (h *Heartbeat) sendHeartbeat() {
	// After a successful self-update, the old process continues running until
	// the service manager kills it. Don't send heartbeats with stale version info.
	if h.upgradeInProgress.Load() {
		log.Debug("skipping heartbeat, upgrade in progress")
		return
	}

	metrics, err := h.metricsCol.Collect()
	metricsAvailable := true
	if err != nil {
		log.Error("failed to collect metrics", "error", err.Error())
		h.healthMon.Update("metrics", health.Degraded, err.Error())
		metricsAvailable = false
	} else {
		h.healthMon.Update("metrics", health.Healthy, "")
	}

	status := "ok"
	if metricsAvailable && (metrics.CPUPercent > 90 || metrics.RAMPercent > 90 || metrics.DiskPercent > 90) {
		status = "warning"
	}

	// Refresh cached system info every 10 minutes to pick up hostname/OS changes
	h.mu.Lock()
	if time.Since(h.lastSysInfoRefresh) > 10*time.Minute {
		if freshInfo, infoErr := h.hardwareCol.CollectSystemInfo(); infoErr == nil {
			h.cachedSysInfo = freshInfo
			h.lastSysInfoRefresh = time.Now()
		}
	}
	sysInfo := h.cachedSysInfo
	deviceRole := h.cachedDeviceRole
	isVirtual := h.cachedIsVirtual
	virtPlatform := h.cachedVirtPlatform
	virtComputed := h.cachedVirtComputed
	h.mu.Unlock()

	payload := HeartbeatPayload{
		Status:          status,
		AgentVersion:    h.agentVersion,
		HelperVersion:   h.helperMgr.InstalledVersion(),
		WatchdogVersion: h.installedWatchdogVersion(),
		HealthStatus:    h.healthMon.Summary(),
		DeviceRole:      deviceRole,
		IsHeadless:      h.currentHeadless(),
	}

	// Only report virtualization once background hardware collection has
	// actually classified it (#1387). Before then — or if hardware collection
	// failed — leave IsVirtual nil so the field is omitted and the server keeps
	// the value synchronous enrollment already established, rather than letting
	// a not-yet-determined zero value flip a real VM to "physical".
	if virtComputed {
		payload.IsVirtual = &isVirtual
		payload.VirtualizationPlatform = virtPlatform
	}

	// Include hostname/OS version so the server can detect changes
	if sysInfo != nil {
		payload.Hostname = sysInfo.Hostname
		payload.OSVersion = sysInfo.OSVersion
		payload.OSBuild = sysInfo.OSBuild
	}
	if metricsAvailable {
		payload.Metrics = metrics
	} else {
		payload.MetricsAvailable = &metricsAvailable
	}

	// Current power/battery state (#2142). Nil on platforms that can't report
	// it or when the query failed — omitempty then drops the field.
	payload.Battery = h.hardwareCol.CollectBattery()

	// Agent's own runtime memory gauges (#2389), plus worker-pool wedge
	// gauges (#2400) so in-flight/overdue commands are visible fleet-wide.
	payload.AgentRuntime = h.collectAgentRuntime(time.Now())

	// OneDrive helper state (Phase 2). Nil until a config has been applied on a
	// Windows box — omitempty then drops the field entirely.
	h.onedriveMu.Lock()
	payload.OneDriveDeviceState = h.onedriveState
	h.onedriveMu.Unlock()

	// Check for pending reboot
	pendingReboot, _ := patching.DetectPendingReboot()
	payload.PendingReboot = pendingReboot
	if h.sessionCol != nil {
		payload.LastUser = h.sessionCol.LastUser()
	}

	// Compute uptime from boot time
	if bootTime, err := host.BootTime(); err != nil {
		log.Warn("failed to read boot time for uptime calculation", "error", err.Error())
	} else if bootTime > 0 {
		payload.UptimeSeconds = time.Now().Unix() - int64(bootTime)
	}

	// Include dropped log count if any logs were lost
	if dropped := logging.DroppedLogCount(); dropped > 0 {
		payload.DroppedLogs = dropped
	}

	// Attach IP history update when assignments changed since last heartbeat.
	if ipUpdate, ipErr := h.collectIPHistory(); ipErr != nil {
		log.Error("failed to collect ip history", "error", ipErr.Error())
		h.healthMon.Update("ip_history", health.Degraded, ipErr.Error())
	} else {
		payload.IPHistoryUpdate = ipUpdate
	}

	// Include TCC permission status for macOS devices
	if runtime.GOOS == "darwin" && h.sessionBroker != nil {
		if tccStatus := h.sessionBroker.TCCStatus(); tccStatus != nil {
			// On macOS 12, the helper's os.Open probe for FDA always returns
			// false even when FDA is granted, because user-context processes
			// cannot open the system TCC database. Fall back to a daemon-side
			// query (running as root) which can read the TCC database directly.
			if !tccStatus.FullDiskAccess {
				if tcc.CheckFDA() {
					log.Debug("FDA helper probe false but daemon check true — overriding")
					tccStatus.FullDiskAccess = true
				}
			}
			payload.TCCPermissions = tccStatus
		}
		payload.DesktopAccess = h.computeDesktopAccess(sysInfo)
	} else if runtime.GOOS == "linux" {
		payload.DesktopAccess = h.computeDesktopAccess(sysInfo)
	}

	// Include user helper session info in heartbeat
	if h.sessionBroker != nil {
		sessions := h.sessionBroker.AllSessions()
		if len(sessions) > 0 {
			helpers := make([]map[string]any, len(sessions))
			for i, s := range sessions {
				helpers[i] = map[string]any{
					"uid":         s.UID,
					"username":    s.Username,
					"display":     s.DisplayEnv,
					"connectedAt": s.ConnectedAt,
					"lastSeen":    s.LastSeen,
				}
				if s.Capabilities != nil {
					helpers[i]["capabilities"] = s.Capabilities
				}
				if s.BinaryKind != "" {
					helpers[i]["binaryKind"] = s.BinaryKind
				}
				if s.DesktopContext != "" {
					helpers[i]["desktopContext"] = s.DesktopContext
				}
			}
			payload.HealthStatus["userHelpers"] = helpers
		}
	}

	if h.postHeartbeat(h.serverURL(), &payload) {
		h.resetHeartbeatFailures()
		return
	}
	h.recordHeartbeatFailure(&payload)
}

// postHeartbeat POSTs the payload to baseURL and, on an authenticated 2xx,
// processes the full response (configUpdate, commands, upgrades, rotation).
// The regular heartbeat path uses this; the backup PROBE path must NOT — it
// uses doHeartbeatPost + processHeartbeatResponse separately so promotion
// runs between validation and side effects (see recordHeartbeatFailure).
func (h *Heartbeat) postHeartbeat(baseURL string, payload *HeartbeatPayload) bool {
	response, ok := h.doHeartbeatPost(baseURL, payload)
	if !ok {
		return false
	}
	h.processHeartbeatResponse(response)
	return true
}

// doHeartbeatPost sends the heartbeat and validates the response up to and
// including the JSON decode — the authenticated-2xx gate — WITHOUT executing
// any of the response's directives. Side effects (commands, upgrades, token
// and cert rotation, configUpdate) live in processHeartbeatResponse: a backup
// probe must promote the probed URL first, so those directives run against
// the control plane that actually issued them.
func (h *Heartbeat) doHeartbeatPost(baseURL string, payload *HeartbeatPayload) (*HeartbeatResponse, bool) {
	payload.ServerURL = baseURL
	body, err := json.Marshal(payload)
	if err != nil {
		log.Error("failed to marshal heartbeat", "error", err.Error())
		return nil, false
	}

	url := fmt.Sprintf("%s/api/v1/agents/%s/heartbeat", baseURL, h.config.AgentID)
	headers := http.Header{
		"Content-Type":  {"application/json"},
		"Authorization": {h.authHeader()},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	resp, err := httputil.Do(ctx, h.httpClient(), "POST", url, body, headers, h.retryCfg)
	if err != nil {
		log.Error("failed to send heartbeat", "server", baseURL, "error", err.Error())
		h.healthMon.Update("heartbeat", health.Unhealthy, err.Error())
		return nil, false
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		log.Warn("heartbeat returned 401", "server", baseURL)
		h.healthMon.Update("heartbeat", health.Degraded, "unauthorized")
		if h.authMon != nil {
			h.authMon.RecordAuthFailure()
		}
		return nil, false
	}

	if resp.StatusCode != http.StatusOK {
		log.Warn("heartbeat returned non-OK status", "server", baseURL, "status", resp.StatusCode)
		h.healthMon.Update("heartbeat", health.Degraded, fmt.Sprintf("status %d", resp.StatusCode))
		return nil, false
	}

	h.healthMon.Update("heartbeat", health.Healthy, "")
	if h.authMon != nil {
		h.authMon.RecordSuccess()
	}

	// Update state file with latest heartbeat timestamp so the watchdog
	// can detect stale heartbeats.
	now := time.Now()
	if h.statePath != "" {
		if err := state.UpdateHeartbeat(h.statePath, now); err != nil {
			log.Warn("failed to update state file heartbeat", "error", err.Error())
		}
	}

	// Send state_sync to the watchdog so it has current connectivity info.
	h.sendWatchdogStateSync(now)

	// Heartbeat succeeded — commit (clear) the dropped log counter so it is
	// not re-reported. If the POST had failed, the count would be preserved
	// for the next attempt.
	logging.CommitDroppedLogCount()

	var response HeartbeatResponse
	if err := json.NewDecoder(resp.Body).Decode(&response); err != nil {
		log.Error("failed to decode heartbeat response", "error", err.Error())
		return nil, false
	}
	return &response, true
}

// processHeartbeatResponse executes the directives carried by a validated
// heartbeat response: configUpdate, manifest trust keys, commands, upgrades,
// cert/token rotation, tunnel policy, and helper settings. Callers must have
// already made the response's origin the current server URL (the regular
// path trivially has; the probe path promotes first) so that command results
// and rotation requests go back to the control plane that issued them.
func (h *Heartbeat) processHeartbeatResponse(response *HeartbeatResponse) {
	if len(response.ConfigUpdate) > 0 {
		h.applyConfigUpdate(response.ConfigUpdate)
	}

	// Pin per-deployment manifest trust keys delivered by the server (#625).
	// TOFU: PinManifestKeys rejects a *changed* pubkey for an already-pinned
	// keyId. This blocks an attacker with API write access (but not the signing
	// key) from rotating in their own key. It does NOT defend against a
	// host-level compromise of the API — the signing key and APP_ENCRYPTION_KEY
	// live there. See docs/deploy/agent-update-trust-bootstrap.md for the
	// threat model.
	if len(response.ManifestTrustKeys) > 0 {
		keys := make([]config.ManifestTrustKey, 0, len(response.ManifestTrustKeys))
		for _, k := range response.ManifestTrustKeys {
			if k.KeyID == "" || k.PublicKeyB64 == "" {
				continue
			}
			keys = append(keys, config.ManifestTrustKey{KeyID: k.KeyID, PublicKeyB64: k.PublicKeyB64})
		}
		if len(keys) > 0 {
			cfgPath := config.ActiveConfigFile()
			if err := config.PinManifestKeys(cfgPath, keys); err != nil {
				if errors.Is(err, config.ErrManifestTrustRotationRejected) {
					h.manifestTrustRotationRejected.Store(true)
					log.Error("SECURITY: manifest trust key rotation rejected — auto-update suspended until rotation resolved or agent restart",
						"error", err.Error())
				} else {
					log.Warn("manifest trust key pin failed (non-rotation)", "error", err.Error())
				}
			} else {
				// Successful pin (idempotent or genuine new keyId append) means
				// the conflict — if any — is no longer present. Clear the
				// rotation-rejected gate so auto-update can resume.
				h.manifestTrustRotationRejected.Store(false)
				if reloaded, rerr := config.Reload(); rerr != nil {
					log.Warn("failed to reload config after pinning manifest trust keys; in-memory pinned set stale until next restart", "error", rerr.Error())
				} else if reloaded != nil {
					h.config.PinnedManifestPubKeys = reloaded.PinnedManifestPubKeys
				}
			}
		}
	}

	// Process any commands via worker pool
	for _, cmd := range response.Commands {
		if !h.accepting.Load() {
			log.Warn("rejecting command, agent shutting down", logging.KeyCommandID, cmd.ID)
			break
		}
		c := cmd // capture
		if !h.pool.Submit(func() { h.processCommand(c) }) {
			log.Warn("command rejected, worker pool full", logging.KeyCommandID, cmd.ID)
		}
	}

	// Handle upgrade if requested and auto-update is enabled
	if response.UpgradeTo != "" && response.UpgradeTo != h.agentVersion {
		if isDowngrade(response.UpgradeTo, h.agentVersion) {
			// SECURITY: never auto-downgrade. A compromised/MITM'd control plane
			// could otherwise force a fleet-wide rollback to an older,
			// still-validly-signed, known-vulnerable build. Deliberate rollback
			// is an operator action via the (default-off) dev_update path.
			log.Error("SECURITY: refusing server-directed auto-update downgrade",
				"currentVersion", h.agentVersion,
				"targetVersion", response.UpgradeTo,
				"hint", "deliberate rollback uses the operator dev_update path")
		} else if h.manifestTrustRotationRejected.Load() {
			log.Error("SECURITY: skipping auto-update — manifest trust rotation rejection unresolved",
				"targetVersion", response.UpgradeTo)
		} else if h.config.AutoUpdate {
			if h.upgradeInProgress.CompareAndSwap(false, true) {
				go h.handleUpgrade(response.UpgradeTo)
			} else {
				log.Debug("upgrade already in progress", "targetVersion", response.UpgradeTo)
			}
		} else {
			log.Info("upgrade available but auto_update is disabled", "targetVersion", response.UpgradeTo)
		}
	}

	// Handle mTLS cert renewal if signaled by server
	if response.RenewCert {
		go h.handleCertRenewal()
	}

	// Handle proactive bearer-token rotation before the token becomes stale.
	if response.RotateToken {
		go h.handleTokenRotation()
	}

	// Handle helper upgrade if requested
	if response.HelperUpgradeTo != "" {
		installedHelper := h.helperMgr.InstalledVersion()
		if allowed, reason := helperUpgradeAllowed(response.HelperUpgradeTo, installedHelper, h.helperMgr.IsInstalled()); !allowed {
			// SECURITY: never auto-downgrade the helper. The signed manifest
			// only binds manifest.Release == requested version, so a
			// compromised/MITM'd control plane could replay an older,
			// validly-signed, known-vulnerable helper release.
			log.Error("SECURITY: refusing server-directed helper update",
				"installedVersion", installedHelper,
				"targetVersion", response.HelperUpgradeTo,
				"reason", reason)
		} else {
			h.helperMgr.CheckUpdate(response.HelperUpgradeTo)
		}
	}

	// Handle watchdog upgrade if requested. The server only sets
	// watchdogUpgradeTo once it has learned (from a watchdog failover heartbeat)
	// that the on-disk watchdog is behind the latest published watchdog
	// component — see apps/api heartbeat.ts. The watchdog historically could not
	// self-update on the hosted (BINARY_SOURCE=github) path (its bundled updater
	// had no watchdog asset-name case, and the component was never registered) —
	// and even fully wired up, the watchdog's own doUpdateWatchdog only runs
	// while it is in FAILOVER (the only state in which it heartbeats and receives
	// WatchdogUpgradeTo), so a HEALTHY watchdog would never self-heal. The
	// reliably-updating agent drives it instead, recovering already-stuck fleets
	// whose watchdog is frozen at install-time version.
	if response.WatchdogUpgradeTo != "" {
		go h.handleWatchdogUpgrade(response.WatchdogUpgradeTo)
	}

	// Update tunnel manager policy flag
	h.tunnelMgr.SetManagedByPolicy(response.ManageRemoteManagement)

	// Update helper enabled state and apply full settings
	h.handleHelperEnabled(response.HelperEnabled)
	h.handleUACInterception(response.UacInterceptionEnabled)
	if response.HelperSettings != nil {
		h.helperMgr.Apply(&helper.Settings{
			Enabled:            response.HelperSettings.Enabled,
			ShowOpenPortal:     response.HelperSettings.ShowOpenPortal,
			ShowDeviceInfo:     response.HelperSettings.ShowDeviceInfo,
			ShowRequestSupport: response.HelperSettings.ShowRequestSupport,
			PortalUrl:          response.HelperSettings.PortalUrl,
		})
	}
}

// IsHelperEnabled returns whether the helper chat is enabled for this device's org.
func (h *Heartbeat) IsHelperEnabled() bool {
	return h.helperEnabled.Load()
}

// handleHelperEnabled updates the helper enabled flag and logs state transitions.
func (h *Heartbeat) handleHelperEnabled(enabled bool) {
	prev := h.helperEnabled.Swap(enabled)
	if prev != enabled {
		if enabled {
			log.Info("helper chat enabled for this device")
		} else {
			log.Info("helper chat disabled for this device")
		}
	}
}

// IsUACInterceptionEnabled reports whether etwlua should post UAC elevation
// events. Default false (opt-in); only an explicit uacInterceptionEnabled=true
// from the server's resolved 'pam' config policy enables it.
func (h *Heartbeat) IsUACInterceptionEnabled() bool {
	return h.uacInterceptionEnabled.Load()
}

// handleUACInterception updates the UAC interception flag from the heartbeat
// response and logs state transitions. nil (field absent — older server) means
// disabled: capture is opt-in and stays off until the server sends an explicit
// true.
func (h *Heartbeat) handleUACInterception(enabled *bool) {
	on := enabled != nil && *enabled
	prev := h.uacInterceptionEnabled.Swap(on)
	if prev != on {
		if on {
			log.Info("UAC interception enabled by configuration policy")
		} else {
			log.Info("UAC interception disabled by configuration policy")
		}
	}
}

// handleCertRenewal is called in a goroutine when the server signals renewCert: true.
// It uses a bearer-only client (no mTLS required) to call /renew-cert.
// Guarded by certRenewing to prevent concurrent renewals from successive heartbeats.
func (h *Heartbeat) handleCertRenewal() {
	if !h.certRenewing.CompareAndSwap(false, true) {
		log.Info("mTLS cert renewal already in progress, skipping")
		return
	}
	defer h.certRenewing.Store(false)

	log.Info("mTLS cert renewal requested by server")

	token := h.secureToken.Reveal()
	renewClient := api.NewClient(h.serverURL(), token, h.config.AgentID)

	renewResp, err := renewClient.RenewCert()
	if err != nil {
		log.Error("mTLS cert renewal failed", "error", err.Error())
		return
	}

	if renewResp.Quarantined {
		log.Warn("device quarantined during cert renewal")
		return
	}

	if renewResp.Error != "" {
		log.Error("mTLS cert renewal rejected", "error", renewResp.Error)
		return
	}

	if renewResp.Mtls == nil {
		log.Warn("mTLS cert renewal response missing cert data")
		return
	}

	// Validate the cert/key pair before saving
	if _, verifyErr := mtls.LoadClientCert(renewResp.Mtls.Certificate, renewResp.Mtls.PrivateKey); verifyErr != nil {
		log.Error("renewed cert/key pair is invalid, not saving", "error", verifyErr)
		return
	}

	tlsCfg, err := mtls.BuildTLSConfig(renewResp.Mtls.Certificate, renewResp.Mtls.PrivateKey)
	if err != nil {
		log.Error("failed to build TLS config from renewed cert", "error", err.Error())
		return
	}

	// Update config in memory (hold mutex to prevent races with heartbeat reads)
	h.mu.Lock()
	h.config.MtlsCertPEM = renewResp.Mtls.Certificate
	h.config.MtlsKeyPEM = renewResp.Mtls.PrivateKey
	h.config.MtlsCertExpires = renewResp.Mtls.ExpiresAt

	// Save to disk (temporarily restore auth token for save)
	h.config.AuthToken = token
	err = config.Save(h.config)
	h.config.AuthToken = ""

	if err != nil {
		log.Error("failed to save renewed mTLS cert -- renewal will be re-attempted", "error", err.Error())
		// Clear expires so next heartbeat re-triggers renewal
		h.config.MtlsCertExpires = ""
		h.mu.Unlock()
		return
	}
	h.mu.Unlock()

	h.setHTTPClient(newHeartbeatHTTPClient(tlsCfg))
	if h.wsClient != nil {
		h.wsClient.UpdateTLSConfig(tlsCfg)
		h.wsClient.ForceReconnect()
	}

	log.Info("mTLS certificate renewed", "expires", renewResp.Mtls.ExpiresAt)
	log.Info("mTLS clients refreshed with renewed certificate")
}

func (h *Heartbeat) handleTokenRotation() {
	if !h.tokenRotating.CompareAndSwap(false, true) {
		return
	}
	defer h.tokenRotating.Store(false)

	if h.secureToken == nil || h.secureToken.IsZeroed() {
		log.Error("token rotation requested but no active auth token is available")
		return
	}

	log.Info("agent token rotation requested by server")

	currentToken := h.secureToken.Reveal()
	rotateClient := api.NewClient(h.serverURL(), currentToken, h.config.AgentID)
	rotateResp, err := rotateClient.RotateToken()
	if err != nil {
		log.Error("agent token rotation failed", "error", err.Error())
		return
	}

	if rotateResp.AuthToken == "" {
		log.Error("agent token rotation response missing auth token")
		return
	}
	if rotateResp.WatchdogAuthToken == "" {
		log.Error("agent token rotation response missing watchdog auth token")
		return
	}
	if rotateResp.HelperAuthToken == "" {
		log.Error("agent token rotation response missing helper auth token")
		return
	}

	h.mu.Lock()
	h.secureToken.Replace(rotateResp.AuthToken)
	h.config.AuthToken = rotateResp.AuthToken
	h.config.WatchdogAuthToken = rotateResp.WatchdogAuthToken
	h.config.HelperAuthToken = rotateResp.HelperAuthToken
	saveErr := config.Save(h.config)
	h.config.AuthToken = ""
	h.config.WatchdogAuthToken = ""
	h.config.HelperAuthToken = ""
	h.mu.Unlock()

	if saveErr != nil {
		log.Error("agent token rotated in memory but failed to persist new token", "error", saveErr.Error())
	} else {
		log.Info("agent token rotated", "rotatedAt", rotateResp.RotatedAt)
	}

	// Notify the watchdog of its role-scoped token so it can use it for failover heartbeats.
	h.sendWatchdogTokenUpdate(rotateResp.WatchdogAuthToken)

	// Retain and push the rotated helper token to any connected assist sessions.
	h.setHelperToken(rotateResp.HelperAuthToken)
	h.sendHelperTokenUpdate(rotateResp.HelperAuthToken)

	if h.wsClient != nil {
		h.wsClient.ForceReconnect()
	}
}

// sendWatchdogStateSync sends a state_sync IPC message to the watchdog
// so it knows the agent's current connectivity and version.
func (h *Heartbeat) sendWatchdogStateSync(lastHeartbeat time.Time) {
	if h.sessionBroker == nil {
		return
	}
	sess := h.sessionBroker.PreferredSessionWithScope("watchdog")
	if sess == nil {
		return
	}
	_ = sess.SendNotify("", ipc.TypeStateSync, ipc.StateSync{
		AgentVersion:  h.agentVersion,
		ConfigHash:    "", // TODO: populate when config hashing is implemented
		Connected:     true,
		LastHeartbeat: lastHeartbeat.Format(time.RFC3339),
	})
}

// sendWatchdogTokenUpdate notifies the watchdog that the agent token was rotated
// so it can update its own copy for failover heartbeats.
func (h *Heartbeat) sendWatchdogTokenUpdate(newToken string) {
	if h.sessionBroker == nil {
		return
	}
	sess := h.sessionBroker.PreferredSessionWithScope("watchdog")
	if sess == nil {
		return
	}
	_ = sess.SendNotify("", ipc.TypeTokenUpdate, ipc.TokenUpdate{
		Token: newToken,
	})
}

func (h *Heartbeat) setHelperToken(token string) {
	h.helperTokenMu.Lock()
	h.helperToken = token
	h.helperTokenMu.Unlock()
}

func (h *Heartbeat) currentHelperToken() string {
	h.helperTokenMu.RLock()
	defer h.helperTokenMu.RUnlock()
	return h.helperToken
}

// shouldPushHelperToken reports whether a session with the given scopes should
// receive the helper token. Only assist-scope sessions qualify; this guards
// against ever sending the helper token to the watchdog or a user helper.
func shouldPushHelperToken(scopes []string) bool {
	for _, s := range scopes {
		if s == ipc.ScopeAssist {
			return true
		}
	}
	return false
}

// pushHelperToken delivers the helper token to a single eligible session and
// recovers from a delivery failure. A missed push after rotation otherwise
// leaves the Helper 401ing against the API with a stale/invalid token, with no
// re-push until it happens to reconnect on its own. On a SendNotify error we
// therefore close the session: closing tears down the connection so the client
// reconnects and re-runs handleHelperSessionAuthenticated, which re-pushes the
// current token. Closing from this goroutine is safe — Session.Close() only
// touches the session's own conn/done (not the broker mutex); the broker's
// RecvLoop unblocks on the closed conn and runs removeSession (which acquires
// b.mu and fires onSessionClosed) for us. Callers must NOT hold b.mu here.
func (h *Heartbeat) pushHelperToken(session *sessionbroker.Session, token string) {
	// ExpiresAt omitted: RotateTokenResponse carries no expiry for the helper token.
	if err := session.SendNotify("", ipc.TypeHelperTokenUpdate, ipc.HelperTokenUpdate{Token: token}); err != nil {
		log.Error("failed to push helper token; closing assist session for reconnect+re-push",
			"sessionId", session.SessionID, "error", err.Error())
		if closeErr := session.Close(); closeErr != nil {
			log.Error("failed to close assist session after token push failure",
				"sessionId", session.SessionID, "error", closeErr.Error())
		}
	}
}

// handleHelperSessionAuthenticated is wired as the broker's
// SessionAuthenticatedHandler. It pushes the current helper token to a freshly
// authenticated assist session.
func (h *Heartbeat) handleHelperSessionAuthenticated(session *sessionbroker.Session) {
	if session == nil || !shouldPushHelperToken(session.AllowedScopes) {
		return
	}
	// #1009: never deliver the device helper token to an assist helper outside
	// the active console session — on a multi-user host that would hand a
	// co-logged-in user org-scoped fleet access. Inert on single-user/non-Windows.
	if h.sessionBroker != nil && !h.sessionBroker.SessionInConsoleSession(session) {
		log.Warn("withholding helper token from non-console assist session",
			"sessionId", session.SessionID, "winSessionId", session.WinSessionID)
		return
	}
	token := h.currentHelperToken()
	if token == "" {
		return
	}
	h.pushHelperToken(session, token)
}

// sendHelperTokenUpdate pushes a (possibly rotated) helper token to all
// connected assist sessions. Recipient eligibility is routed through the single
// authoritative shouldPushHelperToken predicate (the same one used at connect
// time) rather than SessionsWithScope's HasScope alone, whose wildcard match
// would also select a hypothetical "*"-scoped session.
func (h *Heartbeat) sendHelperTokenUpdate(newToken string) {
	if h.sessionBroker == nil || newToken == "" {
		return
	}
	for _, sess := range h.sessionBroker.SessionsWithScope(ipc.ScopeAssist) {
		if !shouldPushHelperToken(sess.AllowedScopes) {
			continue
		}
		// #1009: only the console-session assist helper may receive the token.
		if !h.sessionBroker.SessionInConsoleSession(sess) {
			log.Warn("withholding rotated helper token from non-console assist session",
				"sessionId", sess.SessionID, "winSessionId", sess.WinSessionID)
			continue
		}
		h.pushHelperToken(sess, newToken)
	}
}

func (h *Heartbeat) processCommand(cmd Command) {
	result := h.runTrackedCommand(cmd)

	if result.Status == "duplicate" {
		return
	}

	// Submit result back to API
	if err := h.submitCommandResult(cmd.ID, result); err != nil {
		log.Error("failed to submit command result", logging.KeyCommandID, cmd.ID, "error", err.Error())
	}
}

func (h *Heartbeat) submitCommandResult(commandID string, result tools.CommandResult) error {
	body, err := json.Marshal(result)
	if err != nil {
		return fmt.Errorf("failed to marshal result: %w", err)
	}

	url := fmt.Sprintf("%s/api/v1/agents/%s/commands/%s/result", h.serverURL(), h.config.AgentID, commandID)
	headers := http.Header{
		"Content-Type":  {"application/json"},
		"Authorization": {h.authHeader()},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	resp, err := httputil.Do(ctx, h.httpClient(), "POST", url, body, headers, h.retryCfg)
	if err != nil {
		return fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("submit result failed with status %d", resp.StatusCode)
	}

	log.Info("command completed", logging.KeyCommandID, commandID, "status", result.Status)
	return nil
}

// HandleCommand processes a command from WebSocket and returns a result
func (h *Heartbeat) HandleCommand(wsCmd websocket.Command) websocket.CommandResult {
	if !h.accepting.Load() {
		return websocket.CommandResult{
			CommandID: wsCmd.ID,
			Status:    "failed",
			Error:     "agent is shutting down",
		}
	}

	cmd := Command{
		ID:      wsCmd.ID,
		Type:    wsCmd.Type,
		Payload: wsCmd.Payload,
	}

	result := h.executeCommandViaPool(cmd)

	wsResult := websocket.CommandResult{
		CommandID: cmd.ID,
		Status:    result.Status,
	}

	if result.Error != "" {
		wsResult.Error = result.Error
	} else if result.Stdout != "" {
		var jsonResult any
		if err := json.Unmarshal([]byte(result.Stdout), &jsonResult); err == nil {
			wsResult.Result = jsonResult
		} else {
			wsResult.Result = result.Stdout
		}
	}

	if result.Status != "duplicate" && !isEphemeralCommand(cmd.Type) {
		go h.submitCommandResult(cmd.ID, result)
	}

	return wsResult
}

func (h *Heartbeat) executeCommandViaPool(cmd Command) tools.CommandResult {
	if h.pool == nil {
		return h.executeCommand(cmd)
	}

	resultCh := make(chan tools.CommandResult, 1)
	if !h.pool.Submit(func() {
		resultCh <- h.runTrackedCommand(cmd)
	}) {
		return tools.CommandResult{
			Status: "failed",
			Error:  "command rejected, worker pool full",
		}
	}

	// Watchdog: log-only, deliberately NOT a timeout. Some handlers are
	// long-running by design (run_script up to 1h, software installs, patch
	// loops), so failing the command here would race legitimate work. The log
	// flags workers wedged on an unbounded blocking call — each one pins its
	// decoded command payload (up to the 64MB websocket read limit,
	// maxMessageSize in internal/websocket) for the process lifetime and
	// permanently shrinks the pool (issue #2387). Ephemeral commands
	// (terminal/tunnel/desktop data) should complete in milliseconds, so they
	// get a much shorter tier (issue #2400) — still log-only.
	warnAfter := h.commandWarnAfter(cmd.Type)
	started := time.Now()
	watchdog := time.NewTimer(warnAfter)
	defer watchdog.Stop()

	for {
		select {
		case result := <-resultCh:
			return result
		case <-watchdog.C:
			log.Warn("command still in flight after watchdog interval — handler may be wedged and retaining its payload",
				logging.KeyCommandID, cmd.ID,
				"type", cmd.Type,
				"elapsed", time.Since(started).Round(time.Second).String(),
				"warnAfter", warnAfter.String(),
			)
			watchdog.Reset(warnAfter)
		case <-h.stopChan:
			return tools.CommandResult{
				Status: "failed",
				Error:  "agent is shutting down",
			}
		case <-h.pool.Context().Done():
			return tools.CommandResult{
				Status: "failed",
				Error:  "command execution interrupted during shutdown",
			}
		}
	}
}

// defaultCommandInFlightWarnAfter is how long a pool-dispatched command may
// run before the dispatch loop logs a wedged-worker warning (and again each
// further interval). Generous on purpose: the longest legitimate handlers
// (scripts capped at executor.MaxTimeout = 1h, patch installs) must not trip
// it in normal operation.
const defaultCommandInFlightWarnAfter = 2 * time.Hour

// defaultEphemeralCommandInFlightWarnAfter is the short watchdog tier for
// ephemeral commands (isEphemeralCommand: terminal_data, tunnel_data, desktop
// input, ...). Those handlers hand off to an interactive session and should
// return in milliseconds, so one stuck for a minute is a wedged interactive
// path — worth flagging long before the 2h tier would (issue #2400). Log-only,
// exactly like the default tier: it never fails or kills the command.
const defaultEphemeralCommandInFlightWarnAfter = 60 * time.Second

// commandWarnAfter returns the in-flight watchdog tier for a command type:
// the short ephemeral tier for interactive-session data commands, the
// generous default for everything else. Test overrides on the Heartbeat take
// precedence within their tier.
func (h *Heartbeat) commandWarnAfter(cmdType string) time.Duration {
	if isEphemeralCommand(cmdType) {
		if h.ephemeralCommandInFlightWarnAfter > 0 {
			return h.ephemeralCommandInFlightWarnAfter
		}
		return defaultEphemeralCommandInFlightWarnAfter
	}
	if h.commandInFlightWarnAfter > 0 {
		return h.commandInFlightWarnAfter
	}
	return defaultCommandInFlightWarnAfter
}

// inFlightCommand is one pool-dispatched command currently executing, as
// tracked for the heartbeat wedge gauges (issue #2400).
type inFlightCommand struct {
	started   time.Time
	warnAfter time.Duration
}

// runTrackedCommand executes cmd on the calling goroutine (a pool worker),
// recording it in the in-flight wedge gauges for exactly the duration of its
// execution. Both command-delivery channels go through here — the WebSocket
// dispatch loop (executeCommandViaPool) and the heartbeat-response poll path
// (processCommand) — so the gauges see every pool worker a command occupies,
// and tracking starts when a worker picks the command up, not when it is
// queued behind a backlog.
func (h *Heartbeat) runTrackedCommand(cmd Command) tools.CommandResult {
	key := h.trackInFlight(time.Now(), h.commandWarnAfter(cmd.Type))
	defer h.untrackInFlight(key)
	return h.executeCommand(cmd)
}

// trackInFlight records a command dispatch and returns the key to pass to
// untrackInFlight when the dispatch loop exits.
func (h *Heartbeat) trackInFlight(started time.Time, warnAfter time.Duration) uint64 {
	key := h.inFlightSeq.Add(1)
	h.inFlightMu.Lock()
	defer h.inFlightMu.Unlock()
	if h.inFlightCommands == nil {
		h.inFlightCommands = make(map[uint64]inFlightCommand)
	}
	h.inFlightCommands[key] = inFlightCommand{started: started, warnAfter: warnAfter}
	return key
}

func (h *Heartbeat) untrackInFlight(key uint64) {
	h.inFlightMu.Lock()
	defer h.inFlightMu.Unlock()
	delete(h.inFlightCommands, key)
}

// collectAgentRuntime builds the heartbeat's agentRuntime gauge object: the
// Go runtime memory stats (#2389) plus the worker-pool wedge gauges (#2400).
// Extracted from sendHeartbeat so the gauge wiring itself is testable — if
// this stops being called with live tracker data, the gauges silently report
// a permanently-plausible 0/0.
func (h *Heartbeat) collectAgentRuntime(now time.Time) *collectors.RuntimeStats {
	rt := collectors.CollectRuntimeStats()
	rt.CommandsInFlight, rt.CommandsOverdue = h.inFlightCommandStats(now)
	return rt
}

// inFlightCommandStats returns how many pool-dispatched commands are
// currently executing and how many of those are overdue — running longer
// than their watchdog tier. Reported on every heartbeat via the agentRuntime
// gauges so wedged workers are visible fleet-wide (issue #2400).
func (h *Heartbeat) inFlightCommandStats(now time.Time) (inFlight, overdue int) {
	h.inFlightMu.Lock()
	defer h.inFlightMu.Unlock()
	inFlight = len(h.inFlightCommands)
	for _, c := range h.inFlightCommands {
		if now.Sub(c.started) > c.warnAfter {
			overdue++
		}
	}
	return inFlight, overdue
}

func isEphemeralCommand(cmdType string) bool {
	switch cmdType {
	case tools.CmdTerminalStart, tools.CmdTerminalData, tools.CmdTerminalResize, tools.CmdTerminalStop,
		tools.CmdStartDesktop, tools.CmdStopDesktop,
		tools.CmdDesktopStreamStart, tools.CmdDesktopStreamStop, tools.CmdDesktopInput, tools.CmdDesktopConfig,
		tools.CmdTunnelOpen, tools.CmdTunnelData, tools.CmdTunnelClose:
		return true
	}
	return false
}

// markCommandSeen returns true if this is the first time seeing the command ID.
// It also evicts entries older than 2 minutes to prevent unbounded growth.
func (h *Heartbeat) markCommandSeen(id string) bool {
	h.seenCommandsMu.Lock()
	defer h.seenCommandsMu.Unlock()

	if h.seenCommands == nil {
		h.seenCommands = make(map[string]time.Time)
	}

	if _, seen := h.seenCommands[id]; seen {
		return false
	}

	h.seenCommands[id] = time.Now()

	// Always evict stale entries to prevent unbounded growth.
	// Previously only ran when >100 entries, but the map should stay small.
	if len(h.seenCommands) > 50 {
		cutoff := time.Now().Add(-2 * time.Minute)
		for k, t := range h.seenCommands {
			if t.Before(cutoff) {
				delete(h.seenCommands, k)
			}
		}
	}

	return true
}

// executeCommand runs a command and returns the result.
// Command dispatch is handled via the handler registry in handlers*.go.
func (h *Heartbeat) executeCommand(cmd Command) tools.CommandResult {
	cmdLog := logging.WithCommand(log, cmd.ID, cmd.Type)

	// Deduplicate: skip if we've already seen this command ID
	// (can arrive via both WebSocket and heartbeat response).
	//
	// EXCEPTION (#434): start_desktop and stop_desktop are idempotent
	// state-setting commands that the viewer may legitimately re-invoke with
	// the same commandId. The commandId is derived from the viewer's
	// desktop-ws session UUID, which does NOT change across reconnect
	// attempts. When the remote user logs out, the helper process dies, the
	// agent tears down the WebRTC session, and the viewer retries the same
	// start_desktop offer to attach to the new loginwindow helper. If that
	// retry is dedup'd, the handoff silently fails and the viewer countdown
	// expires into "session ended". SessionManager.StartSession enforces
	// single-active-session and tears down any existing session before
	// creating the new one, so re-invocation is safe.
	dedupable := cmd.Type != tools.CmdStartDesktop && cmd.Type != tools.CmdStopDesktop

	if dedupable && !h.markCommandSeen(cmd.ID) {
		cmdLog.Debug("skipping duplicate command")
		return tools.CommandResult{
			Status: "duplicate",
		}
	}

	cmdLog.Info("processing command")

	// Audit: command received
	if h.auditLog != nil {
		h.auditLog.Log(audit.EventCommandReceived, cmd.ID, map[string]any{
			"type": cmd.Type,
		})
	}

	// Privilege check (warn-only for now)
	if privilege.RequiresElevation(cmd.Type) && !privilege.IsRunningAsRoot() {
		cmdLog.Warn("command requires elevated privileges but agent is not running as root")
	}

	// Dispatch via handler registry
	result, handled := h.dispatchCommand(cmd)
	if !handled {
		result = tools.CommandResult{
			Status: "failed",
			Error:  fmt.Sprintf("unknown command type: %s", cmd.Type),
		}
	}

	// Audit: command executed
	if h.auditLog != nil {
		h.auditLog.Log(audit.EventCommandExecuted, cmd.ID, map[string]any{
			"type":       cmd.Type,
			"status":     result.Status,
			"durationMs": result.DurationMs,
		})
	}

	return result
}

type patchCommandRef struct {
	ID         string
	Source     string
	ExternalID string
	PackageID  string
	Title      string
}

func (h *Heartbeat) executePatchInstallCommand(payload map[string]any, rollback bool) tools.CommandResult {
	start := time.Now()
	if h.patchMgr == nil || len(h.patchMgr.ProviderIDs()) == 0 {
		return tools.NewErrorResult(fmt.Errorf("no patch providers available"), time.Since(start).Milliseconds())
	}

	refs := h.patchRefsFromPayload(payload)
	if len(refs) == 0 {
		return tools.NewErrorResult(fmt.Errorf("no patches provided"), time.Since(start).Milliseconds())
	}

	results := make([]map[string]any, 0, len(refs))
	successCount := 0
	failedCount := 0
	rebootRequired := false

	for _, ref := range refs {
		installID, resolveErr := h.resolvePatchInstallID(ref)
		if resolveErr != nil {
			failedCount++
			result := patchCommandResultFields(ref, "")
			result["status"] = "failed"
			result["error"] = resolveErr.Error()
			results = append(results, result)
			continue
		}

		if rollback {
			if err := h.patchMgr.Uninstall(installID); err != nil {
				failedCount++
				result := patchCommandResultFields(ref, installID)
				result["status"] = "failed"
				result["error"] = err.Error()
				results = append(results, result)
				continue
			}
			successCount++
			result := patchCommandResultFields(ref, installID)
			result["status"] = "rolled_back"
			results = append(results, result)
			continue
		}

		installResult, err := h.patchMgr.Install(installID)
		if err != nil {
			failedCount++
			result := patchCommandResultFields(ref, installID)
			result["status"] = "failed"
			result["error"] = err.Error()
			results = append(results, result)
			continue
		}

		successCount++
		rebootRequired = rebootRequired || installResult.RebootRequired
		result := patchCommandResultFields(ref, installID)
		result["status"] = "installed"
		result["rebootRequired"] = installResult.RebootRequired
		result["message"] = installResult.Message
		results = append(results, result)
	}

	summary := map[string]any{
		"success":        failedCount == 0,
		"installedCount": successCount,
		"failedCount":    failedCount,
		"rebootRequired": rebootRequired,
		"results":        results,
	}
	if rollback {
		summary["rolledBackCount"] = successCount
	}

	// Post-install rescan: trigger an immediate patch inventory so the
	// dashboard reflects the new state without waiting up to 15 minutes.
	if successCount > 0 {
		go func() {
			defer func() {
				if r := recover(); r != nil {
					log.Error("post-install patch rescan panicked", "recover", r)
				}
			}()
			// Wait for macOS to finish installing before rescanning
			select {
			case <-time.After(60 * time.Second):
				log.Info("post-install patch rescan triggered", "successCount", successCount)
				h.sendPatchInventory()
				// Reset the daily gate so the scheduler doesn't re-scan immediately.
				h.mu.Lock()
				h.lastPatchUpdate = time.Now()
				h.mu.Unlock()
			case <-h.stopChan:
				log.Info("post-install patch rescan cancelled — agent shutting down")
			}
		}()
	}

	durationMs := time.Since(start).Milliseconds()
	if failedCount > 0 {
		stdout, _ := json.Marshal(summary)
		return tools.CommandResult{
			Status:     "failed",
			ExitCode:   1,
			Stdout:     string(stdout),
			Error:      fmt.Sprintf("%d patch operations failed", failedCount),
			DurationMs: durationMs,
		}
	}

	return tools.NewSuccessResult(summary, durationMs)
}

func patchCommandResultFields(ref patchCommandRef, installID string) map[string]any {
	result := map[string]any{
		"id":         ref.ID,
		"source":     ref.Source,
		"externalId": ref.ExternalID,
		"packageId":  ref.PackageID,
		"title":      ref.Title,
	}
	if installID != "" {
		result["installId"] = installID
	}
	return result
}

func (h *Heartbeat) patchRefsFromPayload(payload map[string]any) []patchCommandRef {
	refs := make([]patchCommandRef, 0)
	seen := map[string]struct{}{}

	if rawPatches, ok := payload["patches"].([]any); ok {
		for _, item := range rawPatches {
			obj, ok := item.(map[string]any)
			if !ok {
				continue
			}
			ref := patchCommandRef{
				ID:         tools.GetPayloadString(obj, "id", tools.GetPayloadString(obj, "patchId", "")),
				Source:     tools.GetPayloadString(obj, "source", ""),
				ExternalID: tools.GetPayloadString(obj, "externalId", ""),
				PackageID:  tools.GetPayloadString(obj, "packageId", ""),
				Title:      tools.GetPayloadString(obj, "title", ""),
			}
			key := fmt.Sprintf("%s|%s|%s", ref.ID, ref.Source, ref.ExternalID)
			if key == "||" {
				continue
			}
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			refs = append(refs, ref)
		}
	}

	for _, id := range tools.GetPayloadStringSlice(payload, "patchIds") {
		// Skip if this ID was already added via the patches array (which has
		// richer source/externalId info). The patches array uses a composite
		// key for dedup, so check all existing refs by ID directly.
		alreadyHave := false
		for _, existing := range refs {
			if existing.ID == id {
				alreadyHave = true
				break
			}
		}
		if alreadyHave {
			continue
		}
		key := fmt.Sprintf("%s||", id)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		refs = append(refs, patchCommandRef{ID: id})
	}

	return refs
}

func (h *Heartbeat) resolvePatchInstallID(ref patchCommandRef) (string, error) {
	if h.patchMgr == nil {
		return "", fmt.Errorf("patch manager unavailable")
	}

	if provider, local, ok := splitPatchID(ref.ID); ok && h.patchMgr.HasProvider(provider) {
		return provider + ":" + local, nil
	}
	if provider, local, ok := splitPatchID(ref.ExternalID); ok {
		switch provider {
		case "microsoft", "apple", "linux", "third_party", "custom":
		case "dnf":
			if h.patchMgr.HasProvider("yum") {
				return "yum:" + local, nil
			}
		default:
			if h.patchMgr.HasProvider(provider) {
				if (provider == "apt" || provider == "yum") && strings.Contains(local, "@") {
					return provider + ":" + strings.SplitN(local, "@", 2)[0], nil
				}
				return provider + ":" + local, nil
			}
		}
	}

	providerID := h.providerForPatchRef(ref)
	if providerID == "" {
		providerID = h.patchMgr.DefaultProviderID()
	}
	if providerID == "" {
		return "", fmt.Errorf("no provider available for patch %q", ref.ID)
	}

	localID := patchLocalID(ref)
	if localID == "" {
		return "", fmt.Errorf("unable to resolve local patch identifier for %q", ref.ID)
	}

	return providerID + ":" + localID, nil
}

func (h *Heartbeat) providerForPatchRef(ref patchCommandRef) string {
	source := strings.ToLower(strings.TrimSpace(ref.Source))
	switch source {
	case "microsoft":
		if h.patchMgr.HasProvider("windows-update") {
			return "windows-update"
		}
		if h.patchMgr.HasProvider("chocolatey") {
			return "chocolatey"
		}
	case "apple":
		if externalLooksLikeHomebrew(ref.ExternalID) && h.patchMgr.HasProvider("homebrew") {
			return "homebrew"
		}
		if h.patchMgr.HasProvider("apple-softwareupdate") {
			return "apple-softwareupdate"
		}
		if h.patchMgr.HasProvider("homebrew") {
			return "homebrew"
		}
	case "linux":
		if h.patchMgr.HasProvider("apt") {
			return "apt"
		}
		if h.patchMgr.HasProvider("yum") {
			return "yum"
		}
	case "third_party":
		for _, providerID := range []string{"homebrew", "chocolatey", "apt", "yum"} {
			if h.patchMgr.HasProvider(providerID) {
				return providerID
			}
		}
	}

	if provider, _, ok := splitPatchID(ref.ExternalID); ok && h.patchMgr.HasProvider(provider) {
		return provider
	}
	if provider, _, ok := splitPatchID(ref.ID); ok && h.patchMgr.HasProvider(provider) {
		return provider
	}

	return ""
}

func splitPatchID(value string) (string, string, bool) {
	parts := strings.SplitN(strings.TrimSpace(value), ":", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", false
	}
	return parts[0], parts[1], true
}

func patchLocalID(ref patchCommandRef) string {
	if _, local, ok := splitPatchID(ref.PackageID); ok {
		return local
	}
	if ref.PackageID != "" {
		return ref.PackageID
	}
	if _, local, ok := splitPatchID(ref.ExternalID); ok {
		prefix, _, _ := splitPatchID(ref.ExternalID)
		if (prefix == "apt" || prefix == "yum") && strings.Contains(local, "@") {
			return strings.SplitN(local, "@", 2)[0]
		}
		parts := strings.SplitN(ref.ExternalID, ":", 3)
		if len(parts) == 3 && isSourcePrefix(parts[0]) && parts[1] != "" {
			return parts[1]
		}
		return local
	}
	if _, local, ok := splitPatchID(ref.ID); ok {
		prefix, _, _ := splitPatchID(ref.ID)
		if (prefix == "apt" || prefix == "yum") && strings.Contains(local, "@") {
			return strings.SplitN(local, "@", 2)[0]
		}
		return local
	}
	if ref.ExternalID != "" {
		return ref.ExternalID
	}
	if ref.ID != "" {
		return ref.ID
	}
	return ref.Title
}

func externalLooksLikeHomebrew(externalID string) bool {
	prefix, _, ok := splitPatchID(externalID)
	if !ok {
		return false
	}
	return prefix == "homebrew" || prefix == "brew" || prefix == "cask"
}

func isSourcePrefix(prefix string) bool {
	switch strings.ToLower(prefix) {
	case "microsoft", "apple", "linux", "third_party", "custom":
		return true
	default:
		return false
	}
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// handleWatchdogUpgrade swaps the on-disk breeze-watchdog binary to
// targetVersion and restarts the watchdog service. Invoked when the server sets
// watchdogUpgradeTo in the heartbeat response (it does so only after a watchdog
// failover heartbeat told it the on-disk watchdog is behind the latest
// published watchdog component). Mirrors the helper-upgrade flow's security
// posture: refuses to install a watchdog OLDER than the running agent so a
// compromised/replayed control-plane response can't push a known-vulnerable,
// validly-signed older watchdog. The actual binary fetch is signature- and
// checksum-verified by the updater against the signed release manifest.
func (h *Heartbeat) handleWatchdogUpgrade(targetVersion string) {
	defer observability.Recoverer("heartbeat.handleWatchdogUpgrade")

	if targetVersion == "" {
		return
	}

	if !h.config.AutoUpdate {
		log.Info("watchdog upgrade available but auto_update is disabled",
			"targetVersion", targetVersion)
		return
	}

	// SECURITY: the target always originates from the control plane and must be
	// a real release semver. Fail CLOSED on an unparseable target (matching the
	// helper-upgrade guard's posture) so a compromised/MITM'd control plane
	// can't slip a non-semver value past the downgrade check below — isDowngrade
	// fails OPEN on unparseable input, which is the right call for agent "dev"
	// builds but wrong for a server-directed privileged swap.
	if _, _, _, ok := parseSemver(targetVersion); !ok {
		log.Error("SECURITY: refusing watchdog upgrade to non-semver target",
			"targetVersion", targetVersion)
		return
	}

	// SECURITY: never auto-downgrade the watchdog. The signed manifest only
	// binds manifest.Release == requested version, so a compromised/MITM'd
	// control plane could otherwise replay an older, validly-signed,
	// known-vulnerable watchdog. The watchdog ships in lockstep with the agent,
	// so the running agent's version is a safe floor. (Note: the target normally
	// EQUALS the agent version — both at latest — which is exactly when a stale
	// watchdog needs swapping, so equality must NOT be treated as a no-op.)
	if isDowngrade(targetVersion, h.agentVersion) {
		log.Error("SECURITY: refusing server-directed watchdog downgrade",
			"agentVersion", h.agentVersion, "targetVersion", targetVersion)
		return
	}

	// Dedupe / throttle: the server re-sends watchdogUpgradeTo every heartbeat
	// until a watchdog failover heartbeat reports the new version, but a healthy
	// watchdog doesn't heartbeat — so guard against re-swapping on a loop.
	h.watchdogUpgradeMu.Lock()
	if h.watchdogInstalledVersion == targetVersion {
		h.watchdogUpgradeMu.Unlock()
		return // already installed this target this run
	}
	if h.watchdogLastAttemptVer == targetVersion &&
		time.Since(h.watchdogLastAttemptAt) < watchdogUpgradeRetryCooldown {
		h.watchdogUpgradeMu.Unlock()
		log.Debug("watchdog upgrade recently attempted; backing off",
			"targetVersion", targetVersion)
		return
	}
	h.watchdogLastAttemptVer = targetVersion
	h.watchdogLastAttemptAt = time.Now()
	h.watchdogUpgradeMu.Unlock()

	if !h.watchdogUpgradeInProgress.CompareAndSwap(false, true) {
		log.Debug("watchdog upgrade already in progress", "targetVersion", targetVersion)
		return
	}
	defer h.watchdogUpgradeInProgress.Store(false)

	install := h.watchdogInstaller
	if install == nil {
		install = h.installAndRestartWatchdog
	}

	log.Info("watchdog upgrade requested", "targetVersion", targetVersion)
	if err := install(targetVersion); err != nil {
		// Leave watchdogInstalledVersion unset so a transient failure retries
		// after the cooldown rather than every tick.
		log.Error("failed to update watchdog", "targetVersion", targetVersion, "error", err.Error())
		return
	}
	h.watchdogUpgradeMu.Lock()
	h.watchdogInstalledVersion = targetVersion
	h.watchdogUpgradeMu.Unlock()
	log.Info("watchdog upgrade applied", "targetVersion", targetVersion)
}

// watchdogUpgradeRetryCooldown bounds how often a FAILING watchdog upgrade
// target is retried. A successful install is deduped permanently for the
// process lifetime via watchdogInstalledVersion; this only throttles repeated
// failures so a stuck device doesn't re-download + restart the watchdog service
// every heartbeat.
const watchdogUpgradeRetryCooldown = 30 * time.Minute

// downloadWatchdogBinary fetches the watchdog component at targetVersion to a
// temp file using the standard updater download path, which verifies the
// Ed25519 release-manifest signature AND the SHA-256 file checksum before
// returning. The caller owns the returned temp file (must remove it) and is
// responsible for the platform-specific swap + service restart. Shared across
// the per-OS installAndRestartWatchdog implementations so the trust-verified
// download lives in one place.
func (h *Heartbeat) downloadWatchdogBinary(targetVersion string) (string, error) {
	u := updater.New(&updater.Config{
		ServerURL:             h.serverURL(),
		AuthToken:             h.secureToken,
		CurrentVersion:        h.agentVersion,
		Component:             "watchdog",
		PinnedManifestPubKeys: h.config.PinnedManifestPubKeys,
	})
	return u.DownloadBinary(targetVersion)
}

// handleUpgrade performs an auto-update to the specified version.
// A 30-minute watchdog context prevents the upgradeInProgress flag from
// being stuck indefinitely if the update hangs.
func (h *Heartbeat) handleUpgrade(targetVersion string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		defer observability.Recoverer("heartbeat.upgrade")
		h.doUpgrade(targetVersion)
	}()

	select {
	case <-done:
		// Upgrade goroutine finished normally.
		h.upgradeInProgress.Store(false)
	case <-ctx.Done():
		log.Error("upgrade watchdog timeout exceeded; upgrade goroutine still running, blocking new attempts", "targetVersion", targetVersion)
		// Do NOT clear upgradeInProgress -- the goroutine is still alive.
		// It will remain blocked until the process restarts.
	}
}

// prefetchUserHelper pre-downloads breeze-user-helper.exe so the upgrade-restart
// script can drop it alongside the new agent binary. Returns nil when the
// helper is not applicable (non-Windows) or could not be fetched (404 for
// pre-#816 releases, network errors, checksum mismatches, manifest signature
// failure, etc.). Callers proceed with an agent-only upgrade in that case —
// non-fatal by design (issue #816).
//
// Without this prefetch, in-place upgrades produce an agent install missing
// the user-helper (only the MSI installer ever placed it on disk before #816),
// the HelperLifecycleManager falls through to a `breeze-agent.exe user-helper`
// fallback every ~30s, and orphaned processes accumulate during heartbeat
// goroutine wedges until the service dies.
//
// ANY download failure is non-fatal — we log a WARN and return nil. This is
// intentional and covers more than just 404s:
//
//	(a) pre-#816 releases legitimately lack the user-helper artifact, so we
//	    don't want to block their upgrades, and
//	(b) we'd rather degrade than fail an agent upgrade on a transient
//	    helper-fetch glitch.
//
// `currentVersion` is included in the WARN so operators can tell the
// "legitimately pre-#816, ignore" case apart from the "this release SHOULD
// have shipped the artifact, something's broken" case.
func (h *Heartbeat) prefetchUserHelper(targetVersion, binaryPath string) *updater.BinaryPair {
	goos := h.userHelperGOOS
	if goos == "" {
		goos = runtime.GOOS
	}
	if goos != "windows" {
		return nil
	}

	download := h.userHelperDownloader
	if download == nil {
		helperCfg := &updater.Config{
			ServerURL:             h.serverURL(),
			AuthToken:             h.secureToken,
			CurrentVersion:        h.agentVersion,
			Component:             "user-helper",
			PinnedManifestPubKeys: h.config.PinnedManifestPubKeys,
		}
		helperUpdater := updater.New(helperCfg)
		download = helperUpdater.DownloadBinary
	}

	tempPath, dlErr := download(targetVersion)
	if dlErr != nil {
		log.Warn(
			"user-helper download failed; proceeding with agent-only upgrade",
			"currentVersion", h.agentVersion,
			"targetVersion", targetVersion,
			"error", dlErr.Error(),
		)
		return nil
	}

	pair := &updater.BinaryPair{
		Temp:   tempPath,
		Target: filepath.Join(filepath.Dir(binaryPath), "breeze-user-helper.exe"),
	}
	log.Info(
		"pre-downloaded user-helper for restart-helper swap",
		"temp", pair.Temp,
		"target", pair.Target,
	)
	return pair
}

// reconcileUserHelper self-heals a Windows agent whose breeze-user-helper.exe
// sibling is missing from disk, decoupled from any version upgrade. The MSI
// installer and the in-place upgrade prefetch (see prefetchUserHelper) are the
// only two vectors that ever place the helper, so an agent installed via a
// vector that skips it (direct-exe enrollment, pre-#816 MSI) and already at the
// latest version has no path to acquire it — it falls back to spawning
// breeze-agent.exe as the helper every ~30s, which is unstable (issue #816
// follow-up). This reconciliation closes that gap: if the helper is absent next
// to the agent, fetch the matching CURRENT version via the user-helper update
// component and drop it in. All failure modes are non-fatal — we log and return
// so a fetch glitch never wedges the heartbeat.
func (h *Heartbeat) reconcileUserHelper(binaryPath string) {
	goos := h.userHelperGOOS
	if goos == "" {
		goos = runtime.GOOS
	}
	if goos != "windows" {
		// macOS/Linux have no sibling helper binary — the helper runs as a
		// breeze-agent subcommand — so there is nothing to reconcile.
		return
	}

	helperPath := filepath.Join(filepath.Dir(binaryPath), "breeze-user-helper.exe")
	switch fi, statErr := os.Stat(helperPath); {
	case statErr == nil && fi.Size() > 0:
		// Present and non-empty — nothing to heal. If we'd been failing (e.g.
		// the helper was restored out-of-band via dev_update / MSI repair /
		// manual copy), clear the consecutive-failure counter so a later
		// transient failure starts fresh rather than from a stale high count.
		if prev := h.userHelperReconcileFailures.Swap(0); prev >= userHelperReconcilePersistentThreshold {
			log.Info("user-helper present again after persistent reconcile failures", "previousFailures", prev)
		}
		return
	case statErr == nil:
		// Present but zero-length: a previous install was interrupted mid-write
		// (or an external truncation). Treat as absent and re-fetch — otherwise
		// the corpse blocks self-heal forever, since the spawn would load a
		// broken binary. (The atomic install path makes us-produced truncation
		// impossible, so this is defense-in-depth against external causes.)
		log.Warn("user-helper reconciliation: helper present but zero-length, re-fetching",
			"path", helperPath)
	case !os.IsNotExist(statErr):
		// An unexpected stat error (permissions, transient IO) is not a
		// confirmed absence — don't risk fetching/clobbering over a binary we
		// merely couldn't read.
		log.Warn("user-helper reconciliation: cannot stat helper, skipping this tick",
			"path", helperPath, "error", statErr.Error())
		return
	}

	// Fetch the binary matching the CURRENTLY-installed agent version, not
	// "latest". The helper shares the agent's IPC protocol and behavior, so it
	// must track the running agent — pulling a newer release's helper risks a
	// protocol/behavior skew against the older agent still in place. (Note: the
	// broker's hash allowlist is content-based, not version-gated —
	// installUserHelperBinary copies then RefreshAllowedHashes admits whatever
	// landed on disk — so the allowlist is NOT the reason to prefer current.)
	download := h.userHelperDownloader
	if download == nil {
		helperCfg := &updater.Config{
			ServerURL:             h.serverURL(),
			AuthToken:             h.secureToken,
			CurrentVersion:        h.agentVersion,
			Component:             "user-helper",
			PinnedManifestPubKeys: h.config.PinnedManifestPubKeys,
		}
		download = updater.New(helperCfg).DownloadBinary
	}

	tempPath, dlErr := download(h.agentVersion)
	if dlErr != nil {
		// Non-fatal: a transient fetch failure (network, server hiccup) should
		// not wedge the heartbeat. The next reconcile tick retries. A version
		// whose user-helper artifact genuinely doesn't exist (pre-#816 release)
		// would 404 every tick — noteUserHelperReconcileFailure escalates that
		// from WARN to a distinct ERROR so it doesn't loop silently forever.
		h.noteUserHelperReconcileFailure("download_failed", dlErr)
		return
	}
	defer func() { _ = os.Remove(tempPath) }()

	install := h.userHelperInstaller
	if install == nil {
		install = func(temp, ip, ver string) error {
			_, err := h.installUserHelperBinary(temp, ip, ver)
			return err
		}
	}
	if err := install(tempPath, helperPath, h.agentVersion); err != nil {
		h.noteUserHelperReconcileFailure("install_failed", err)
		return
	}
	if prev := h.userHelperReconcileFailures.Swap(0); prev >= userHelperReconcilePersistentThreshold {
		log.Info("user-helper reconciliation recovered after persistent failures", "previousFailures", prev)
	}
	log.Info("user-helper reconciliation: installed missing helper binary",
		"path", helperPath, "version", h.agentVersion)
}

// userHelperReconcilePersistentThreshold is the consecutive-failure count at
// which reconcileUserHelper escalates from a routine WARN to a distinct ERROR
// (~2h at the 30-min reconcile cadence). userHelperReconcileReLogEvery re-emits
// the ERROR periodically thereafter (~daily) so a stuck device stays visible
// without logging every tick.
const (
	userHelperReconcilePersistentThreshold = 4
	userHelperReconcileReLogEvery          = 48
)

// noteUserHelperReconcileFailure records a consecutive reconcile failure and
// logs it at a level that escalates with persistence: WARN on the first, ERROR
// once the failure count crosses the threshold (and periodically after), DEBUG
// in between so a permanently-unfetchable helper doesn't spam an indistinct
// WARN every tick. The ERROR carries a stable reason + consecutiveFailures so
// fleet telemetry can GROUP BY and alert on it.
func (h *Heartbeat) noteUserHelperReconcileFailure(reason string, err error) {
	n := h.userHelperReconcileFailures.Add(1)
	switch {
	case n >= userHelperReconcilePersistentThreshold &&
		(n == userHelperReconcilePersistentThreshold || n%userHelperReconcileReLogEvery == 0):
		log.Error("user-helper reconciliation persistently failing — device cannot self-heal its missing helper",
			"reason", reason, "consecutiveFailures", n,
			"currentVersion", h.agentVersion, "error", err.Error())
	case n == 1:
		log.Warn("user-helper reconciliation failed; will retry on a later tick",
			"reason", reason, "consecutiveFailures", n,
			"currentVersion", h.agentVersion, "error", err.Error())
	default:
		log.Debug("user-helper reconciliation still failing",
			"reason", reason, "consecutiveFailures", n, "error", err.Error())
	}
}

// reconcileUserHelperFromExecutable is the production entry point for
// reconcileUserHelper: it resolves the running agent's on-disk path (following
// symlinks) and delegates. Split out so reconcileUserHelper stays a pure
// function of an injected binaryPath for testing.
func (h *Heartbeat) reconcileUserHelperFromExecutable() {
	if runtime.GOOS != "windows" {
		return
	}
	binaryPath, err := os.Executable()
	if err != nil {
		log.Warn("user-helper reconciliation: cannot resolve executable path", "error", err.Error())
		return
	}
	if resolved, symErr := filepath.EvalSymlinks(binaryPath); symErr == nil {
		binaryPath = resolved
	}
	h.reconcileUserHelper(binaryPath)
}

// doUpgrade contains the actual upgrade logic, called by handleUpgrade.
func (h *Heartbeat) doUpgrade(targetVersion string) {
	log.Info("upgrade requested", "targetVersion", targetVersion)

	h.sendUpdateStatus(targetVersion)
	// Give the WebSocket write goroutine time to flush the update_status
	// message to the server before the binary is replaced and the process
	// is restarted (e.g. via launchctl kickstart). Without this, the device
	// may appear "Offline" instead of "Updating" in the dashboard.
	time.Sleep(500 * time.Millisecond)

	binaryPath, err := os.Executable()
	if err != nil {
		log.Error("failed to get executable path", "error", err.Error())
		return
	}

	binaryPath, err = filepath.EvalSymlinks(binaryPath)
	if err != nil {
		log.Error("failed to resolve symlinks", "error", err.Error())
		return
	}

	backupDir := config.GetDataDir()
	if err := os.MkdirAll(backupDir, 0755); err != nil {
		log.Error("failed to create backup directory", "path", backupDir, "error", err.Error())
		return
	}
	backupPath := filepath.Join(backupDir, "breeze-agent.backup")

	updaterCfg := &updater.Config{
		ServerURL:             h.serverURL(),
		AuthToken:             h.secureToken,
		CurrentVersion:        h.agentVersion,
		BinaryPath:            binaryPath,
		BackupPath:            backupPath,
		PinnedManifestPubKeys: h.config.PinnedManifestPubKeys,
	}

	// Pre-download breeze-user-helper.exe on Windows so the restart-helper
	// script can drop it alongside the new agent binary. See prefetchUserHelper
	// for the full rationale (issue #816 / PR #845). All failure modes are
	// non-fatal — a nil return value is the normal "agent-only upgrade"
	// outcome.
	userHelperPair := h.prefetchUserHelper(targetVersion, binaryPath)

	u := updater.New(updaterCfg)
	if err := u.UpdateToWithOptions(targetVersion, updater.UpdateOptions{UserHelper: userHelperPair}); err != nil {
		// If the filesystem is read-only, stop retrying — this is permanent
		// until the service unit is fixed or the filesystem is remounted.
		// Intentionally NOT persisted to disk (unlike dev_push in handlers_devupdate.go)
		// so that fixing ReadWritePaths + restarting the service auto-recovers.
		if errors.Is(err, updater.ErrReadOnlyFS) {
			if !h.updateReadOnlyLogged {
				log.Error("auto-update disabled: binary path is read-only — update the systemd unit to add the binary path to ReadWritePaths, then restart the service", "targetVersion", targetVersion, "error", err.Error())
				h.updateReadOnlyLogged = true
			}
			h.config.AutoUpdate = false
			return
		}
		// File locked by another process is transient — log and retry next heartbeat.
		if errors.Is(err, updater.ErrFileLocked) {
			log.Warn("update deferred: binary locked by another process, will retry", "targetVersion", targetVersion, "error", err.Error())
			return
		}
		// Binary is currently executing (ETXTBSY) — transient, retry next heartbeat.
		if errors.Is(err, updater.ErrTextBusy) {
			log.Warn("update deferred: binary is executing, will retry", "targetVersion", targetVersion, "error", err.Error())
			return
		}
		log.Error("failed to update", "targetVersion", targetVersion, "error", err.Error())
		return
	}

	log.Info("update successful, blocking old process to prevent stale heartbeats", "targetVersion", targetVersion)

	// On macOS/Linux, launchctl kickstart -k / systemctl restart return
	// immediately while the old process keeps running. If we return here,
	// the heartbeat loop will send another heartbeat with the OLD version,
	// overwriting the new version in the database. Block forever so the
	// service manager kills us.
	select {}
}
