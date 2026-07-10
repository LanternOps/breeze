package security

import (
	"bytes"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Elastic Defend detection on Linux (#2018).
//
// Linux has no OS-level security-center registry (unlike Windows Security
// Center), so third-party AV must be probed directly. Elastic Defend — the
// Endpoint Security integration of Elastic Agent — installs its sensor at
// /opt/Elastic/Endpoint/elastic-endpoint and runs it as the
// ElasticEndpoint.service systemd unit. The Elastic *Agent* binary alone
// (/opt/Elastic/Agent) is only a log/metrics shipper and does NOT imply
// endpoint protection, so detection keys strictly on the Endpoint sensor.

const (
	linuxElasticEndpointBinary = "/opt/Elastic/Endpoint/elastic-endpoint"
	linuxElasticEndpointUnit   = "ElasticEndpoint.service"
	linuxElasticProcessName    = "elastic-endpoint"
)

// linuxElasticProbes injects the host probes so detection logic is unit-testable.
type linuxElasticProbes struct {
	fileExists     func(path string) bool
	processRunning func(name string) bool
	unitActive     func(unit string) bool
	binaryVersion  func(path string) string
}

func defaultLinuxElasticProbes() linuxElasticProbes {
	return linuxElasticProbes{
		fileExists:     fileExists,
		processRunning: func(name string) bool { return linuxProcessRunning("/proc", name) },
		unitActive:     linuxSystemdUnitActive,
		binaryVersion:  linuxElasticEndpointVersion,
	}
}

// getLinuxElasticDefendProduct reports the Elastic Defend sensor as an AV
// product on Linux hosts. Returns ErrNotSupported when the sensor is absent
// (or on non-Linux platforms), mirroring getMacDefenderStatus.
func getLinuxElasticDefendProduct() (*AVProduct, string, error) {
	if runtime.GOOS != "linux" {
		return nil, "", ErrNotSupported
	}
	return detectLinuxElasticDefend(defaultLinuxElasticProbes())
}

// detectLinuxElasticDefend holds the platform-independent detection logic.
// The returned string is the sensor version ("" when unavailable).
func detectLinuxElasticDefend(probes linuxElasticProbes) (*AVProduct, string, error) {
	installed := probes.fileExists(linuxElasticEndpointBinary)
	running := probes.processRunning(linuxElasticProcessName) || probes.unitActive(linuxElasticEndpointUnit)

	// The sensor binary may live under a non-default prefix; a running
	// elastic-endpoint process is just as authoritative as the binary path.
	if !installed && !running {
		return nil, "", ErrNotSupported
	}

	version := ""
	if installed {
		version = probes.binaryVersion(linuxElasticEndpointBinary)
	}

	product := &AVProduct{
		DisplayName:         "Elastic Defend",
		Provider:            "elastic_defend",
		Registered:          true,
		RealTimeProtection:  running,
		DefinitionsUpToDate: false, // protections artifacts are self-updating; freshness is not locally observable
	}
	if installed {
		product.PathToSignedProduct = linuxElasticEndpointBinary
	}

	return product, version, nil
}

// linuxProcessRunning reports whether a process whose argv[0] basename equals
// name is running, by scanning procRoot (normally /proc). /proc/<pid>/comm is
// truncated to 15 chars — "elastic-endpoint" is 16 — so cmdline is used instead.
func linuxProcessRunning(procRoot, name string) bool {
	entries, err := os.ReadDir(procRoot)
	if err != nil {
		return false
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if _, err := strconv.Atoi(entry.Name()); err != nil {
			continue
		}
		data, err := os.ReadFile(filepath.Join(procRoot, entry.Name(), "cmdline"))
		if err != nil || len(data) == 0 {
			continue
		}
		argv0 := string(bytes.SplitN(data, []byte{0}, 2)[0])
		if filepath.Base(argv0) == name {
			return true
		}
	}
	return false
}

func linuxSystemdUnitActive(unit string) bool {
	if !hasCommand("systemctl") {
		return false
	}
	// firewallStatusFromCommand (status.go) returns stdout regardless of exit
	// code — needed here because `systemctl is-active` exits non-zero for
	// transitional states like "activating", whose output we still want.
	stdout, zeroExit, ok := firewallStatusFromCommand(5*time.Second, "systemctl", "is-active", unit)
	if !ok {
		return false
	}
	return linuxUnitStateRunning(strings.TrimSpace(stdout), zeroExit)
}

// linuxUnitStateRunning maps `systemctl is-active` output to a running signal.
// "activating"/"reloading" count as running so a sensor that is starting up
// is not reported as real-time protection off for a whole collection cycle.
// Anything else — including probe failures (dbus down, degraded systemd),
// which are indistinguishable from "inactive" here — reads as not-running;
// the process-scan leg and the next collection cycle compensate.
func linuxUnitStateRunning(state string, zeroExit bool) bool {
	switch state {
	case "active":
		return zeroExit
	case "activating", "reloading":
		return true
	default:
		return false
	}
}

var elasticVersionPattern = regexp.MustCompile(`\d+\.\d+(?:\.\d+)?`)

// linuxElasticEndpointVersion best-effort reads the sensor version via
// `elastic-endpoint version`. Any failure yields "" — version is cosmetic
// and must never block detection.
func linuxElasticEndpointVersion(binaryPath string) string {
	output, err := runCommand(5*time.Second, binaryPath, "version")
	if err != nil {
		return ""
	}
	return parseElasticVersion(output)
}

// parseElasticVersion extracts the first semver-looking token from
// `elastic-endpoint version` output (e.g. "Endpoint Security, version 8.14.1").
func parseElasticVersion(output string) string {
	firstLine := strings.TrimSpace(strings.SplitN(output, "\n", 2)[0])
	return elasticVersionPattern.FindString(firstLine)
}
