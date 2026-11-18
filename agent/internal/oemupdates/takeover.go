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
	"sort"
	"strings"
)

// Taking over and handing back a vendor tool's own update schedule (spec §4.2).
//
// Only a scheduled run takes over: before it, the agent saves the tool's
// settings, then turns the tool's own schedule and notifications off so the
// tool and Breeze do not both run, and re-asserts that on later runs. A
// release (oem_update_release) hands it back. Like winupdate.go, Breeze records
// what it owns and reverts only that: a setting someone else changed after
// Breeze, or one Breeze never touched, is left alone.
//
// What Breeze owns is learned, not assumed. The tool's settings export is read
// before and after the change, and the settings that differ are the ones the
// change made. Policy-controlled settings can make the change a no-op (vendor
// documentation), which the read-back shows as no difference: policy_locked.
//
// The settings file format is doc-derived (testdata/dell/README.md). The parser
// below assumes only nested elements carrying a Name attribute, with the leaf
// elements as the settings, and fails closed on anything it cannot read.

// LaneTakeover is the optional part of a lane whose vendor tool has its own
// schedule. Exec must verify the binary before every process it starts
// (VerifiedExec); the lane finds its own tool.
type LaneTakeover interface {
	// Takeover returns a contract takeover value (TakeoverOK,
	// TakeoverPolicyLocked, TakeoverNotAttempted). An error explains a value
	// other than ok and never fails the run.
	Takeover(ctx context.Context, ex Exec, st Store) (string, error)
	// Restore reverts what Breeze changed and ends its ownership. It returns
	// ErrNothingToRestore when there was nothing of Breeze's left to revert.
	Restore(ctx context.Context, ex Exec, st Store) error
}

// ErrNothingToRestore: no takeover recorded, or nothing recorded is Breeze's
// any more. A release that gets it has done its job.
var ErrNothingToRestore = errors.New("no vendor schedule takeover to restore")

const (
	takeoverExportDir     = "takeover-export"
	takeoverImportDir     = "takeover-import"
	takeoverImportName    = "restore.xml"
	takeoverRecordVersion = 1

	maxSettingsBytes = 1 << 20
	maxSettingsDepth = 16
	maxSettingsProps = 2000
)

func takeoverRecordName(lane string) string { return lane + "-takeover.json" }

// ownedSetting is one setting Breeze changed.
type ownedSetting struct {
	// BeforeRaw is the setting's element as it was before Breeze changed it,
	// when BeforePresent.
	BeforeRaw     string `json:"beforeRaw,omitempty"`
	BeforePresent bool   `json:"beforePresent"`
	// Ours is the normalized element Breeze left. A setting that no longer
	// reads as Ours is someone else's now.
	Ours        string `json:"ours,omitempty"`
	OursPresent bool   `json:"oursPresent"`
}

// takeoverRecord is the ownership record, written before the tool's settings
// are changed. Absent means Breeze owns nothing.
type takeoverRecord struct {
	Version int                     `json:"version"`
	Lane    string                  `json:"lane"`
	Changed map[string]ownedSetting `json:"changed"`
	// PendingBefore is the whole export taken just before a change whose result
	// has not been read back (a crash, or an unreadable read-back). Whatever
	// differs between it and the next export is treated as Breeze's: the safe
	// side, since that is the only way a restore can still find it.
	PendingBefore string `json:"pendingBefore,omitempty"`
}

func loadTakeoverRecord(st Store, lane string) (takeoverRecord, bool, error) {
	data, err := st.ReadFile(takeoverRecordName(lane))
	if errors.Is(err, fs.ErrNotExist) {
		return takeoverRecord{}, false, nil
	}
	if err != nil {
		return takeoverRecord{}, false, runErr("takeover_record_unreadable", err)
	}
	var rec takeoverRecord
	if err := json.Unmarshal(data, &rec); err != nil {
		return takeoverRecord{}, false, runErr("takeover_record_unreadable", err)
	}
	if rec.Version != takeoverRecordVersion || rec.Lane != lane {
		return takeoverRecord{}, false, runErr("takeover_record_unreadable",
			fmt.Errorf("record version %d for lane %q", rec.Version, rec.Lane))
	}
	if rec.Changed == nil {
		rec.Changed = map[string]ownedSetting{}
	}
	return rec, true, nil
}

// saveTakeoverRecord writes the record, or removes it when Breeze owns nothing.
func saveTakeoverRecord(st Store, rec takeoverRecord) error {
	if len(rec.Changed) == 0 && rec.PendingBefore == "" {
		return st.Remove(takeoverRecordName(rec.Lane))
	}
	data, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	return st.WriteFile(takeoverRecordName(rec.Lane), data)
}

// settingProp is one leaf setting of an export: its element bytes and where
// they sit in the file.
type settingProp struct {
	raw        string
	norm       string
	start, end int
}

type dellSettings struct {
	data  []byte
	props map[string]settingProp
}

// parseDellSettings reads an export. Every byte is untrusted: the depth, the
// number of settings and the size are bounded, a duplicate setting path is
// refused (it would make "which one did we change" ambiguous), and a file with
// no settings at all is not a snapshot.
func parseDellSettings(data []byte) (dellSettings, error) {
	if len(data) > maxSettingsBytes {
		return dellSettings{}, fmt.Errorf("settings export is larger than %d bytes", maxSettingsBytes)
	}
	type frame struct {
		name       string
		start      int
		namedChild bool
	}
	out := dellSettings{data: data, props: map[string]settingProp{}}
	dec := xml.NewDecoder(bytes.NewReader(data))
	dec.Strict = true
	var stack []frame
	for {
		offset := int(dec.InputOffset())
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return dellSettings{}, fmt.Errorf("settings export: %w", err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			if len(stack) >= maxSettingsDepth {
				return dellSettings{}, errors.New("settings export nests too deeply")
			}
			name := ""
			for _, a := range t.Attr {
				if a.Name.Local == "Name" && a.Name.Space == "" {
					name = a.Value
				}
			}
			if name != "" && len(stack) > 0 {
				stack[len(stack)-1].namedChild = true
			}
			stack = append(stack, frame{name: name, start: offset})
		case xml.EndElement:
			if len(stack) == 0 {
				return dellSettings{}, errors.New("settings export: unbalanced element")
			}
			f := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if f.name == "" || f.namedChild || volatileSetting(f.name) {
				continue
			}
			var parts []string
			for _, p := range stack {
				if p.name != "" {
					parts = append(parts, p.name)
				}
			}
			path := strings.Join(append(parts, f.name), "/")
			if _, dup := out.props[path]; dup {
				return dellSettings{}, fmt.Errorf("settings export repeats %q", path)
			}
			if len(out.props) >= maxSettingsProps {
				return dellSettings{}, errors.New("settings export has too many settings")
			}
			end := int(dec.InputOffset())
			raw := string(data[f.start:end])
			out.props[path] = settingProp{raw: raw, norm: normalizeSetting(raw), start: f.start, end: end}
		}
	}
	if len(stack) != 0 {
		return dellSettings{}, errors.New("settings export is truncated")
	}
	if len(out.props) == 0 {
		return dellSettings{}, errors.New("settings export has no settings")
	}
	return out, nil
}

// volatileSetting names the timestamps the tool rewrites on every save. They
// are never a change Breeze made.
func volatileSetting(name string) bool {
	n := strings.ToLower(name)
	return strings.HasSuffix(n, "modifiedtime") || strings.HasSuffix(n, "timesaved")
}

func normalizeSetting(raw string) string { return strings.Join(strings.Fields(raw), " ") }

// changedPaths are the settings that differ between two exports, sorted.
func changedPaths(a, b dellSettings) []string {
	seen := map[string]bool{}
	var out []string
	for p, pa := range a.props {
		seen[p] = true
		if pb, ok := b.props[p]; !ok || pb.norm != pa.norm {
			out = append(out, p)
		}
	}
	for p := range b.props {
		if !seen[p] {
			out = append(out, p)
		}
	}
	sort.Strings(out)
	return out
}

// recordChanges adds what changed between before and after to the record. A
// setting already owned keeps its original value while before still reads as
// Breeze's; otherwise someone changed it in between, and before is what this
// change replaced.
func recordChanges(rec *takeoverRecord, before, after dellSettings) {
	for _, p := range changedPaths(before, after) {
		b, bok := before.props[p]
		a, aok := after.props[p]
		o, tracked := rec.Changed[p]
		if !tracked || !readsAs(before, p, o) {
			o.BeforeRaw, o.BeforePresent = "", bok
			if bok {
				o.BeforeRaw = b.raw
			}
		}
		o.Ours, o.OursPresent = "", aok
		if aok {
			o.Ours = a.norm
		}
		if o.BeforePresent == o.OursPresent && (!o.BeforePresent || normalizeSetting(o.BeforeRaw) == o.Ours) {
			delete(rec.Changed, p) // changed and changed back
			continue
		}
		rec.Changed[p] = o
	}
}

// readsAs reports whether setting p in s is still the value Breeze left.
func readsAs(s dellSettings, p string, o ownedSetting) bool {
	cur, ok := s.props[p]
	if ok != o.OursPresent {
		return false
	}
	return !ok || cur.norm == o.Ours
}

// reconcilePending turns an unconfirmed change into owned settings, against
// the export now in hand.
func reconcilePending(rec *takeoverRecord, now dellSettings) error {
	if rec.PendingBefore == "" {
		return nil
	}
	pending, err := parseDellSettings([]byte(rec.PendingBefore))
	if err != nil {
		return runErr("takeover_record_unreadable", err)
	}
	recordChanges(rec, pending, now)
	rec.PendingBefore = ""
	return nil
}

// VerifiedExec checks the publisher of every binary immediately before it
// starts, never from a cache (Trust boundary). A takeover or restore runs the
// tool several times, so one check up front is not enough.
func VerifiedExec(inner Exec, v Verifier, allow LaneAllowlist) Exec {
	return verifiedExec{inner: inner, verifier: v, allow: allow}
}

type verifiedExec struct {
	inner    Exec
	verifier Verifier
	allow    LaneAllowlist
}

func (e verifiedExec) Run(ctx context.Context, spec ExecSpec) (ExecResult, error) {
	if err := verifyPublisher(e.verifier, spec.Path, e.allow); err != nil {
		return ExecResult{}, err
	}
	return e.inner.Run(ctx, spec)
}

// Dell: dcu-cli /configure, per Dell's CLI documentation.

var dellConfigureArgs = []string{"/configure", "-scheduleManual", "-updatesNotification=disable"}

// takeoverTool finds dcu-cli.exe fresh and checks it is in range: the exit
// and switch semantics below are the 5.x guide's.
func (l *dellLane) takeoverTool() (string, error) {
	st := l.detect()
	if !st.Present {
		return "", runErr("tool_absent", errors.New("dcu-cli.exe not found"))
	}
	if dellRange.position(st.Version) != inRange {
		return "", runErr("tool_out_of_range", fmt.Errorf("dcu-cli.exe %q is outside [%s, %s)", st.Version, dellRange.Min, dellRange.MaxExclusive))
	}
	return st.Path, nil
}

// exportSettings has the tool write its settings into an agent-owned directory
// and reads the one file it wrote.
func (l *dellLane) exportSettings(ctx context.Context, ex Exec, tool string, st Store) (dellSettings, error) {
	dir, err := st.Dir(takeoverExportDir)
	if err != nil {
		return dellSettings{}, runErr("store_unavailable", err)
	}
	if err := emptyDir(dir); err != nil {
		return dellSettings{}, runErr("store_unavailable", err)
	}
	res, err := ex.Run(ctx, ExecSpec{Path: tool, Args: []string{"/configure", "-exportSettings=" + dir}})
	if err != nil {
		return dellSettings{}, runErr("settings_export_failed", err)
	}
	if res.ExitCode != 0 {
		return dellSettings{}, runErr("settings_export_failed", fmt.Errorf("dcu-cli exit %d", res.ExitCode))
	}
	data, err := readOnlyExport(dir)
	if err != nil {
		return dellSettings{}, runErr("settings_export_failed", err)
	}
	s, err := parseDellSettings(data)
	if err != nil {
		return dellSettings{}, runErr("settings_export_unreadable", err)
	}
	return s, nil
}

func emptyDir(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if err := os.RemoveAll(filepath.Join(dir, e.Name())); err != nil {
			return err
		}
	}
	return nil
}

// readOnlyExport reads the single regular .xml file in dir, bounded. A link,
// a second file or none at all is refused.
func readOnlyExport(dir string) ([]byte, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var name string
	for _, e := range entries {
		if !strings.EqualFold(filepath.Ext(e.Name()), ".xml") {
			continue
		}
		if name != "" {
			return nil, errors.New("settings export wrote more than one file")
		}
		name = e.Name()
	}
	if name == "" {
		return nil, errors.New("settings export wrote no file")
	}
	path := filepath.Join(dir, name)
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("settings export is not a regular file")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	data, err := io.ReadAll(io.LimitReader(f, maxSettingsBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxSettingsBytes {
		return nil, fmt.Errorf("settings export is larger than %d bytes", maxSettingsBytes)
	}
	return data, nil
}

// Takeover saves the settings, records ownership, turns the tool's schedule
// and notifications off, and reads the result back.
func (l *dellLane) Takeover(ctx context.Context, ex Exec, st Store) (string, error) {
	tool, err := l.takeoverTool()
	if err != nil {
		return TakeoverNotAttempted, err
	}
	rec, ok, err := loadTakeoverRecord(st, LaneDell)
	if err != nil {
		// Never overwritten: it may be the only record of what to restore.
		return TakeoverNotAttempted, err
	}
	if !ok {
		rec = takeoverRecord{Version: takeoverRecordVersion, Lane: LaneDell, Changed: map[string]ownedSetting{}}
	}
	before, err := l.exportSettings(ctx, ex, tool, st)
	if err != nil {
		// No saved copy, no change: the run goes ahead without a takeover.
		return TakeoverNotAttempted, err
	}
	if err := reconcilePending(&rec, before); err != nil {
		return TakeoverNotAttempted, err
	}
	// Durable before the change, so a crash in the middle still leaves a
	// record a restore can work from.
	rec.PendingBefore = string(before.data)
	if err := saveTakeoverRecord(st, rec); err != nil {
		return TakeoverNotAttempted, runErr("takeover_record_unwritable", err)
	}

	cfgRes, cfgErr := ex.Run(ctx, ExecSpec{Path: tool, Args: dellConfigureArgs})
	if cfgErr != nil {
		log.Warn("dcu-cli configure did not complete; reading the settings back", "error", cfgErr.Error())
	} else if cfgRes.ExitCode != 0 {
		log.Warn("dcu-cli configure exited non-zero; reading the settings back", "exitCode", cfgRes.ExitCode)
	}
	// Exit codes for /configure are not documented as a no-op signal; the
	// read-back is the authority on what changed.
	after, err := l.exportSettings(ctx, ex, tool, st)
	if err != nil {
		// Unconfirmed, but the change may have landed. Breeze holds the record
		// (PendingBefore stays), so it reports the takeover as its own: the API
		// then sends a release when the policy goes, and the restore reconciles.
		// Reporting policy_locked here would tell the API nothing needs handing
		// back.
		return TakeoverOK, runErr("settings_readback_failed", err)
	}
	recordChanges(&rec, before, after)
	for p, o := range rec.Changed {
		if !readsAs(after, p, o) {
			// Someone else's now, and the change did not take it back.
			log.Info("vendor setting no longer Breeze's; ownership dropped", "lane", LaneDell, "setting", p)
			delete(rec.Changed, p)
		}
	}
	rec.PendingBefore = ""
	var saveErr error
	if err := saveTakeoverRecord(st, rec); err != nil {
		// The record on disk still holds the pending snapshot.
		saveErr = runErr("takeover_record_unwritable", err)
	}
	switch {
	case len(rec.Changed) > 0:
		return TakeoverOK, saveErr
	case cfgErr != nil:
		return TakeoverNotAttempted, runErr("settings_configure_failed", cfgErr)
	}
	log.Info("dcu-cli configure changed nothing; the tool's settings are likely policy-controlled")
	return TakeoverPolicyLocked, saveErr
}

// Restore imports a copy of the current settings with only Breeze's settings
// put back as they were, then confirms it took.
func (l *dellLane) Restore(ctx context.Context, ex Exec, st Store) error {
	rec, ok, err := loadTakeoverRecord(st, LaneDell)
	if err != nil {
		return err
	}
	if !ok {
		return ErrNothingToRestore
	}
	tool, err := l.takeoverTool()
	if err != nil {
		if errorCodeOf(err) == "tool_absent" {
			// The tool and its schedule are gone; so is anything to hand back.
			if rerr := st.Remove(takeoverRecordName(LaneDell)); rerr != nil {
				return runErr("takeover_record_unwritable", rerr)
			}
			return fmt.Errorf("%w: %v", ErrNothingToRestore, err)
		}
		return err
	}
	current, err := l.exportSettings(ctx, ex, tool, st)
	if err != nil {
		return err
	}
	if err := reconcilePending(&rec, current); err != nil {
		return err
	}
	var reverts []string
	for p, o := range rec.Changed {
		if !readsAs(current, p, o) {
			log.Info("vendor setting changed since the takeover; left as it is", "lane", LaneDell, "setting", p)
			continue // someone else's now
		}
		if _, present := current.props[p]; !present {
			// Breeze removed it: putting an element back needs a position in
			// the file this format does not give. Left, and said so.
			log.Warn("cannot restore a setting the takeover removed", "setting", p)
			continue
		}
		reverts = append(reverts, p)
	}
	if len(reverts) == 0 {
		if err := st.Remove(takeoverRecordName(LaneDell)); err != nil {
			return runErr("takeover_record_unwritable", err)
		}
		return ErrNothingToRestore
	}
	if err := saveTakeoverRecord(st, rec); err != nil {
		return runErr("takeover_record_unwritable", err)
	}

	merged := restoredSettings(current, rec, reverts)
	dir, err := st.Dir(takeoverImportDir)
	if err != nil {
		return runErr("store_unavailable", err)
	}
	if err := emptyDir(dir); err != nil {
		return runErr("store_unavailable", err)
	}
	file := filepath.Join(dir, takeoverImportName)
	if err := os.WriteFile(file, merged, 0o600); err != nil {
		return runErr("store_unavailable", err)
	}
	res, err := ex.Run(ctx, ExecSpec{Path: tool, Args: []string{"/configure", "-importSettings=" + file}})
	if err != nil {
		return runErr("settings_import_failed", err)
	}
	if res.ExitCode != 0 {
		log.Warn("dcu-cli settings import exited non-zero; checking what it applied", "exitCode", res.ExitCode)
	}
	after, err := l.exportSettings(ctx, ex, tool, st)
	if err != nil {
		return runErr("settings_restore_unconfirmed", err)
	}
	for _, p := range reverts {
		o := rec.Changed[p]
		got, present := after.props[p]
		if present != o.BeforePresent || (present && got.norm != normalizeSetting(o.BeforeRaw)) {
			return runErr("settings_restore_unconfirmed", fmt.Errorf("setting %q did not take the restored value", p))
		}
	}
	if err := emptyDir(dir); err != nil {
		log.Warn("could not clear the restored settings copy", "dir", dir, "error", err.Error())
	}
	if err := st.Remove(takeoverRecordName(LaneDell)); err != nil {
		return runErr("takeover_record_unwritable", err)
	}
	return nil
}

// restoredSettings is current with each reverted setting's element replaced
// by the one from before the takeover (or removed, if there was none).
func restoredSettings(current dellSettings, rec takeoverRecord, reverts []string) []byte {
	sort.Slice(reverts, func(i, j int) bool { return current.props[reverts[i]].start > current.props[reverts[j]].start })
	out := append([]byte(nil), current.data...)
	for _, p := range reverts {
		cur := current.props[p]
		o := rec.Changed[p]
		replacement := ""
		if o.BeforePresent {
			replacement = o.BeforeRaw
		}
		out = append(out[:cur.start], append([]byte(replacement), out[cur.end:]...)...)
	}
	return out
}
