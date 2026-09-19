package heartbeat

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

type cachedAgentComponentProbe struct {
	size    int64
	modTime time.Time
	probe   rollbackComponentProbe
}

var agentComponentProbeCache sync.Map

type rollbackComponentProbe struct {
	Installed bool
	Version   string
	Trusted   bool
}

func buildRollbackComponentVersions(goos, agentVersion string, probes map[string]rollbackComponentProbe) (map[string]string, bool) {
	if agentVersion == "" {
		return nil, false
	}
	versions := map[string]string{"agent": agentVersion}
	components := []string{"helper", "watchdog", "backup"}
	if goos == "windows" {
		components = append(components, "user-helper")
	} else if probe, present := probes["user-helper"]; present && probe.Installed {
		return nil, false
	}
	for _, component := range components {
		probe, present := probes[component]
		if !present {
			return nil, false
		}
		if !probe.Trusted || (probe.Installed && probe.Version == "") {
			return nil, false
		}
		if probe.Installed {
			versions[component] = probe.Version
		}
	}
	return versions, true
}

func probeInstalledAgentComponent(path string) rollbackComponentProbe {
	if path == "" {
		return rollbackComponentProbe{Trusted: false}
	}
	info, err := os.Stat(path)
	if err != nil {
		return rollbackComponentProbe{Trusted: os.IsNotExist(err)}
	}
	if cached, ok := agentComponentProbeCache.Load(path); ok {
		entry := cached.(cachedAgentComponentProbe)
		if entry.size == info.Size() && entry.modTime.Equal(info.ModTime()) {
			return entry.probe
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, path, "version").CombinedOutput()
	if err != nil {
		probe := rollbackComponentProbe{Installed: true, Trusted: false}
		agentComponentProbeCache.Store(path, cachedAgentComponentProbe{size: info.Size(), modTime: info.ModTime(), probe: probe})
		return probe
	}
	version := strings.TrimSpace(string(output))
	version = strings.TrimPrefix(version, "Breeze Agent v")
	if version == "" || strings.ContainsAny(version, "\r\n\t ") {
		probe := rollbackComponentProbe{Installed: true, Trusted: false}
		agentComponentProbeCache.Store(path, cachedAgentComponentProbe{size: info.Size(), modTime: info.ModTime(), probe: probe})
		return probe
	}
	probe := rollbackComponentProbe{Installed: true, Version: version, Trusted: true}
	agentComponentProbeCache.Store(path, cachedAgentComponentProbe{size: info.Size(), modTime: info.ModTime(), probe: probe})
	return probe
}

func (h *Heartbeat) rollbackComponentVersions() (map[string]string, bool) {
	probes := make(map[string]rollbackComponentProbe, 4)
	if h.helperMgr != nil {
		installed := h.helperMgr.IsInstalled()
		version := h.helperMgr.InstalledVersion()
		probes["helper"] = rollbackComponentProbe{
			Installed: installed,
			Version:   version,
			Trusted:   !installed || version != "",
		}
	} else {
		probes["helper"] = rollbackComponentProbe{Trusted: false}
	}

	binaryPath, err := os.Executable()
	if err != nil {
		probes["watchdog"] = rollbackComponentProbe{Trusted: false}
		if runtime.GOOS == "windows" {
			probes["user-helper"] = rollbackComponentProbe{Trusted: false}
		}
	} else {
		dir := filepath.Dir(binaryPath)
		suffix := ""
		if runtime.GOOS == "windows" {
			suffix = ".exe"
			probes["user-helper"] = probeInstalledAgentComponent(filepath.Join(dir, "breeze-user-helper.exe"))
		}
		watchdogPath := filepath.Join(dir, "breeze-watchdog"+suffix)
		_, statErr := os.Stat(watchdogPath)
		watchdogInstalled := statErr == nil
		watchdogVersion := h.installedWatchdogVersion()
		probes["watchdog"] = rollbackComponentProbe{
			Installed: watchdogInstalled,
			Version:   watchdogVersion,
			Trusted:   os.IsNotExist(statErr) || (watchdogInstalled && watchdogVersion != ""),
		}
	}

	backupVersion, backupOutcome := h.installedBackupVersionOutcome()
	probes["backup"] = rollbackComponentProbe{
		Installed: backupOutcome == backupProbeOK,
		Version:   backupVersion,
		Trusted:   backupOutcome == backupProbeOK || backupOutcome == backupProbeNotInstalled,
	}
	return buildRollbackComponentVersions(runtime.GOOS, h.agentVersion, probes)
}
