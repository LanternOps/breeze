package agentapp

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/pkg/api"
	"github.com/spf13/cobra"
)

// defaultSupportServer is the control-plane URL a Quick Support client falls
// back to when neither the filename nor --server supplies one. Injected at
// build time per region:
//
//	-ldflags "-X github.com/breeze-rmm/agent/internal/agentapp.defaultSupportServer=https://us.2breeze.app"
//
// Deliberately empty in the repo: no region hostname is ever committed (see
// the "no internal infrastructure details in public code" rule). Empty means
// the client asks the end user for the server, which is the correct
// self-hosted behaviour anyway.
var defaultSupportServer = ""

// supportCode is the --code flag. --server reuses the root command's
// persistent serverURL flag rather than declaring a shadowing local one.
var supportCode string

var supportCmd = &cobra.Command{
	Use:   "support",
	Short: "Run a one-time Quick Support session (nothing is installed)",
	Long: `Runs this binary as an ephemeral Breeze Quick Support client.

The client redeems a one-time support code, enrolls a temporary device into a
directory under the system temp folder, serves a single remote-support session,
and then removes itself. Nothing is permanently installed and no existing
Breeze agent on this machine is touched.

The code and server are normally embedded in the downloaded filename
(breeze-support-<CODE>-<host>.exe); --code / --server override them, and if
neither is available the client prompts.`,
	Run: func(cmd *cobra.Command, args []string) {
		runSupportSession()
	},
}

// supportCodeAlphabet is the server's code alphabet: A-Z minus I/L/O/U, plus
// 2-9. The excluded characters are the ones users mis-hear or mis-read over
// the phone (I/1/L, O/0), which is the whole point of a spoken support code.
const supportCodeAlphabet = "ABCDEFGHJKMNPQRSTVWXYZ23456789"

var supportCodeRe = regexp.MustCompile(`^[` + supportCodeAlphabet + `]{9}$`)

// supportFilenameRe parses the download filename
// breeze-support-<CODE>-<apiHost>.exe.
//
// The trailing `(?:\s?\(\d+\))?` is the browser duplicate-download marker:
// Chrome and Edge insert a space before it ("... (1).exe"), Firefox does not
// ("...(1).exe"). Both must parse, or a user who downloads twice gets an
// interactive prompt for a code they were told is already "in the file".
//
// The host group is non-greedy so the dedup marker is never folded into it.
var supportFilenameRe = regexp.MustCompile(`(?i)^breeze-support-([a-z2-9]{9})-(.+?)(?:\s?\(\d+\))?\.exe$`)

// supportHostPortRe decodes the `host_PORT` suffix the download route emits
// for a nonstandard port. `:` is illegal in a Windows filename and Chromium
// silently rewrites it to `_` at save time — that is exactly how #2341
// shipped silently-unenrolled installs — so the server encodes the colon and
// the client decodes it back.
//
// Mirrors internal/agentapp/installer_filename.go's `(?:_([0-9]{1,5}))?`
// terminator, with one deliberate difference: that decoder's host charset
// (`[a-zA-Z0-9.\-]+`) excludes `_` entirely, so it cannot express "the last
// underscore group". Here the host group is `(.+?)`, so the greedy `.*` below
// anchors on the LAST underscore and the 1-5 digit bound keeps a hostname
// that legitimately contains an underscore (host_evil, host_123456) intact.
// For every filename the server can actually emit, the two agree.
var supportHostPortRe = regexp.MustCompile(`^(.*)_([0-9]{1,5})$`)

// errNoSupportCode means no code was supplied by flag OR embedded in the
// filename — the caller falls back to an interactive prompt. Distinct from a
// malformed code, which is reported with an explanation.
var errNoSupportCode = errors.New("no support code supplied and none embedded in the filename")

// normalizeSupportCode strips the display formatting a technician reads out
// loud (XXX-XXX-XXX, possibly with spaces) and upper-cases the result.
func normalizeSupportCode(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r == '-' || r == ' ' || r == '\t' {
			continue
		}
		b.WriteRune(r)
	}
	return strings.ToUpper(strings.TrimSpace(b.String()))
}

// decodeSupportHost turns the filename's `host_PORT` encoding back into
// `host:port`. Returns host unchanged when there is no numeric port suffix.
func decodeSupportHost(host string) string {
	if m := supportHostPortRe.FindStringSubmatch(host); m != nil {
		return m[1] + ":" + m[2]
	}
	return host
}

// resolveSupportInput determines the support code and server URL for this
// run. Explicit flags always win over the filename; whatever the filename
// supplies fills the gaps. Returns an error — errNoSupportCode when nothing
// was supplied at all — so the caller can fall back to an interactive prompt.
//
// The server is returned even on error (a filename may carry a usable host
// with an unusable code) so the prompt can pre-fill it.
func resolveSupportInput(argv0, codeFlag, serverFlag string) (code, server string, err error) {
	code = normalizeSupportCode(codeFlag)
	server = strings.TrimSpace(serverFlag)

	if fileCode, fileHost, ok := parseSupportFilename(supportBase(argv0)); ok {
		if code == "" {
			code = fileCode
		}
		if server == "" {
			server = "https://" + fileHost
		}
	}

	if code == "" {
		return "", server, errNoSupportCode
	}
	if !supportCodeRe.MatchString(code) {
		return "", server, fmt.Errorf("%q is not a valid support code (9 characters, letters and digits, no I/L/O/U/0/1)", code)
	}
	return code, server, nil
}

// supportBase is filepath.Base that understands BOTH separators regardless of
// the OS it is compiled for. argv[0] of a Quick Support client is always a
// Windows path (`C:\Users\me\Downloads\...`), but the parser is unit-tested on
// Linux CI, where filepath.Base would return the whole string and silently
// make every path-shaped table case vacuous.
func supportBase(path string) string {
	if i := strings.LastIndexAny(path, `/\`); i >= 0 {
		return path[i+1:]
	}
	return filepath.Base(path)
}

// parseSupportFilename extracts the code and API host embedded in a Quick
// Support download filename. The code is upper-cased (the filesystem, and a
// user renaming the file, do not preserve case) and the host's `_PORT`
// encoding is decoded back to `:port`.
func parseSupportFilename(base string) (code, host string, ok bool) {
	m := supportFilenameRe.FindStringSubmatch(base)
	if m == nil {
		return "", "", false
	}
	return strings.ToUpper(m[1]), decodeSupportHost(m[2]), true
}

// supportWorkDir is the throwaway workspace for this support client: config,
// secrets and log file all live here and the whole tree is removed on
// teardown. Keyed by PID so two concurrent support clients (a user who runs
// the download twice) cannot fight over one directory.
//
// It is NEVER config.ConfigDir(). A support client writing into
// C:\ProgramData\Breeze would overwrite the config, secrets and agent.state
// of a real permanently-installed agent on the same machine — the single most
// destructive failure mode this feature has.
func supportWorkDir() string {
	return filepath.Join(os.TempDir(), fmt.Sprintf("breeze-support-%d", os.Getpid()))
}

// configDirForSupportGuard exposes the real agent config dir to the guard
// test that pins supportWorkDir away from it.
func configDirForSupportGuard() string { return config.ConfigDir() }

const (
	// supportDisconnectGrace is how long the WebSocket may report
	// disconnected before the dead-man switch tears the session down. This is
	// the backstop for a support_end command that never arrived (server
	// unreachable, session revoked while the client was offline): without it a
	// client whose control plane vanished would sit on the user's desktop
	// indefinitely.
	supportDisconnectGrace = 10 * time.Minute

	// supportWatchdogInterval is how often the dead-man switch samples
	// connectivity and the clock.
	supportWatchdogInterval = 15 * time.Second
)

// supportWatchdogDecision returns the notice to print before self-destructing,
// or "" to keep running. disconnectedSince is the zero time while the
// WebSocket is connected; hardExpiresAt is the zero time when the server did
// not supply one (or it could not be parsed).
func supportWatchdogDecision(now, disconnectedSince, hardExpiresAt time.Time) string {
	if !hardExpiresAt.IsZero() && now.After(hardExpiresAt) {
		return "This support session has expired. Closing."
	}
	if !disconnectedSince.IsZero() && now.Sub(disconnectedSince) >= supportDisconnectGrace {
		return fmt.Sprintf("Lost contact with the Breeze server for %s. Closing.", supportDisconnectGrace)
	}
	return ""
}

// supportBanner is the v1 "status window": this client has no GUI, so the
// console it was launched from IS the UI the end user sees.
const supportBanner = `
Breeze Quick Support
─────────────────────────────────────
Connected. Waiting for your technician…
Nothing is permanently installed. Close this window
or press Ctrl+C at any time to stop sharing.
`

// promptSupportInput asks the end user for the values the filename and flags
// did not supply. Only reached when the download filename was renamed or the
// binary was invoked directly.
func promptSupportInput(prefillServer string) (code, server string, err error) {
	reader := bufio.NewReader(os.Stdin)

	server = strings.TrimSpace(prefillServer)
	if server == "" {
		server = strings.TrimSpace(defaultSupportServer)
	}
	if server == "" {
		fmt.Print("Breeze server URL (e.g. https://rmm.example.com): ")
		line, readErr := reader.ReadString('\n')
		if readErr != nil && strings.TrimSpace(line) == "" {
			return "", "", fmt.Errorf("could not read the server URL: %w", readErr)
		}
		server = strings.TrimSpace(line)
	}
	if server == "" {
		return "", "", errors.New("a Breeze server URL is required")
	}
	if !strings.Contains(server, "://") {
		server = "https://" + server
	}

	for attempt := 0; attempt < 3; attempt++ {
		fmt.Print("Enter the support code your technician gave you: ")
		line, readErr := reader.ReadString('\n')
		candidate := normalizeSupportCode(line)
		if candidate != "" && supportCodeRe.MatchString(candidate) {
			return candidate, server, nil
		}
		if readErr != nil {
			return "", server, fmt.Errorf("could not read the support code: %w", readErr)
		}
		fmt.Println("That doesn't look like a support code — it's 9 characters, like ABC-123-XYZ.")
	}
	return "", server, errors.New("no valid support code entered")
}

// supportFail prints a user-facing failure and exits nonzero. The end user is
// typically a non-technical person on the phone with a technician, so the
// message names the next action rather than the internals.
func supportFail(msg string, err error) {
	if err != nil {
		fmt.Fprintf(os.Stderr, "\n%s\n(%v)\n", msg, err)
	} else {
		fmt.Fprintf(os.Stderr, "\n%s\n", msg)
	}
	osExit(1)
}

// runSupportSession is the `support` command: redeem a one-time code, enroll
// an ephemeral device into a temp workspace, serve one remote-support session
// in the foreground, then self-destruct.
//
// The whole flow deliberately avoids the machine-wide install: the config
// lives under os.TempDir(), the watchdog and updater are off, and startAgent
// skips every ProgramData path (see the cfg.SupportMode gates there). A real
// enrolled agent may be running on this same machine and must be untouched.
func runSupportSession() {
	code, server, err := resolveSupportInput(os.Args[0], supportCode, serverURL)
	if err != nil {
		if !errors.Is(err, errNoSupportCode) {
			fmt.Fprintf(os.Stderr, "%v\n", err)
		}
		code, server, err = promptSupportInput(server)
		if err != nil {
			supportFail("Quick Support could not start.", err)
			return
		}
	}
	if server == "" {
		server = strings.TrimSpace(defaultSupportServer)
	}
	if server == "" {
		supportFail("Quick Support could not start: no Breeze server URL. Re-download the client from your technician's link.", nil)
		return
	}

	fmt.Println("Breeze Quick Support")
	fmt.Println("Connecting…")

	workDir := supportWorkDir()
	if err := os.MkdirAll(workDir, 0o700); err != nil {
		supportFail("Could not create a temporary working folder for this session.", err)
		return
	}
	supportCfgFile := filepath.Join(workDir, "agent.yaml")

	cfg := config.Default()
	cfg.ServerURL = server
	cfg.LogFile = filepath.Join(workDir, "support.log")
	// A disposable client neither installs nor is supervised by a watchdog.
	cfg.Watchdog.Enabled = false
	cfg.AutoUpdate = false
	cfg.SupportMode = true
	cfg.SupportWorkDir = workDir
	// Foreground process owning the interactive desktop: capture runs
	// in-process, so no SYSTEM helper has to be installed. startAgent pins
	// both again from cfg.SupportMode.
	cfg.IsService = false
	cfg.IsHeadless = false

	// The enroll path's console chatter is for an admin reading an MSI log,
	// not for the end user staring at this window. Only one command runs per
	// process, so setting the package flag here is safe.
	quietEnroll = true

	// Redirect structured logging into the workspace file before anything
	// else runs. Until this happens the logging package's default sink is
	// os.Stdout at info level, so collector and enrollment log lines would
	// land in the middle of the end user's status window. quiet=true forces
	// file-only; startAgent's initLogging keeps it file-only in support mode.
	initEnrollLogging(cfg, true)

	hwCollector := collectors.NewHardwareCollector()
	sysInfo, err := hwCollector.CollectSystemInfo()
	if err != nil || sysInfo == nil {
		sysInfo = &collectors.SystemInfo{}
	}
	hostname := strings.TrimSpace(sysInfo.Hostname)
	if hostname == "" {
		// The server stores this as the ephemeral device's name; a blank one
		// is useless to the technician looking at the session.
		if h, hErr := os.Hostname(); hErr == nil {
			hostname = strings.TrimSpace(h)
		}
	}
	osType := sysInfo.OSType
	if osType == "" {
		osType = runtime.GOOS
	}

	resp, err := api.RedeemSupportCode(server, code, hostname, osType)
	if err != nil {
		_ = os.RemoveAll(workDir)
		if errors.Is(err, api.ErrSupportCodeInvalid) {
			supportFail(err.Error(), nil)
			return
		}
		supportFail("Could not reach the Breeze server. Check your internet connection and try again.", err)
		return
	}

	// The redeem response is authoritative for the control-plane URL: a
	// self-hosted deployment can hand back a different (e.g. externally
	// reachable) address than the one the download link used.
	if strings.TrimSpace(resp.ServerURL) != "" {
		cfg.ServerURL = strings.TrimSpace(resp.ServerURL)
	}
	cfg.SupportSessionID = resp.SessionID

	// Ctrl+C, and the SIGTERM Windows sends when the console X is clicked.
	// The X gives roughly 5 seconds of grace, so every teardown path below
	// must be local-only — no network I/O.
	//
	// Registered BEFORE enrollment, not just before the wait loop: from here
	// on the workspace holds this session's device token, and the default
	// SIGINT disposition (kill the process) would strand it on disk. Trading
	// "Ctrl+C is instant" for "the workspace is always removed" is the right
	// way round for a client whose whole promise is that it leaves nothing.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := enrollWithConfig(cfg, supportCfgFile, resp.EnrollmentKey, resp.EnrollmentSecret); err != nil {
		_ = os.RemoveAll(workDir)
		supportFail("Could not start the support session. Ask your technician for a new code.", err)
		return
	}

	if ctx.Err() != nil {
		// Interrupted during enrollment — stop at the first point where doing
		// so is clean, rather than bringing an agent up just to tear it down.
		_ = os.RemoveAll(workDir)
		fmt.Println("Cancelled. Nothing was left installed.")
		return
	}

	comps, err := startAgentFn(cfg)
	if err != nil {
		_ = os.RemoveAll(workDir)
		supportFail("Could not start the support session on this computer.", err)
		return
	}
	defer logging.StopShipper()

	// Console status lines on session start/stop. Chained (not replaced) onto
	// the heartbeat's own desktop callbacks so the server still receives the
	// peer-disconnect notification.
	comps.hb.SetSupportSessionNotifier(
		func(string) { fmt.Println("Technician connected.") },
		func(string) { fmt.Println("Technician disconnected.") },
	)

	fmt.Print(supportBanner)

	hardExpiresAt := parseSupportHardExpiry(resp.HardExpiresAt)
	notice := runSupportWatchdog(ctx, comps, hardExpiresAt)
	if notice != "" {
		fmt.Println()
		fmt.Println(notice)
	} else {
		fmt.Println()
		fmt.Println("Ending the support session…")
	}

	// Teardown order: stop sharing and drop the connection first, then remove
	// the workspace. RunSupportCleanup also schedules the self-delete of this
	// executable on Windows.
	shutdownAgent(comps)
	comps.hb.RunSupportCleanup()
	fmt.Println("Support session ended. Nothing was left installed.")
}

// parseSupportHardExpiry parses the server's RFC3339 hard expiry. An absent or
// unparseable value yields the zero time, which the dead-man switch treats as
// "no hard expiry" — the disconnect grace is still in force, so a malformed
// timestamp degrades the backstop rather than removing it.
func parseSupportHardExpiry(raw string) time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}
	}
	t, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		log.Warn("could not parse support session hard expiry; relying on the disconnect grace alone",
			"value", raw, "error", err.Error())
		return time.Time{}
	}
	return t
}

// runSupportWatchdog blocks until the session must end, returning the notice
// to show the user ("" when the user themselves stopped it via ctx).
//
// It is the dead-man switch: a support client whose control plane went away
// must not linger on someone's desktop waiting for a support_end command that
// will never arrive.
func runSupportWatchdog(ctx context.Context, comps *agentComponents, hardExpiresAt time.Time) string {
	ticker := time.NewTicker(supportWatchdogInterval)
	defer ticker.Stop()

	var disconnectedSince time.Time
	for {
		select {
		case <-ctx.Done():
			return ""
		case now := <-ticker.C:
			if comps.wsClient != nil && comps.wsClient.IsConnected() {
				disconnectedSince = time.Time{}
			} else if disconnectedSince.IsZero() {
				disconnectedSince = now
			}
			if notice := supportWatchdogDecision(now, disconnectedSince, hardExpiresAt); notice != "" {
				return notice
			}
		}
	}
}
