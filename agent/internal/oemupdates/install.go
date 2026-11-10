package oemupdates

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/breeze-rmm/agent/internal/authenticode"
)

const downloadsDir = "downloads"

// verifyPublisher checks path's signature fresh and pins its publisher to the
// lane's compiled list. It is the only trust path for a vendor binary, and it
// runs immediately before every execution, never from a cache.
func verifyPublisher(v Verifier, path string, allow LaneAllowlist) error {
	if v == nil {
		return runErr("publisher_unverified", errors.New("no verifier"))
	}
	signer, err := v.Verify(path)
	if err != nil {
		return runErr("signature_invalid", err)
	}
	if !authenticode.PublisherAllowed(signer, allow.Publishers) {
		return runErr("publisher_mismatch", fmt.Errorf("signed by %q", signer.Subject))
	}
	return nil
}

// EnsureTool returns a tool that is present, inside the supported range and
// signed by an allowlisted publisher, installing it from spec when needed. An
// empty outcome means ready; otherwise the outcome and a *RunError say why not.
//
// The range is the lane's compiled range narrowed by spec. A tool above it is
// never downgraded or run; one below it, or unreadable, is replaced. With no
// spec, only a tool already in range is used.
func EnsureTool(ctx context.Context, lane Lane, spec *ToolSpec, deps Deps) (ToolState, Outcome, error) {
	// First, so no other branch can skip it.
	if checked, ok := lane.(HardwareCheckedLane); ok {
		if outcome, err := checked.CheckHardware(); outcome != "" || err != nil {
			if outcome == "" {
				outcome = OutcomeToolUnavailable // an error never reads as ready
			}
			return ToolState{}, outcome, err
		}
	}
	if free, ok := lane.(ToolFreeLane); ok {
		state, outcome, err := free.Ready()
		if err != nil && outcome == "" {
			outcome = OutcomeToolUnavailable // an error never reads as ready
		}
		return state, outcome, err
	}
	eff, err := effectiveRange(lane.Range(), spec)
	if err != nil {
		return ToolState{}, OutcomeToolUnavailable, runErr("invalid_version_range", err)
	}
	gate := lane.Gate()
	state := gate.Get()
	needInstall := !state.Present
	code := "tool_absent"
	if state.Present {
		// The cached version is up to a day old; the range is decided on a
		// fresh read, and a change makes the gate detect again next time.
		fresh, err := lane.ToolVersion(state.Path)
		if err != nil {
			log.Debug("vendor tool version unreadable", "lane", lane.ID(), "path", state.Path, "error", err.Error())
			fresh = ""
		}
		if fresh != state.Version {
			gate.Invalidate()
			state.Version = fresh
		}
		switch eff.position(state.Version) {
		case inRange:
			if err := verifyPublisher(deps.Verifier, state.Path, lane.Allow()); err != nil {
				gate.Invalidate()
				if spec == nil {
					return ToolState{}, OutcomeToolUnavailable, err
				}
				log.Warn("installed vendor tool failed verification; reinstalling",
					"lane", lane.ID(), "path", state.Path, "error", err.Error())
				needInstall, code = true, errorCodeOf(err)
			} else {
				return state, "", nil
			}
		case aboveRange:
			return ToolState{}, OutcomeToolUnavailable,
				runErr("tool_above_supported_range", fmt.Errorf("installed %s, supported below %s", state.Version, eff.MaxExclusive))
		default:
			needInstall, code = true, "tool_below_floor"
		}
	}
	if !needInstall {
		return state, "", nil
	}
	if spec == nil {
		return ToolState{}, OutcomeToolUnavailable, runErr(code, errors.New("no tool in range and no manifest tool to install"))
	}
	if eff.position(spec.Version) != inRange {
		return ToolState{}, OutcomeToolUnavailable,
			runErr("manifest_version_out_of_range", fmt.Errorf("manifest version %s is outside [%s, %s)", spec.Version, eff.Min, eff.MaxExclusive))
	}
	installed, err := installTool(ctx, lane, spec, eff, deps)
	if err != nil {
		return ToolState{}, OutcomeToolUnavailable, err
	}
	return installed, "", nil
}

func installTool(ctx context.Context, lane Lane, spec *ToolSpec, eff VersionRange, deps Deps) (ToolState, error) {
	deps.progress(StageInstallingTool)
	dir, err := deps.Store.Dir(downloadsDir)
	if err != nil {
		return ToolState{}, runErr("store_unavailable", err)
	}
	defer cleanDownloads(dir)
	allow := lane.Allow()

	// Resolve every prerequisite before downloading anything: an unknown name
	// refuses the whole install.
	handlers := make([]PrerequisiteHandler, len(spec.Prerequisites))
	for i, p := range spec.Prerequisites {
		h, ok := lane.Prerequisite(p.Name)
		if !ok || h.Installed == nil || h.InstallArgs == nil || len(h.Allow.Publishers) == 0 || len(h.Allow.Hosts) == 0 {
			return ToolState{}, runErr("unknown_prerequisite", fmt.Errorf("lane %s has no usable prerequisite %q", lane.ID(), p.Name))
		}
		handlers[i] = h
	}
	for i, p := range spec.Prerequisites {
		h := handlers[i]
		if versionAtLeast(h.Installed(), p.MinVersion) {
			continue
		}
		installer := filepath.Join(dir, fmt.Sprintf("prereq-%d.exe", i))
		if err := fetchAndVerify(ctx, deps, p.URL, p.SHA256, h.Allow, installer); err != nil {
			return ToolState{}, err
		}
		args := h.InstallArgs(installer, filepath.Join(dir, fmt.Sprintf("prereq-%d.log", i)))
		res, err := deps.Exec.Run(ctx, ExecSpec{Path: installer, Args: args})
		if err != nil {
			return ToolState{}, runErr("prerequisite_install_failed", err)
		}
		if got := h.Installed(); !versionAtLeast(got, p.MinVersion) {
			return ToolState{}, runErr("prerequisite_install_incomplete",
				fmt.Errorf("%s at %q after install (exit %d), need %s", p.Name, got, res.ExitCode, p.MinVersion))
		}
	}

	installer := filepath.Join(dir, "tool.exe")
	if err := fetchAndVerify(ctx, deps, spec.URL, spec.SHA256, allow, installer); err != nil {
		return ToolState{}, err
	}
	res, err := deps.Exec.Run(ctx, ExecSpec{Path: installer, Args: lane.InstallArgs(installer, filepath.Join(dir, "tool-install.log"))})
	gate := lane.Gate()
	gate.Invalidate()
	if err != nil {
		return ToolState{}, runErr("install_failed", err)
	}
	// The exit code alone is not trusted: Dell's installer can exit 0 without
	// installing when a prerequisite is missing. What is on disk decides.
	state := gate.Get()
	if !state.Present || eff.position(state.Version) != inRange {
		return ToolState{}, runErr("install_incomplete",
			fmt.Errorf("after install (exit %d) the tool is present=%v version=%q", res.ExitCode, state.Present, state.Version))
	}
	if err := verifyPublisher(deps.Verifier, state.Path, allow); err != nil {
		gate.Invalidate()
		return ToolState{}, err
	}
	log.Info("vendor tool installed", "lane", lane.ID(), "version", state.Version, "exitCode", res.ExitCode)
	return state, nil
}

func fetchAndVerify(ctx context.Context, deps Deps, url, sha string, allow LaneAllowlist, dest string) error {
	if deps.Fetcher == nil {
		return runErr("download_failed", errors.New("no fetcher"))
	}
	if err := deps.Fetcher.Fetch(ctx, url, sha, allow, dest); err != nil {
		code := "download_failed"
		switch {
		case errors.Is(err, ErrHostNotAllowed):
			code = "download_host_not_allowed"
		case errors.Is(err, ErrDigestMismatch):
			code = "download_digest_mismatch"
		case errors.Is(err, ErrTooLarge):
			code = "download_too_large"
		}
		return runErr(code, err)
	}
	if err := verifyPublisher(deps.Verifier, dest, allow); err != nil {
		_ = os.Remove(dest)
		return err
	}
	return nil
}

func cleanDownloads(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if err := os.Remove(filepath.Join(dir, e.Name())); err != nil {
			log.Debug("could not remove vendor download", "name", e.Name(), "error", err.Error())
		}
	}
}
