package systemstate

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
)

// ---------------------------------------------------------------------------
// Registry hive capture from a VSS shadow copy (#5397 follow-up)
//
// `reg.exe save HKLM\SAM` / `HKLM\SECURITY` is detected by Microsoft Defender
// as Trojan:Win32/Commando.A!ml and blocked outright, so on a Defender host the
// registry step used to fail on every system_image run. When the run already
// holds a VSS shadow copy of the system volume, the hive FILES are copied out
// of the shadow copy's %SystemRoot%\System32\config instead — the same bytes
// the whole-machine file walk reads from the same snapshot — and reg.exe is
// never spawned. reg.exe save remains only as the non-VSS fallback.
//
// Portable (no build tag) so the decision and copy logic run against a fake
// shadow tree on every GOOS; only openHiveSource differs per OS.
// ---------------------------------------------------------------------------

// registryHives are the hives `reg save` captures on the non-VSS path — the
// four HKLM hives a bootable bare-metal restore requires (see
// bmr.offlineRequiredHives).
var registryHives = []string{"SYSTEM", "SOFTWARE", "SAM", "SECURITY"}

// shadowRegistryHives are the hive files copied from a shadow copy: the four
// required HKLM hives plus DEFAULT (the .DEFAULT user profile hive, which
// lives in the same config directory; reg save cannot address it under HKLM).
// A missing required hive fails the step and is named; see
// bestEffortShadowHives for DEFAULT.
var shadowRegistryHives = []string{"SYSTEM", "SOFTWARE", "SAM", "SECURITY", "DEFAULT"}

// bestEffortShadowHives are captured when present but never fail the step:
// no restore consumer reads DEFAULT (bmr's offline fallback replaces exactly
// SYSTEM/SOFTWARE/SAM/SECURITY), so its absence only costs completeness.
var bestEffortShadowHives = map[string]bool{"DEFAULT": true}

// hiveLogSuffixes are the transaction logs that sit next to each hive file.
// On Windows 8.1+ the primary file is reconciled lazily, so recent changes can
// live only in the logs; a primary copied from a shadow copy is complete only
// together with them (RegLoadKey replays <hive>.LOG1/.LOG2 found next to the
// file). They are optional — a fully reconciled hive may have none.
var hiveLogSuffixes = []string{".LOG1", ".LOG2"}

// CollectOptions carries per-run context into system-state collection.
type CollectOptions struct {
	// ShadowPaths is the run's VSS session map (vss.VSSSession.ShadowPaths):
	// volume ("C:") -> shadow-copy device root, with no trailing separator
	// (`\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopyN`). When it covers the
	// system volume, registry hives are copied from the shadow copy instead of
	// saved with reg.exe. Nil for a run without VSS.
	ShadowPaths map[string]string

	// AcquireBackupPrivilege, when set, enables SeBackupPrivilege for the
	// duration of the hive copy (the caller owns the process-wide, ref-counted
	// privilege state). Best effort: SYSTEM and elevated Administrators can
	// read the shadow copy's hive files without it.
	AcquireBackupPrivilege func() (release func(), err error)

	// SnapshotVolume, when ShadowPaths does not cover the system volume,
	// takes a VSS shadow copy of that ONE volume for the registry step and
	// returns its shadow map plus a release the step calls as soon as the
	// hives are copied. The Windows collector defaults it to a real VSS
	// snapshot (newCollector), so a system_image run with no paths — which
	// has no run-wide VSS session — and the IPC system_state_collect command
	// never reach `reg.exe save` unless VSS itself fails. Nil means "no
	// snapshot": the reg.exe path.
	SnapshotVolume func(volume string) (shadowPaths map[string]string, release func(), err error)

	// SkipSystemVolumeSnapshot suppresses SnapshotVolume. The backup run sets
	// it when its own VSS attempt just failed, so a wedged VSS subsystem is
	// not asked (and waited on) a second time.
	SkipSystemVolumeSnapshot bool
}

// shadowConfigDir returns the shadow copy's %SystemRoot%\System32\config
// directory when shadowPaths covers the volume systemRoot lives on.
// systemRoot is a Windows path (`C:\Windows`); the volume lookup is
// case-insensitive because shadowPaths is keyed on whatever spelling the
// configured backup path used.
func shadowConfigDir(shadowPaths map[string]string, systemRoot string) (string, bool) {
	if len(shadowPaths) == 0 || len(systemRoot) < 2 || systemRoot[1] != ':' {
		return "", false
	}
	vol := systemRoot[:2]
	var shadow string
	for k, v := range shadowPaths {
		if strings.EqualFold(k, vol) {
			shadow = v
			break
		}
	}
	shadow = strings.TrimRight(shadow, `\/`)
	if shadow == "" {
		return "", false
	}
	segs := strings.FieldsFunc(systemRoot[2:], func(r rune) bool { return r == '\\' || r == '/' })
	if len(segs) == 0 {
		return "", false // `C:\` is not a system root
	}
	// filepath.Join cleans, which is safe here: the result is always BELOW
	// the device root, never the bare device (see backup.cleanBackupRoot).
	parts := append([]string{shadow}, segs...)
	return filepath.Join(append(parts, "System32", "config")...), true
}

// collectRegistryHivesForRun captures the registry for one run: from the
// shadow copy when the run holds one of the system volume, else via reg.exe.
// Under VSS it never falls back to reg.exe for a hive the shadow copy lacks —
// that is precisely the call Defender blocks — the hive is named as failed.
//
// When the run's own VSS session does not cover the system volume (a
// system_image run with no paths has no session at all, nor does the IPC
// system_state_collect), it takes a shadow copy of the system volume alone
// through opts.SnapshotVolume and releases it as soon as the hives are copied.
// reg.exe is reached only when that snapshot cannot be taken or does not
// cover the volume, and that fallback is logged as a warning.
func collectRegistryHivesForRun(dir, stagingDir, systemRoot string, opts CollectOptions) ([]Artifact, error) {
	configDir, ok := shadowConfigDir(opts.ShadowPaths, systemRoot)
	if !ok {
		var release func()
		configDir, release, ok = snapshotSystemVolumeForHives(systemRoot, opts)
		if release != nil {
			defer release()
		}
	}
	if !ok {
		return collectRegistryHives(dir, stagingDir, registryHives)
	}
	if opts.AcquireBackupPrivilege != nil {
		release, err := opts.AcquireBackupPrivilege()
		if err != nil {
			slog.Warn("systemstate: SeBackupPrivilege unavailable, copying hives with the token's own access",
				"error", err.Error())
		} else if release != nil {
			defer release()
		}
	}
	slog.Info("systemstate: capturing registry hives from the VSS shadow copy", "configDir", configDir)
	return collectRegistryHivesFromShadow(dir, stagingDir, configDir, shadowRegistryHives)
}

// snapshotSystemVolumeForHives takes the registry step's own shadow copy of
// the system volume (see collectRegistryHivesForRun). ok is false — and the
// caller falls back to reg.exe — when no snapshot is configured, the run said
// to skip it, it failed, or it does not cover the system volume; every such
// case is logged, since the fallback is exactly the call Defender blocks for
// SAM/SECURITY. release, when non-nil, must be called once the hives are
// copied (it is also returned when the snapshot proved unusable).
func snapshotSystemVolumeForHives(systemRoot string, opts CollectOptions) (configDir string, release func(), ok bool) {
	if opts.SnapshotVolume == nil {
		return "", nil, false
	}
	const fallback = "falling back to `reg save`, which Microsoft Defender blocks for SAM/SECURITY as Trojan:Win32/Commando.A!ml"
	if len(systemRoot) < 2 || systemRoot[1] != ':' {
		slog.Warn("systemstate: cannot tell the system volume, no shadow copy for hive capture; "+fallback, "systemRoot", systemRoot)
		return "", nil, false
	}
	if opts.SkipSystemVolumeSnapshot {
		slog.Warn("systemstate: VSS already failed for this run, no shadow copy for hive capture; " + fallback)
		return "", nil, false
	}
	volume := strings.ToUpper(systemRoot[:2])
	// The snapshot holds only what is already on disk; flush the loaded
	// hives first so recent registry writes are in it (#7367). Best effort.
	flushHivesBeforeSnapshot()
	shadows, release, err := opts.SnapshotVolume(volume)
	if err != nil {
		slog.Warn("systemstate: VSS shadow copy of the system volume failed; "+fallback, "volume", volume, "error", err.Error())
		return "", nil, false
	}
	configDir, ok = shadowConfigDir(shadows, systemRoot)
	if !ok {
		slog.Warn("systemstate: VSS shadow copy does not cover the system volume; "+fallback, "volume", volume)
		return "", release, false
	}
	slog.Info("systemstate: took a VSS shadow copy of the system volume for hive capture", "volume", volume)
	return configDir, release, true
}

// collectRegistryHivesFromShadow copies each hive file, and whichever of its
// transaction logs exist, from configDir into dir. A hive is captured as a
// unit: if its primary file is missing or unreadable, or a log that exists
// cannot be copied, nothing of that hive is staged and it is named in the
// returned *registrySaveError. Hives that succeed are kept, as on the reg.exe
// path.
//
// Artifact layout matches the reg.exe path — registry/<HIVE>, named
// registry_<HIVE> — which is what the rebuild engine reads; each log is an
// additional registry/<HIVE>.LOG1|.LOG2 artifact (registry_<HIVE>.LOG1|.LOG2),
// so it downloads next to its hive.
func collectRegistryHivesFromShadow(dir, stagingDir, configDir string, hives []string) ([]Artifact, error) {
	var artifacts []Artifact
	var failed []string
	var firstErr error
	for _, hive := range hives {
		arts, err := copyShadowHive(dir, stagingDir, configDir, hive)
		if err != nil && bestEffortShadowHives[hive] {
			slog.Warn("systemstate: best-effort hive not captured from shadow copy", "hive", hive, "error", err.Error())
			continue
		}
		if err != nil {
			slog.Warn("systemstate: hive copy from shadow copy failed", "hive", hive, "error", err.Error())
			failed = append(failed, hive)
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		artifacts = append(artifacts, arts...)
	}
	if len(failed) > 0 {
		return artifacts, &registrySaveError{FailedHives: failed, Err: firstErr, Source: "the VSS shadow copy"}
	}
	return artifacts, nil
}

// copyShadowHive stages one hive and its existing logs, all or nothing.
func copyShadowHive(dir, stagingDir, configDir, hive string) ([]Artifact, error) {
	var staged []string
	cleanup := func() {
		for _, p := range staged {
			_ = os.Remove(p)
		}
	}
	names := []string{hive}
	for _, suffix := range hiveLogSuffixes {
		names = append(names, hive+suffix)
	}
	for i, name := range names {
		dst := filepath.Join(dir, name)
		err := copyHiveSourceFile(filepath.Join(configDir, name), dst)
		if err != nil {
			_ = os.Remove(dst)
			if i > 0 && errors.Is(err, fs.ErrNotExist) {
				continue // logs are optional
			}
			cleanup()
			return nil, err
		}
		staged = append(staged, dst)
	}
	arts := make([]Artifact, 0, len(staged))
	for _, p := range staged {
		arts = append(arts, artifactFromFile("registry_"+filepath.Base(p), "registry", p, stagingDir))
	}
	return arts, nil
}

// copyHiveSourceFile copies one regular file out of the shadow copy.
func copyHiveSourceFile(src, dst string) error {
	in, err := openHiveSource(src)
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()
	info, err := in.Stat()
	if err != nil {
		return fmt.Errorf("stat %s: %w", src, err)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("%s is not a regular file (mode %s)", src, info.Mode())
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("create %s: %w", dst, err)
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return fmt.Errorf("copy %s: %w", src, err)
	}
	if err := out.Close(); err != nil {
		return fmt.Errorf("close %s: %w", dst, err)
	}
	return nil
}
