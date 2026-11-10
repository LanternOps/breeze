package oemupdates

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Dell Command Update lane (spec §5). Everything here that names a DCU flag,
// exit code, log format or installer switch comes from Dell's documentation and
// is unconfirmed until the Dell lab wave (W10); see testdata/dell/README.md.

const (
	dellLogName          = "dcu-apply.log"
	maxDellLogBytes      = 4 << 20
	dotnetDesktopRuntime = "dotnet_desktop_runtime"
)

// dellRange is the compiled supported range: the DSA-2026-309 floor, and the
// 5.x major the exit table below is written for. A payload can only narrow it.
var dellRange = VersionRange{Min: "5.7.1", MaxExclusive: "6.0.0"}

// dellExitCodes is keyed by tool major version, because Dell's exit codes
// differ across majors (§4.4). The 5.x table is from the 5.x CLI guide.
var dellExitCodes = map[uint64]map[int64]Outcome{
	5: {
		0:    OutcomeSuccess,
		1:    OutcomeSuccessRebootRequired,
		5:    OutcomeBlockedRebootPending, // reboot first, do not re-run
		500:  OutcomeNoUpdates,
		3:    OutcomeNotSupported,
		7:    OutcomeNotSupported,
		6:    OutcomeRetryLater,
		3003: OutcomeRetryLater,
		3004: OutcomeRetryLater,
		3005: OutcomeRetryLater,
		1000: OutcomeFailed,
		1001: OutcomeFailed,
		1002: OutcomeFailed,
		501:  OutcomeFailed,
		502:  OutcomeFailed,
		503:  OutcomeFailed,
	},
}

// dellUpdateTypes maps the policy categories to DCU's -updateType values. The
// order is fixed so the argument is stable.
var dellUpdateTypes = []struct{ category, flag string }{
	{CategoryBIOS, "bios"},
	{CategoryFirmware, "firmware"},
	{CategoryDriver, "driver"},
	{CategoryApplication, "application"},
}

// dellBlockedIDPattern keeps a blocked id from carrying a separator or an
// argument of its own into -localblockedswb.
var dellBlockedIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

// dellResultLine reads one doc-derived result line:
// "[time] : <ID>: <title> - <type> - <version> -- <result>".
var dellResultLine = regexp.MustCompile(`(?i)^(?:\[[^\]]*\]\s*:\s*)?([A-Z0-9]{5}):\s+(.+?)\s+-\s+(bios|firmware|driver|application)\s+-\s+(\S*)\s+--\s+(installed|failed|skipped|downloaded)\s*$`)

// dellHost is how the lane looks at the machine. Every reader is a stat or a
// file read: the availability gate must not spawn a process.
type dellHost struct {
	programFiles          func() []string
	exists                func(path string) bool
	fileVersion           func(path string) (string, error)
	dotnetDesktopVersions func() []string
}

type dellLane struct {
	host  dellHost
	gate  *ToolGate
	allow LaneAllowlist
}

func newDellLane(host dellHost) *dellLane {
	l := &dellLane{host: host}
	l.allow, _ = laneAllowlist(LaneDell)
	l.gate = NewToolGate("dell-command-update", l.detect)
	return l
}

func (l *dellLane) ID() string                   { return LaneDell }
func (l *dellLane) Gate() *ToolGate              { return l.gate }
func (l *dellLane) Allow() LaneAllowlist         { return l.allow }
func (l *dellLane) Range() VersionRange          { return dellRange }
func (l *dellLane) SkippedForNoReboot() []string { return []string{CategoryBIOS, CategoryFirmware} }

// ToolVersion re-reads dcu-cli.exe's PE version.
func (l *dellLane) ToolVersion(path string) (string, error) { return l.host.fileVersion(path) }

// FlashesOutsideFilter is true: Dell documents that dock firmware ignores
// -updateType, so even a driver-only run may write firmware.
func (l *dellLane) FlashesOutsideFilter() bool { return true }

// detect looks for dcu-cli.exe under both Program Files directories, 64-bit
// first. An unreadable version is reported as "", which is never in range.
func (l *dellLane) detect() ToolState {
	for _, base := range l.host.programFiles() {
		if base == "" {
			continue
		}
		path := strings.TrimRight(base, `\`) + `\Dell\CommandUpdate\dcu-cli.exe`
		if !l.host.exists(path) {
			continue
		}
		version, err := l.host.fileVersion(path)
		if err != nil {
			log.Debug("dcu-cli.exe version unreadable", "path", path, "error", err.Error())
			version = ""
		}
		return ToolState{Present: true, Path: path, Version: version}
	}
	return ToolState{}
}

func (l *dellLane) Filter(cats []string, blocked []string) (FilterPlan, error) {
	want := map[string]bool{}
	for _, c := range cats {
		if !IsCategory(c) {
			return FilterPlan{}, runErr("invalid_filter", fmt.Errorf("unknown category %q", c))
		}
		want[c] = true
	}
	var ordered []string
	for _, t := range dellUpdateTypes {
		if want[t.category] {
			ordered = append(ordered, t.category)
		}
	}
	for _, id := range blocked {
		if !dellBlockedIDPattern.MatchString(id) {
			return FilterPlan{}, runErr("invalid_blocked_id", fmt.Errorf("blocked id %q is not a Dell release id", id))
		}
	}
	return FilterPlan{Categories: ordered, BlockedIDs: append([]string(nil), blocked...)}, nil
}

// argv is the /applyUpdates invocation. Reboot is always disabled: Breeze owns
// the reboot. BitLocker suspension is Dell's own, per its documentation.
func (l *dellLane) argv(plan FilterPlan) []string {
	types := make([]string, 0, len(plan.Categories))
	for _, t := range dellUpdateTypes {
		for _, c := range plan.Categories {
			if c == t.category {
				types = append(types, t.flag)
			}
		}
	}
	args := []string{
		"/applyUpdates",
		"-silent",
		"-reboot=disable",
		"-autoSuspendBitLocker=enable",
		"-outputLog=" + filepath.Join(plan.WorkDir, dellLogName),
		"-updateType=" + strings.Join(types, ","),
	}
	if len(plan.BlockedIDs) > 0 {
		// Dell documents that dock updates ignore -updateType; whether they
		// honour this blocklist is not confirmed (testdata/dell/README.md).
		args = append(args, "-localblockedswb="+strings.Join(plan.BlockedIDs, ","))
	}
	return args
}

func (l *dellLane) Apply(ctx context.Context, tool ToolState, plan FilterPlan, ex Exec) (RunResult, error) {
	res := RunResult{Lane: LaneDell, Takeover: TakeoverNotAttempted}
	major, err := versionMajor(tool.Version)
	table, ok := dellExitCodes[major]
	if err != nil || !ok {
		res.Outcome, res.ErrorCode = OutcomeFailed, strPtr("unknown_tool_major")
		return res, runErr("unknown_tool_major", fmt.Errorf("no exit table for dcu %q", tool.Version))
	}
	logPath := filepath.Join(plan.WorkDir, dellLogName)
	if err := os.Remove(logPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		// A stale log would be read as this run's items.
		res.Outcome, res.ErrorCode = OutcomeFailed, strPtr("stale_log")
		return res, runErr("stale_log", err)
	}
	out, err := ex.Run(ctx, ExecSpec{Path: tool.Path, Args: l.argv(plan)})
	if err != nil {
		return res, err
	}
	res.RawExitCode = int64Ptr(out.ExitCode)
	outcome, mapped := table[out.ExitCode]
	if !mapped {
		outcome = OutcomeFailed
		res.ErrorCode = strPtr("unmapped_exit_code")
	}
	res.Outcome = outcome
	res.RebootRequired = out.ExitCode == 1 || out.ExitCode == 5

	items, ok := readDellLog(logPath)
	if !ok {
		// The log format is unconfirmed: a missing or unreadable log costs the
		// item list, never the run.
		if res.ErrorCode == nil {
			res.ErrorCode = strPtr("report_unavailable")
		}
		items = nil
	}
	res.Items = items
	return res, nil
}

// readDellLog parses the doc-derived log format. It is bounded and treats every
// byte as untrusted. ok is false only when the log cannot be read at all.
func readDellLog(path string) (items []Item, ok bool) {
	f, err := os.Open(path)
	if err != nil {
		return nil, false
	}
	defer func() { _ = f.Close() }()
	data, err := io.ReadAll(io.LimitReader(f, maxDellLogBytes+1))
	if err != nil || len(data) > maxDellLogBytes {
		return nil, false
	}
	type entry struct {
		item  Item
		final bool
	}
	order := []string{}
	byID := map[string]*entry{}
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for sc.Scan() {
		m := dellResultLine.FindStringSubmatch(sc.Text())
		if m == nil {
			continue
		}
		id, result := strings.ToUpper(m[1]), strings.ToLower(m[5])
		if result == "downloaded" {
			continue
		}
		e, seen := byID[id]
		if !seen {
			if len(order) >= maxItems {
				continue
			}
			e = &entry{}
			byID[id] = e
			order = append(order, id)
		}
		e.final = true
		e.item = Item{
			Title:    sanitizeToolText(m[2], maxItemTitle),
			Category: strings.ToLower(m[3]),
			Version:  sanitizeToolText(m[4], maxVersionLen),
			Result:   result,
		}
	}
	if sc.Err() != nil {
		return nil, false
	}
	items = make([]Item, 0, len(order))
	for _, id := range order {
		if e := byID[id]; e.final {
			items = append(items, e.item)
		}
	}
	return items, true
}

// InstallArgs runs the Dell Update Package silently with a log.
func (l *dellLane) InstallArgs(installer, logPath string) []string {
	return []string{"/s", "/l=" + logPath}
}

// Prerequisite knows one name: the .NET Desktop Runtime DCU 5.x needs.
func (l *dellLane) Prerequisite(name string) (PrerequisiteHandler, bool) {
	if name != dotnetDesktopRuntime {
		return PrerequisiteHandler{}, false
	}
	allow, ok := prerequisiteAllowlist(LaneDell, name)
	if !ok {
		return PrerequisiteHandler{}, false
	}
	return PrerequisiteHandler{
		Allow: allow,
		Installed: func() string {
			best := ""
			for _, v := range l.host.dotnetDesktopVersions() {
				if _, err := parseVersion(v); err != nil {
					continue
				}
				if best == "" || versionAtLeast(v, best) {
					best = v
				}
			}
			return best
		},
		InstallArgs: func(installer, logPath string) []string {
			return []string{"/install", "/quiet", "/norestart", "/log", logPath}
		},
	}, true
}
