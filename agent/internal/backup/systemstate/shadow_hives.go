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
// Every one of them is required: a missing file fails the step and is named.
var shadowRegistryHives = []string{"SYSTEM", "SOFTWARE", "SAM", "SECURITY", "DEFAULT"}

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
func collectRegistryHivesForRun(dir, stagingDir, systemRoot string, opts CollectOptions) ([]Artifact, error) {
	configDir, ok := shadowConfigDir(opts.ShadowPaths, systemRoot)
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
