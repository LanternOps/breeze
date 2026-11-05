package oemupdates

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/securefs"
)

// HP Image Assistant lane (spec §5). Everything here that names an HPIA switch,
// exit code, report element or installer switch comes from HP's documents and is
// unconfirmed until the HP lab wave (W14); see testdata/hp/README.md. Every HP gate
// stays closed until then.

const (
	hpToolDirName    = "hp-image-assistant"
	hpToolExe        = "HPImageAssistant.exe"
	hpReportDir      = "hp-report"
	hpSoftPaqDir     = "hp-softpaqs"
	hpSPListName     = "hp-splist.txt"
	hpRebootOwedFile = "hp-reboot-owed.json"
	maxHpReportBytes = 16 << 20
	maxHpTextBytes   = 4 << 10
)

// hpRange is the compiled supported range: the CVE-2025-13492 floor, and the 5.x
// major the exit table below is written for. A payload can only narrow it.
var hpRange = VersionRange{Min: "5.3.3", MaxExclusive: "6.0.0"}

// hpExitCodes is HPIA's table. 3011 (non-SSM SoftPaqs) takes precedence over 3010
// and 3020 (HP's release notes), so it can hide either. /IgnoreGenericOsError keeps
// 4104 from hiding them the same way. Anything unmapped is a failure.
var hpExitCodes = map[int64]Outcome{
	0:    OutcomeSuccess,
	256:  OutcomeNoUpdates, // the analysis returned no recommendations
	257:  OutcomeNoUpdates, // no recommendations selected
	3010: OutcomeSuccessRebootRequired,
	3011: OutcomePartial,
	3020: OutcomeFailed,
	4096: OutcomeNotSupported,
}

// hpCategories maps the policy categories HPIA handles to /Category values, in a
// fixed order so the argument is stable. BIOS is not here: HP's guide for HPIA does
// not mention BitLocker, so BIOS goes only through CMSL (Decision 7).
var hpCategories = []struct{ category, flag string }{
	{CategoryFirmware, "Firmware"},
	{CategoryDriver, "Drivers"},
	{CategoryApplication, "Software"},
}

// hpCategoryOrder fixes the plan's order so Filter stays stable.
var hpCategoryOrder = []string{CategoryBIOS, CategoryFirmware, CategoryDriver, CategoryApplication}

// hpReportSections reads the report's recommendation groups. An unknown group is
// ignored, so nothing in it can reach the list HPIA is told to install.
var hpReportSections = map[string]string{
	"bios":     CategoryBIOS,
	"firmware": CategoryFirmware,
	"drivers":  CategoryDriver,
	"software": CategoryApplication,
}

var (
	// hpMaker is the API's rule (applicability.ts), checked again here on the whole
	// trimmed string: HPE is not HP, and a near-miss must not authorize a flash.
	hpMaker = regexp.MustCompile(`(?i)^(?:hp(?: inc\.?)?|hewlett-packard)$`)
	// hpSoftPaqID is a SoftPaq number, with or without its sp prefix.
	hpSoftPaqID = regexp.MustCompile(`(?i)^(?:sp)?([0-9]{1,9})$`)
)

func isHPIdentity(maker string) bool { return hpMaker.MatchString(strings.TrimSpace(maker)) }

// hpSoftPaqNumber returns the bare number of a SoftPaq id, or "" if it is not one.
func hpSoftPaqNumber(id string) string {
	m := hpSoftPaqID.FindStringSubmatch(strings.TrimSpace(id))
	if m == nil {
		return ""
	}
	return m[1]
}

// hpHost is how the lane looks at the machine. identity, exists and fileVersion
// answer without a process, because the availability gate must not spawn one.
type hpHost struct {
	identity func() (maker, model string, err error)
	// toolDir is the agent-owned directory HPIA is extracted into. A copy of HPIA
	// anywhere else is ignored: nothing outside it is the agent's to run as SYSTEM.
	toolDir       func() (string, error)
	exists        func(path string) bool
	fileVersion   func(path string) (string, error)
	rebootPending func() (bool, error)
	bootTime      func() (time.Time, error)
	now           func() time.Time
	store         Store

	// The BIOS path (lane_hp_bios.go). programFiles, dirExists and listDir answer
	// without a process. verifier checks CMSL's signature, fresh, before each flash.
	programFiles func() string
	dirExists    func(path string) bool
	listDir      func(path string) []string
	verifier     Verifier
	powershell   func() string
}

type hpLane struct {
	host  hpHost
	gate  *ToolGate
	cmsl  *ToolGate
	allow LaneAllowlist
}

var _ HardwareCheckedLane = (*hpLane)(nil)

func newHPLane(host hpHost) *hpLane {
	l := &hpLane{host: host}
	l.allow, _ = laneAllowlist(LaneHP)
	l.gate = NewToolGate("hp-image-assistant", l.detect)
	l.cmsl = NewToolGate("hp-cmsl", l.detectCMSL)
	return l
}

func (l *hpLane) ID() string                   { return LaneHP }
func (l *hpLane) Gate() *ToolGate              { return l.gate }
func (l *hpLane) Allow() LaneAllowlist         { return l.allow }
func (l *hpLane) Range() VersionRange          { return hpRange }
func (l *hpLane) SkippedForNoReboot() []string { return []string{CategoryBIOS, CategoryFirmware} }

// ToolVersion re-reads HPImageAssistant.exe's PE version.
func (l *hpLane) ToolVersion(path string) (string, error) { return l.host.fileVersion(path) }

// FlashesOutsideFilter is true until W14 shows HPIA keeps to its categories: a
// SoftPaq filed as a driver could write firmware, so every run holds the flash
// guard and a reboot waits for it.
func (l *hpLane) FlashesOutsideFilter() bool { return true }

// Prerequisite knows no name: HPIA needs none, and a payload cannot make the agent
// install anything else on this lane. CMSL in particular is never installed here.
func (l *hpLane) Prerequisite(string) (PrerequisiteHandler, bool) {
	return PrerequisiteHandler{}, false
}

// CheckHardware refuses a machine that is not HP's before anything is fetched or
// run. A failed read must not read as "not HP": not_supported is sticky at the API.
func (l *hpLane) CheckHardware() (Outcome, error) {
	maker, _, err := l.host.identity()
	if err != nil {
		return OutcomeToolUnavailable, runErr("smbios_unreadable", err)
	}
	if !isHPIdentity(maker) {
		return OutcomeNotSupported, runErr("not_hp", errors.New("this machine is not an HP"))
	}
	return "", nil
}

// detect looks only in the agent-owned directory. An unreadable version is
// reported as "", which is never in range.
func (l *hpLane) detect() ToolState {
	dir, err := l.host.toolDir()
	if err != nil {
		log.Debug("HP tool directory unavailable", "error", err.Error())
		return ToolState{}
	}
	path := filepath.Join(dir, hpToolExe)
	if !l.host.exists(path) {
		return ToolState{}
	}
	version, err := l.host.fileVersion(path)
	if err != nil {
		log.Debug("HPImageAssistant.exe version unreadable", "path", path, "error", err.Error())
		version = ""
	}
	return ToolState{Present: true, Path: path, Version: version}
}

// regularFileNoLink is the production exists: a link in the tool directory is not
// the file the signature check would be reading a moment later.
func regularFileNoLink(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode().IsRegular()
}

// InstallArgs extracts the HPIA SoftPaq into the agent-owned directory. Without a
// path it would use its own default location, which standard users can reach, so
// when the directory cannot be had it extracts beside the installer, also
// agent-owned: the re-detect then finds nothing and reports install_incomplete.
func (l *hpLane) InstallArgs(installer, logPath string) []string {
	dir, err := l.host.toolDir()
	if err != nil {
		log.Warn("HP tool directory unavailable; the install will not be found", "error", err.Error())
		dir = filepath.Dir(installer)
	}
	return []string{"/s", "/e", "/f", dir}
}

// Filter keeps every requested category and leaves the reading of them to Apply,
// which reports what it skips. Blocked ids are only ever compared, never passed on,
// so any string is safe and another vendor's id does no harm.
func (l *hpLane) Filter(cats []string, blocked []string) (FilterPlan, error) {
	want := map[string]bool{}
	for _, c := range cats {
		if !IsCategory(c) {
			return FilterPlan{}, runErr("invalid_filter", fmt.Errorf("unknown category %q", c))
		}
		want[c] = true
	}
	var ordered []string
	for _, c := range hpCategoryOrder {
		if want[c] {
			ordered = append(ordered, c)
		}
	}
	return FilterPlan{Categories: ordered, BlockedIDs: append([]string(nil), blocked...)}, nil
}

func hpCategoryFlags(plan FilterPlan) []string {
	var flags []string
	for _, t := range hpCategories {
		if contains(plan.Categories, t.category) {
			flags = append(flags, t.flag)
		}
	}
	return flags
}

// argv is the install invocation. HPIA has no reboot switch: Breeze acts on the
// exit code and owns the reboot.
func (l *hpLane) argv(plan FilterPlan) []string {
	return []string{
		"/Operation:Analyze",
		"/Action:Install",
		"/Category:" + strings.Join(hpCategoryFlags(plan), ","),
		"/Selection:All",
		"/Silent",
		"/ReportFolder:" + filepath.Join(plan.WorkDir, hpReportDir),
		"/SoftPaqDownloadFolder:" + filepath.Join(plan.WorkDir, hpSoftPaqDir),
		"/AutoCleanup",
		"/IgnoreGenericOsError",
	}
}

// analyzeArgv lists recommendations and installs nothing.
func (l *hpLane) analyzeArgv(plan FilterPlan) []string {
	return []string{
		"/Operation:Analyze",
		"/Action:List",
		"/Category:" + strings.Join(hpCategoryFlags(plan), ","),
		"/Selection:All",
		"/Silent",
		"/ReportFolder:" + filepath.Join(plan.WorkDir, hpReportDir),
		"/IgnoreGenericOsError",
	}
}

func (l *hpLane) Apply(ctx context.Context, tool ToolState, plan FilterPlan, ex Exec) (RunResult, error) {
	res := RunResult{Lane: LaneHP, Takeover: TakeoverNotAttempted}

	// W03 relies on this: a clean result means an earlier flash's reboot happened.
	owed, err := l.rebootOwed()
	if err != nil {
		res.Outcome, res.ErrorCode = OutcomeBlockedRebootPending, strPtr("reboot_state_unreadable")
		return res, runErr("reboot_state_unreadable", err)
	}
	if owed {
		res.Outcome, res.RebootRequired = OutcomeBlockedRebootPending, true
		return res, nil
	}

	// BIOS first: the runner read power and the recovery key immediately before this
	// call. HPIA can take an hour, and this lane cannot read the key again. The volume
	// stays suspended a little longer for it, and a reboot follows either way.
	var bios hpBiosStep
	if contains(plan.Categories, CategoryBIOS) {
		bios = l.runBIOS(ctx, plan, ex)
	}
	if len(hpCategoryFlags(plan)) == 0 {
		return hpBiosOnly(res, bios), nil
	}

	// An error comes with its outcome set, except from the analysis, which only runs
	// with an id blocked, when BIOS never does. The runner keeps what is merged here.
	res, err = l.runHPIA(ctx, tool, plan, ex)
	if bios.state != hpBiosNotAsked {
		res = hpMergeBios(res, bios)
	}
	if res.RebootRequired && !bios.flashMayHaveStarted() {
		l.noteRebootOwed()
	}
	return res, err
}

// runHPIA is one install. With any id blocked it is two steps, because /Category is
// HPIA's only other filter: list what is recommended, then install that list minus
// the blocked ids. Without a readable list nothing is installed.
func (l *hpLane) runHPIA(ctx context.Context, tool ToolState, plan FilterPlan, ex Exec) (RunResult, error) {
	res := RunResult{Lane: LaneHP, Takeover: TakeoverNotAttempted}
	reportDir := filepath.Join(plan.WorkDir, hpReportDir)
	// A stale report would be read as this run's items, or worse, as this run's list.
	if err := resetPrivateDir(reportDir); err != nil {
		res.Outcome, res.ErrorCode = OutcomeFailed, strPtr("stale_report")
		return res, runErr("stale_report", err)
	}
	if err := resetPrivateDir(filepath.Join(plan.WorkDir, hpSoftPaqDir)); err != nil {
		res.Outcome, res.ErrorCode = OutcomeFailed, strPtr("softpaq_dir_unavailable")
		return res, runErr("softpaq_dir_unavailable", err)
	}

	args := l.argv(plan)
	blocked := hpBlockedSet(plan.BlockedIDs)
	if len(plan.BlockedIDs) > 0 {
		out, err := ex.Run(ctx, ExecSpec{Path: tool.Path, Args: l.analyzeArgv(plan)})
		if err != nil {
			return res, err
		}
		res.RawExitCode = int64Ptr(out.ExitCode)
		switch out.ExitCode {
		case 0:
		case 256, 257:
			res.Outcome = OutcomeNoUpdates
			return res, nil
		case 4096:
			res.Outcome = OutcomeNotSupported
			return res, nil
		default:
			res.Outcome, res.ErrorCode = OutcomeFailed, strPtr("analyze_failed")
			return res, nil
		}
		recs, ok := readHpReport(reportDir)
		if !ok {
			res.Outcome, res.ErrorCode = OutcomeFailed, strPtr("report_unavailable")
			return res, nil
		}
		numbers, skipped := hpSelectUpdates(recs, plan, blocked)
		res.Items = skipped
		if len(numbers) == 0 {
			res.Outcome = OutcomeNoUpdates
			return res, nil
		}
		listPath := filepath.Join(plan.WorkDir, hpSPListName)
		if err := os.WriteFile(listPath, []byte(strings.Join(numbers, "\n")+"\n"), 0o600); err != nil {
			res.Outcome, res.ErrorCode = OutcomeFailed, strPtr("splist_unwritable")
			return res, runErr("splist_unwritable", err)
		}
		if err := resetPrivateDir(reportDir); err != nil {
			res.Outcome, res.ErrorCode = OutcomeFailed, strPtr("stale_report")
			return res, runErr("stale_report", err)
		}
		args = append(args, "/SPList:"+listPath)
	}

	out, err := ex.Run(ctx, ExecSpec{Path: tool.Path, Args: args})
	if err != nil {
		// The install may have been under way, and FlashesOutsideFilter says that can
		// mean firmware. A needless overnight reboot costs far less than firmware
		// waiting on a reboot nobody knows about.
		log.Warn("HPIA install ended without an exit code", "error", err.Error())
		res.Outcome, res.ErrorCode, res.RebootRequired = OutcomeFailed, strPtr("tool_exec_failed"), true
		return res, nil
	}
	res.RawExitCode = int64Ptr(out.ExitCode)
	outcome, mapped := hpExitCodes[out.ExitCode]
	switch {
	case !mapped:
		outcome = OutcomeFailed
		res.ErrorCode = strPtr("unmapped_exit_code")
	case out.ExitCode == 3011:
		res.ErrorCode = strPtr("non_ssm_softpaqs")
	case out.ExitCode == 3020:
		res.ErrorCode = strPtr("install_failed")
	}
	res.Outcome = outcome
	// 3020 is "one or more failed", so others may have installed and want the reboot.
	res.RebootRequired = out.ExitCode == 3010 || out.ExitCode == 3011 || out.ExitCode == 3020
	if !mapped && contains(plan.Categories, CategoryFirmware) {
		// What this exit means is unknown, and a capsule may be staged.
		res.RebootRequired = true
		res.ErrorCode = strPtr("firmware_install_uncertain")
	}
	if outcome == OutcomeNoUpdates || outcome == OutcomeNotSupported {
		return res, nil
	}

	recs, ok := readHpReport(reportDir)
	if !ok {
		// The report format is unconfirmed: a report that cannot be read costs the
		// item list, never the run.
		log.Warn("HPIA report could not be read; no item list for this run")
		if res.ErrorCode == nil {
			res.ErrorCode = strPtr("report_unavailable")
		}
		if len(plan.BlockedIDs) > 0 && (outcome == OutcomeSuccess || outcome == OutcomeSuccessRebootRequired) {
			// Only the report could show that an install honoured /SPList.
			res.Outcome, res.ErrorCode = OutcomePartial, strPtr("blocked_updates_unconfirmed")
		}
		return res, nil
	}
	hpApplyReport(&res, recs, blocked)
	return res, nil
}

// hpSelectUpdates splits an analysis into the SoftPaq numbers to install and the
// items to report as skipped. The report is tool output: an id that is not a SoftPaq
// number, or an update outside the requested categories, never reaches the list.
func hpSelectUpdates(recs []hpRecommendation, plan FilterPlan, blocked map[string]bool) (numbers []string, skipped []Item) {
	seen := map[string]bool{}
	for _, rec := range recs {
		number := hpSoftPaqNumber(rec.id)
		switch {
		case !contains(plan.Categories, rec.category) || rec.category == CategoryBIOS:
			continue
		case number != "" && !blocked[number]:
			if !seen[number] {
				seen[number] = true
				numbers = append(numbers, number)
			}
		default:
			skipped = append(skipped, rec.item(ItemSkipped))
		}
	}
	return numbers, skipped
}

// hpApplyReport reads the report of an install run into the result. A report with no
// result for an update says nothing about it unless the whole run was clean.
func hpApplyReport(res *RunResult, recs []hpRecommendation, blocked map[string]bool) {
	clean := res.Outcome == OutcomeSuccess || res.Outcome == OutcomeSuccessRebootRequired
	downloadOnly := false
	for _, rec := range recs {
		isBlocked := blocked[hpSoftPaqNumber(rec.id)]
		switch rec.status {
		case hpStatusInstalled:
			if isBlocked {
				// HP's guide documents /SPList for downloads. If an install did not
				// honour it, the tech has to hear about it.
				res.ErrorCode = strPtr("blocked_update_installed")
				res.Outcome = OutcomePartial
				clean = false
			}
			res.Items = append(res.Items, rec.item(ItemInstalled))
		case hpStatusFailed:
			res.Items = append(res.Items, rec.item(ItemFailed))
		case hpStatusDownloaded:
			// HP Sure Admin (Enhanced BIOS Authentication Mode) limits what HPIA may
			// install. Downloaded is not installed, and must not read as installed.
			downloadOnly = true
			res.Items = append(res.Items, rec.item(ItemSkipped))
		default:
			if clean && !isBlocked {
				res.Items = append(res.Items, rec.item(ItemInstalled))
			}
		}
	}
	if downloadOnly && clean {
		res.Outcome = OutcomePartial
		res.ErrorCode = strPtr("sure_admin_download_only")
	}
}

func hpBlockedSet(ids []string) map[string]bool {
	out := map[string]bool{}
	ignored := 0
	for _, id := range ids {
		if n := hpSoftPaqNumber(id); n != "" {
			out[n] = true
		} else {
			ignored++
		}
	}
	if ignored > 0 {
		// Normal for another vendor's id. A mistyped HP id would block nothing, so it
		// is worth a line when a blocked update installs anyway.
		log.Info("blocked ids that are not HP SoftPaq numbers were ignored", "count", ignored)
	}
	return out
}

func resetPrivateDir(path string) error {
	if err := os.RemoveAll(path); err != nil {
		return err
	}
	return securefs.EnsurePrivateDir(path)
}

// hpRebootOwedRecord remembers a reboot this lane asked for. HPIA has no exit code
// for one already owed and the registry flag is not guaranteed after a firmware or
// BIOS update, while the API reads a clean result as that reboot having happened.
type hpRebootOwedRecord struct {
	At time.Time `json:"at"`
}

func (l *hpLane) now() time.Time {
	if l.host.now == nil {
		return time.Now()
	}
	return l.host.now()
}

// rebootOwed reports a reboot still to come. Anything it cannot read is an error,
// which the caller treats as owed. A corrupt record is removed so it refuses once
// rather than forever.
func (l *hpLane) rebootOwed() (bool, error) {
	pending, err := l.host.rebootPending()
	if err != nil {
		return false, err
	}
	if pending {
		return true, nil
	}
	data, err := l.host.store.ReadFile(hpRebootOwedFile)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var rec hpRebootOwedRecord
	if err := json.Unmarshal(data, &rec); err != nil || rec.At.IsZero() {
		if rerr := l.host.store.Remove(hpRebootOwedFile); rerr != nil {
			log.Warn("could not remove a corrupt HP reboot record", "error", rerr.Error())
		}
		return false, errors.New("HP reboot record is corrupt")
	}
	boot, err := l.host.bootTime()
	if err != nil {
		return false, err
	}
	if !boot.After(rec.At) {
		return true, nil
	}
	if err := l.host.store.Remove(hpRebootOwedFile); err != nil {
		log.Warn("could not remove a spent HP reboot record", "error", err.Error())
	}
	return false, nil
}

func (l *hpLane) writeRebootOwed() error {
	data, err := json.Marshal(hpRebootOwedRecord{At: l.now()})
	if err != nil {
		return err
	}
	return l.host.store.WriteFile(hpRebootOwedFile, data)
}

// noteRebootOwed records a reboot a finished run asked for. The result still says
// so if this fails: only the next run's answer is at stake.
func (l *hpLane) noteRebootOwed() {
	if err := l.writeRebootOwed(); err != nil {
		log.Warn("could not record the reboot an HP run needs", "error", err.Error())
	}
}

type hpStatus int

const (
	hpStatusUnknown hpStatus = iota
	hpStatusInstalled
	hpStatusFailed
	hpStatusDownloaded
)

// hpRecommendation is one update in HPIA's report. Every text field is untrusted.
type hpRecommendation struct {
	category string
	id       string
	name     string
	version  string
	status   hpStatus
}

func (r hpRecommendation) item(result string) Item {
	return Item{
		Title:    sanitizeToolText(r.name, maxItemTitle),
		Category: r.category,
		Version:  sanitizeToolText(r.version, maxVersionLen),
		Result:   result,
	}
}

func hpStatusOf(s string) hpStatus {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "installed", "success":
		return hpStatusInstalled
	case "failed", "error":
		return hpStatusFailed
	case "downloaded", "download only", "downloadonly":
		return hpStatusDownloaded
	}
	return hpStatusUnknown
}

// readHpReport reads the XML report HPIA writes to /ReportFolder; HP does not
// document its file name. ok is false when no report can be read.
func readHpReport(dir string) (recs []hpRecommendation, ok bool) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, false
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.Type().IsRegular() && strings.EqualFold(filepath.Ext(e.Name()), ".xml") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for _, name := range names {
		f, err := os.Open(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		data, err := io.ReadAll(io.LimitReader(f, maxHpReportBytes+1))
		_ = f.Close()
		if err != nil || len(data) > maxHpReportBytes {
			continue
		}
		if recs, ok := parseHpReport(data); ok {
			return recs, true
		}
	}
	return nil, false
}

// parseHpReport walks HPIA/Recommendations/<group>/Recommendation/Solution/Softpaq.
// It is bounded and treats every byte as untrusted: a DTD is refused, and an
// undefined entity is a syntax error. HP does not publish this schema, so element
// names match in any case. ok is false on anything but a whole HPIA document.
func parseHpReport(data []byte) (recs []hpRecommendation, ok bool) {
	dec := xml.NewDecoder(bytes.NewReader(data))
	var stack []string
	var cur *hpRecommendation
	var text strings.Builder
	sawRoot := false
	for {
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) {
			return recs, sawRoot && len(stack) == 0
		}
		if err != nil {
			return nil, false
		}
		switch t := tok.(type) {
		case xml.Directive:
			return nil, false
		case xml.StartElement:
			name := strings.ToLower(t.Name.Local)
			if len(stack) == 0 {
				if name != "hpia" || sawRoot {
					return nil, false
				}
				sawRoot = true
			}
			stack = append(stack, name)
			text.Reset()
			n := len(stack)
			if cur == nil && name == "recommendation" && n >= 3 && stack[n-3] == "recommendations" {
				if category, known := hpReportSections[stack[n-2]]; known {
					cur = &hpRecommendation{category: category}
				}
			}
		case xml.CharData:
			if cur != nil && text.Len()+len(t) <= maxHpTextBytes {
				text.Write(t)
			}
		case xml.EndElement:
			n := len(stack)
			name := stack[n-1]
			if cur != nil && n >= 2 {
				value := strings.TrimSpace(text.String())
				switch {
				case name == "id" && stack[n-2] == "softpaq":
					cur.id = value
				case name == "name" && stack[n-2] == "softpaq":
					cur.name = value
				case name == "version" && stack[n-2] == "softpaq":
					cur.version = value
				case name == "status":
					cur.status = hpStatusOf(value)
				case name == "recommendation":
					if len(recs) < maxItems {
						recs = append(recs, *cur)
					}
					cur = nil
				}
			}
			stack = stack[:n-1]
			text.Reset()
		}
	}
}
