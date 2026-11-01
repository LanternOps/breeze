package heartbeat

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// Post-update revival of the macOS desktop-helper LaunchAgent (#10868).
//
// A pkg upgrade's postinstall boots the user helper out of every GUI session
// and bootstraps it again. When that bootstrap fails (launchd had not finished
// the bootout: "Bootstrap failed: 5"), the helper is not loaded at all, and
// `launchctl kickstart -k` cannot start a service that is not loaded (exit
// 37). The helper then stays down, and remote desktop with it, until the user
// logs out and back in. The revival below bootstraps a helper it finds
// unloaded, which also repairs Macs whose older installer hit the same race.
//
// The decision logic takes launchctl as a function so tests can script launchd
// without shelling out; it has no darwin build tag so it runs in the Linux
// agent test job.

const (
	darwinUserHelperLabel = "com.breeze.desktop-helper-user"
	darwinUserHelperPlist = "/Library/LaunchAgents/com.breeze.desktop-helper-user.plist"

	// launchctlEIO is launchctl's "5: Input/output error", which bootstrap
	// returns both while launchd is still tearing a booted-out service down
	// and when the service is already loaded.
	launchctlEIO = 5
)

// launchctlTimeout bounds every launchctl call; a var so tests can shorten it.
var launchctlTimeout = 15 * time.Second

// launchctlFunc runs launchctl with args and returns its exit code (-1 when it
// could not be run at all or timed out) and its trimmed combined output.
type launchctlFunc func(args ...string) (int, string)

func runLaunchctl(args ...string) (int, string) {
	ctx, cancel := context.WithTimeout(context.Background(), launchctlTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "launchctl", args...)
	// Bound the wait for output too: a killed launchctl's children could
	// otherwise hold the pipe open past the timeout.
	cmd.WaitDelay = time.Second
	out, err := cmd.CombinedOutput()
	text := strings.TrimSpace(string(out))
	if err == nil {
		return 0, text
	}
	if ctx.Err() != nil {
		return -1, fmt.Sprintf("launchctl %s timed out after %s", strings.Join(args, " "), launchctlTimeout)
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() >= 0 {
		return exitErr.ExitCode(), text
	}
	if text == "" {
		text = err.Error()
	}
	return -1, text
}

// launchAgentTarget is one LaunchAgent in one launchd domain.
type launchAgentTarget struct {
	domain string // "gui/501"
	label  string
	plist  string
	uid    string // for logs
}

func (t launchAgentTarget) service() string { return t.domain + "/" + t.label }

func darwinUserHelperTarget(uid string) launchAgentTarget {
	return launchAgentTarget{
		domain: "gui/" + uid,
		label:  darwinUserHelperLabel,
		plist:  darwinUserHelperPlist,
		uid:    uid,
	}
}

type launchAgentOutcome int

const (
	// launchAgentKickstarted: it was loaded and kickstart -k restarted it.
	launchAgentKickstarted launchAgentOutcome = iota
	// launchAgentBootstrapped: it was not loaded; the revival loaded it.
	launchAgentBootstrapped
	// launchAgentLoadedElsewhere: our bootstrap failed because something
	// else (the pkg postinstall still running) loaded it first.
	launchAgentLoadedElsewhere
	// launchAgentLoadedNotStarted: launchd has it loaded but kickstart -k
	// fails; a bootstrap cannot help a loaded service.
	launchAgentLoadedNotStarted
	// launchAgentFailed: not loaded, and bootstrap did not load it.
	launchAgentFailed
)

func (o launchAgentOutcome) String() string {
	switch o {
	case launchAgentKickstarted:
		return "kickstarted"
	case launchAgentBootstrapped:
		return "bootstrapped"
	case launchAgentLoadedElsewhere:
		return "loaded-elsewhere"
	case launchAgentLoadedNotStarted:
		return "loaded-not-started"
	case launchAgentFailed:
		return "failed"
	}
	return "unknown"
}

type launchAgentReviver struct {
	launchctl launchctlFunc
	sleep     func(time.Duration)
}

var defaultLaunchAgentReviver = launchAgentReviver{launchctl: runLaunchctl, sleep: time.Sleep}

// loaded reports whether launchd has the service. An inconclusive print
// (launchctl could not run or timed out) counts as not loaded: the worst
// that does is a bootstrap that fails because the service is loaded.
func (r launchAgentReviver) loaded(t launchAgentTarget) bool {
	code, out := r.launchctl("print", t.service())
	if code < 0 {
		log.Warn("post-update: could not tell whether the desktop helper is loaded",
			"uid", t.uid, "service", t.service(), "output", out)
	}
	return code == 0
}

// revive restarts the LaunchAgent, loading it first when launchd does not
// have it. launchd's own state (`launchctl print`) decides "not loaded", not
// kickstart's exit code.
func (r launchAgentReviver) revive(t launchAgentTarget) launchAgentOutcome {
	svc := t.service()
	code, out := r.launchctl("kickstart", "-k", svc)
	if code == 0 {
		log.Info("post-update: kickstarted desktop helper", "uid", t.uid, "service", svc)
		return launchAgentKickstarted
	}
	if r.loaded(t) {
		log.Warn("post-update: launchctl kickstart failed on a loaded desktop helper",
			"uid", t.uid, "service", svc, "exitCode", code, "output", out)
		return launchAgentLoadedNotStarted
	}
	log.Warn("post-update: desktop helper is not loaded, bootstrapping it",
		"uid", t.uid, "service", svc, "kickstartExitCode", code, "output", out)

	outcome := launchAgentBootstrapped
	for attempt := 1; ; attempt++ {
		bcode, bout := r.launchctl("bootstrap", t.domain, t.plist)
		if bcode == 0 {
			log.Info("post-update: bootstrapped desktop helper",
				"uid", t.uid, "domain", t.domain, "plist", t.plist, "attempt", attempt)
			break
		}
		if r.loaded(t) {
			log.Info("post-update: launchctl bootstrap failed but the desktop helper is now loaded (the installer loaded it)",
				"uid", t.uid, "domain", t.domain, "exitCode", bcode, "output", bout)
			outcome = launchAgentLoadedElsewhere
			break
		}
		if bcode != launchctlEIO || attempt >= 2 {
			log.Warn("post-update: launchctl bootstrap failed; remote desktop stays unavailable for this user until they log out and back in",
				"uid", t.uid, "domain", t.domain, "plist", t.plist, "exitCode", bcode, "output", bout, "attempt", attempt)
			return launchAgentFailed
		}
		log.Warn("post-update: launchctl bootstrap returned 5, retrying once",
			"uid", t.uid, "domain", t.domain, "output", bout)
		r.sleep(time.Second)
	}

	// RunAtLoad normally has it starting already; a plain kickstart (no -k,
	// so a just-started helper is not killed) makes sure.
	if kcode, kout := r.launchctl("kickstart", svc); kcode != 0 {
		log.Warn("post-update: launchctl kickstart after bootstrap failed",
			"uid", t.uid, "service", svc, "exitCode", kcode, "output", kout)
	} else {
		log.Info("post-update: desktop helper started", "uid", t.uid, "service", svc)
	}
	return outcome
}

// reviveDarwinUserHelpers revives the user helper in every listed GUI
// session; one user's failure does not stop the next.
func reviveDarwinUserHelpers(r launchAgentReviver, uids []string) {
	for _, uid := range uids {
		r.revive(darwinUserHelperTarget(uid))
	}
}
