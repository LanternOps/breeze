package oemupdates

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// Dell Command Update lane (spec §5). The flags, output formats and installer
// behaviour here were checked against dcu-cli.exe 5.7.2.42 in the Dell lab wave
// (W10, OptiPlex 7060); see testdata/dell/README.md. The exit table is still
// Dell's documented one except where that capture confirmed a code.
//
// DCU refuses any -outputLog, -report or -exportSettings path under
// ProgramData, Program Files or Windows (exit 107, "reserved folder"), which is
// where every agent-owned directory lives. So the lane writes nothing: it reads
// the tool's stdout, bounded, as untrusted text. It never runs /configure, so
// the tool's own schedule and settings are never changed (#12267). The schedule
// mode is only read, from the registry (dell_schedule.go).

const dotnetDesktopRuntime = "dotnet_desktop_runtime"

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

// dellBlockedIDPattern rejects a blocked id that is not a Dell release id.
var dellBlockedIDPattern = sync.OnceValue(func() *regexp.Regexp { return regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`) })

// dellScanLine reads one /scan result line (captured, W10):
// "<ID>: <title> - <Type> -- <Urgency> -- <code>".
var dellScanLine = sync.OnceValue(func() *regexp.Regexp {
	return regexp.MustCompile(`(?i)^([A-Z0-9]{5}):\s+(.+)\s+-\s+(bios|firmware|driver|application)\s+--\s+[^-]*--\s*\S*\s*$`)
})

// dellSelectedLine reads one /applyUpdates selection line (captured, W10):
// "[<n>] <ID>, <title>, <version>". The title may itself hold commas; the
// version is the last field.
var dellSelectedLine = sync.OnceValue(func() *regexp.Regexp {
	return regexp.MustCompile(`^\[\d+\]\s+([A-Za-z0-9]{5}),\s+(.+),\s+([^,]+?)\s*$`)
})

// dellSummaryLine is /applyUpdates' result (captured, W10):
// "<n> of <m> update(s) successfully installed.".
var dellSummaryLine = sync.OnceValue(func() *regexp.Regexp {
	return regexp.MustCompile(`^(\d+) of (\d+) update\(s\) successfully installed\.?\s*$`)
})

// dellHost is how the lane looks at the machine. Every reader is a stat or a
// file read: the availability gate must not spawn a process.
type dellHost struct {
	programFiles          func() []string
	exists                func(path string) bool
	fileVersion           func(path string) (string, error)
	dotnetDesktopVersions func() []string
	// registry reads the tool's schedule mode (dell_schedule.go). Nil refuses.
	registry regReader
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

// toolPath finds dcu-cli.exe under both Program Files directories, 64-bit
// first, by file stat alone: it never opens or starts the tool.
func (l *dellLane) toolPath() (string, bool) {
	for _, base := range l.host.programFiles() {
		if base == "" {
			continue
		}
		path := strings.TrimRight(base, `\`) + `\Dell\CommandUpdate\dcu-cli.exe`
		if l.host.exists(path) {
			return path, true
		}
	}
	return "", false
}

// detect reports the tool found by toolPath with its PE version, read from the
// file's version resource without running it. An unreadable version is
// reported as "", which is never in range.
func (l *dellLane) detect() ToolState {
	path, ok := l.toolPath()
	if !ok {
		return ToolState{}
	}
	version, err := l.host.fileVersion(path)
	if err != nil {
		log.Debug("dcu-cli.exe version unreadable", "path", path, "error", err.Error())
		version = ""
	}
	return ToolState{Present: true, Path: path, Version: version}
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
		if !dellBlockedIDPattern().MatchString(id) {
			return FilterPlan{}, runErr("invalid_blocked_id", fmt.Errorf("blocked id %q is not a Dell release id", id))
		}
	}
	if len(blocked) > 0 {
		// W10: -localblockedswb is a /configure option, so /applyUpdates cannot
		// take it, and blocking one release id made DCU offer another package
		// for the same component. Refuse rather than install what was blocked.
		return FilterPlan{}, runErr("blocked_ids_unsupported", fmt.Errorf("dell lane cannot honour %d blocked update id(s)", len(blocked)))
	}
	return FilterPlan{Categories: ordered}, nil
}

func (l *dellLane) updateTypeArg(plan FilterPlan) string {
	types := make([]string, 0, len(plan.Categories))
	for _, t := range dellUpdateTypes {
		for _, c := range plan.Categories {
			if c == t.category {
				types = append(types, t.flag)
			}
		}
	}
	return "-updateType=" + strings.Join(types, ",")
}

// argv is the /applyUpdates invocation. Reboot is always disabled: Breeze owns
// the reboot. BitLocker suspension is Dell's own, per its documentation. No
// -silent (it hides the stdout the lane reads) and no path (see the top).
func (l *dellLane) argv(plan FilterPlan) []string {
	return []string{"/applyUpdates", "-reboot=disable", "-autoSuspendBitLocker=enable", l.updateTypeArg(plan)}
}

// scanArgv is a read-only /scan with the same filter. Its only use is to label
// each update's type, which /applyUpdates' output does not carry.
func (l *dellLane) scanArgv(plan FilterPlan) []string {
	return []string{"/scan", l.updateTypeArg(plan)}
}

func (l *dellLane) Apply(ctx context.Context, tool ToolState, plan FilterPlan, ex Exec) (RunResult, error) {
	res := RunResult{Lane: LaneDell, Takeover: TakeoverNotAttempted}
	major, err := versionMajor(tool.Version)
	table, ok := dellExitCodes[major]
	if err != nil || !ok {
		res.Outcome, res.ErrorCode = OutcomeFailed, strPtr("unknown_tool_major")
		return res, runErr("unknown_tool_major", fmt.Errorf("no exit table for dcu %q", tool.Version))
	}
	// The scan only labels items. Its failure costs the item list, never the run.
	var types map[string]string
	if scan, err := ex.Run(ctx, ExecSpec{Path: tool.Path, Args: l.scanArgv(plan)}); err != nil {
		if ctx.Err() != nil {
			return res, err
		}
	} else if scan.ExitCode == 0 && !scan.StdoutTruncated {
		types = parseDellScan(scan.Stdout)
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

	items, ok := parseDellApply(out.Stdout, types)
	if out.StdoutTruncated || !ok {
		if res.ErrorCode == nil && outcome != OutcomeNoUpdates {
			res.ErrorCode = strPtr("report_unavailable")
		}
		items = nil
	}
	res.Items = items
	return res, nil
}

// dellLines splits bounded tool output into trimmed lines.
func dellLines(out []byte) []string {
	var lines []string
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for sc.Scan() {
		lines = append(lines, strings.TrimRight(sc.Text(), "\r "))
	}
	return lines
}

// parseDellScan maps release id to category from /scan output. Types outside
// the four categories (Utility, Other) are left out.
func parseDellScan(out []byte) map[string]string {
	types := map[string]string{}
	for _, line := range dellLines(out) {
		if m := dellScanLine().FindStringSubmatch(line); m != nil {
			types[strings.ToUpper(m[1])] = strings.ToLower(m[3])
		}
	}
	return types
}

// parseDellApply reads /applyUpdates output. Items are claimed only when the
// whole run is accounted for: every selected update has a type from the scan,
// and the summary says all of them installed. Otherwise ok is false and the
// caller reports report_unavailable. Output with no selection (no updates) is
// ok with no items. Every byte is untrusted.
func parseDellApply(out []byte, types map[string]string) (items []Item, ok bool) {
	type selected struct{ id, title, version string }
	var sel []selected
	installed, total := -1, -1
	for _, line := range dellLines(out) {
		if m := dellSelectedLine().FindStringSubmatch(line); m != nil {
			sel = append(sel, selected{strings.ToUpper(m[1]), m[2], m[3]})
			continue
		}
		if m := dellSummaryLine().FindStringSubmatch(line); m != nil {
			installed, _ = strconv.Atoi(m[1])
			total, _ = strconv.Atoi(m[2])
		}
	}
	if len(sel) == 0 {
		return nil, total <= 0
	}
	if total != len(sel) || installed != total {
		return nil, false
	}
	items = make([]Item, 0, min(len(sel), maxItems))
	for _, s := range sel {
		category, known := types[s.id]
		if !known {
			return nil, false
		}
		if len(items) < maxItems {
			items = append(items, Item{
				Title:    sanitizeToolText(s.title, maxItemTitle),
				Category: category,
				Version:  sanitizeToolText(s.version, maxVersionLen),
				Result:   ItemInstalled,
			})
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
