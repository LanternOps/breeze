package workloads

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"math"
	"os"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	// proxmoxPvesh is the only program the Proxmox driver runs, by absolute path.
	proxmoxPvesh = "/usr/bin/pvesh"
	// maxGuestConfBytes bounds one guest config read; onboot sits in the first
	// section, and configs are a few KiB.
	maxGuestConfBytes = 64 << 10
	// maxDpkgStatusBytes bounds the package database scan used for the version.
	maxDpkgStatusBytes = 64 << 20
)

// validNodeName is the charset a Proxmox node name may have (a hostname label).
// The name comes from the host, and it is checked before it becomes part of an
// argv element or a file path.
var validNodeName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,62}$`)

// proxmoxDriver inventories the local node's QEMU VMs and LXC containers with
// `pvesh get` (local, in-process API calls as root: no ticket, no network
// listener). Detect runs nothing; Collect runs pvesh only while the cluster
// filesystem (pmxcfs) is mounted, so a node whose pve-cluster service is down
// is reported unavailable and left alone.
type proxmoxDriver struct {
	pvesh      string
	pveDir     string // /etc/pve, the pmxcfs mount point
	dpkgStatus string // /var/lib/dpkg/status, read for the version

	stat     func(string) (fs.FileInfo, error)
	readlink func(string) (string, error)
	readConf func(path string, limit int64) ([]byte, error)
	run      cmdRunner
	now      func() time.Time
}

func (d *proxmoxDriver) Runtime() Runtime { return RuntimeProxmox }

var errPmxcfsNotMounted = errors.New("workloads: pmxcfs not mounted")

// Detect, without running anything:
//
//	no /usr/bin/pvesh                 -> absent
//	pvesh present, /etc/pve/local     -> present
//	pvesh present, no /etc/pve/local  -> present, Reason not_running (pmxcfs is down)
//
// pmxcfs provides /etc/pve/local as a symlink to the local node's directory;
// with pve-cluster stopped /etc/pve is an empty directory.
func (d *proxmoxDriver) Detect(context.Context) Detection {
	if _, err := d.stat(d.pvesh); err != nil {
		switch {
		case errors.Is(err, fs.ErrNotExist):
			return Detection{State: DetectionAbsent}
		case errors.Is(err, fs.ErrPermission):
			return Detection{State: DetectionPresent, Reason: ReasonPermissionDenied}
		default:
			return Detection{State: DetectionUnknown, Reason: ReasonUnreachable}
		}
	}
	version := ""
	if v := dpkgPackageVersion(d.dpkgStatus, "pve-manager"); v != "" {
		version = "pve-manager/" + v
	}
	if _, err := d.localNode(); errors.Is(err, errPmxcfsNotMounted) {
		return Detection{State: DetectionPresent, Version: version, Reason: ReasonNotRunning}
	}
	return Detection{State: DetectionPresent, Version: version}
}

// localNode resolves the local node from pmxcfs's /etc/pve/local symlink
// ("nodes/<name>"), which is the node name the API uses for this host.
func (d *proxmoxDriver) localNode() (string, error) {
	target, err := d.readlink(path.Join(d.pveDir, "local"))
	if err != nil {
		return "", errPmxcfsNotMounted
	}
	name, ok := strings.CutPrefix(target, "nodes/")
	if !ok || !validNodeName.MatchString(name) {
		return "", errors.New("workloads: invalid node name")
	}
	return name, nil
}

// pveGuest is the allowlist decoded from a qemu or lxc list entry. Numbers are
// raw because the API prints some as strings (an lxc vmid is "101"); tags,
// lock, network and disk counters are never decoded.
type pveGuest struct {
	VMID     json.RawMessage `json:"vmid"`
	Name     string          `json:"name"`
	Status   string          `json:"status"`
	CPUs     json.RawMessage `json:"cpus"`
	MaxMem   json.RawMessage `json:"maxmem"`
	Uptime   json.RawMessage `json:"uptime"`
	Template json.RawMessage `json:"template"`
}

func (d *proxmoxDriver) Collect(ctx context.Context, det Detection) Result {
	switch det.Reason {
	case ReasonNotRunning:
		return Result{Collection: CollectionUnavailable, Error: ReasonNotRunning}
	case ReasonPermissionDenied:
		return Result{Collection: CollectionPermissionDenied, Error: ReasonPermissionDenied}
	}
	node, err := d.localNode()
	switch {
	case errors.Is(err, errPmxcfsNotMounted):
		return Result{Collection: CollectionUnavailable, Error: ReasonNotRunning}
	case err != nil:
		slog.Warn("workloads: proxmox local node name rejected")
		return Result{Collection: CollectionError, Error: "invalid_node"}
	}

	qemu, qfail := d.list(ctx, node, "qemu")
	lxc, lfail := d.list(ctx, node, "lxc")
	if qfail != nil && lfail != nil {
		return *qfail
	}
	// One list is still a valid partial snapshot; incomplete means the server
	// never deletes by absence from it.
	complete, code := true, ""
	switch {
	case qfail != nil:
		complete, code = false, "qemu_list_failed"
	case lfail != nil:
		complete, code = false, "lxc_list_failed"
	}

	now := d.now()
	ws := make([]Workload, 0, len(qemu)+len(lxc))
	ws = d.appendGuests(ws, qemu, KindVM, node, "qemu-server", now)
	ws = d.appendGuests(ws, lxc, KindLXC, node, "lxc", now)
	observed := len(ws)
	ws, truncated := orderAndCap(ws)
	if truncated {
		complete = false
		if code == "" {
			code = "truncated"
		}
	}
	return Result{Collection: CollectionOK, Complete: complete, Workloads: ws, ObservedCount: observed, Error: code}
}

// list runs `pvesh get /nodes/<node>/<kind> --output-format json`. A non-nil
// Result reports why the list is unusable.
func (d *proxmoxDriver) list(ctx context.Context, node, kind string) ([]pveGuest, *Result) {
	out, err := d.run(ctx, d.pvesh, "get", "/nodes/"+node+"/"+kind, "--output-format", "json")
	if err != nil {
		res := execFailure(err)
		slog.Warn("workloads: pvesh list failed", "kind", kind, "code", res.Error, "error", err.Error())
		return nil, &res
	}
	if out.ExitCode != 0 {
		slog.Warn("workloads: pvesh list failed", "kind", kind, "exitCode", out.ExitCode, "stderr", clip(string(out.Stderr), 512))
		return nil, &Result{Collection: CollectionError, Error: "command_failed"}
	}
	raw := bytes.TrimSpace(out.Stdout)
	if len(raw) == 0 {
		return nil, &Result{Collection: CollectionError, Error: "empty_output"}
	}
	var guests []pveGuest
	if err := json.Unmarshal(raw, &guests); err != nil {
		slog.Warn("workloads: pvesh list not decodable", "kind", kind, "bytes", len(raw))
		return nil, &Result{Collection: CollectionError, Error: "decode_failed"}
	}
	return guests, nil
}

// appendGuests maps guests, skipping templates (they never run) and entries
// without a usable numeric vmid.
func (d *proxmoxDriver) appendGuests(ws []Workload, guests []pveGuest, kind, node, confDir string, now time.Time) []Workload {
	for _, g := range guests {
		vmid, ok := pveVMID(g.VMID)
		if !ok || pveTruthy(g.Template) {
			continue
		}
		id := strconv.FormatUint(vmid, 10)
		state := pveState(g.Status)
		w := Workload{
			WorkloadID: id,
			Kind:       kind,
			Name:       g.Name,
			State:      state,
			RawState:   strp(g.Status),
		}
		if cpus, ok := pveNumber(g.CPUs); ok && cpus > 0 && cpus <= maxCPUCount {
			w.CPUCount = boundedInt(int64(math.Ceil(cpus)), maxCPUCount)
		}
		if mem, ok := pveNumber(g.MaxMem); ok && mem > 0 && mem < math.MaxInt64 {
			w.MemoryMB = boundedInt(int64(mem)/(1<<20), maxMemoryMB)
		}
		if up, ok := pveNumber(g.Uptime); ok && state == StateRunning && up < math.MaxInt64 {
			w.StartedAt = startedAtFromUptime(now, int64(up))
		}
		conf := path.Join(d.pveDir, "nodes", node, confDir, id+".conf")
		if b, err := d.readConf(conf, maxGuestConfBytes); err == nil {
			w.RestartPolicy = onbootPolicy(b)
		}
		w.Bound()
		ws = append(ws, w)
	}
	return ws
}

func pveState(status string) string {
	switch strings.ToLower(status) {
	case "running":
		return StateRunning
	case "stopped":
		return StateStopped
	case "paused", "suspended", "frozen":
		return StatePaused
	default:
		return StateOther
	}
}

// pveNumber reads a JSON number or a numeric string.
func pveNumber(raw json.RawMessage) (float64, bool) {
	if len(raw) == 0 {
		return 0, false
	}
	var f float64
	if err := json.Unmarshal(raw, &f); err == nil {
		return f, true
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return 0, false
	}
	f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return f, err == nil
}

// pveVMID accepts a positive integer vmid written as a plain number or string.
func pveVMID(raw json.RawMessage) (uint64, bool) {
	s := strings.Trim(strings.TrimSpace(string(raw)), `"`)
	n, err := strconv.ParseUint(s, 10, 32)
	if err != nil || n == 0 {
		return 0, false
	}
	return n, true
}

// pveTruthy reads the API's boolean flags: 1, "1" or true.
func pveTruthy(raw json.RawMessage) bool {
	switch strings.Trim(strings.TrimSpace(string(raw)), `"`) {
	case "1", "true":
		return true
	}
	return false
}

// onbootPolicy maps a guest config's onboot to restart_policy: "always" when
// the guest starts with the node, "no" when it does not (the default when the
// key is absent). Only the current configuration counts: it ends at the first
// "[section]" (snapshots, pending changes). An unreadable value is unknown.
func onbootPolicy(conf []byte) *string {
	for _, line := range strings.Split(string(conf), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "[") {
			break
		}
		v, ok := strings.CutPrefix(line, "onboot:")
		if !ok {
			continue
		}
		switch strings.TrimSpace(v) {
		case "1":
			return strp("always")
		case "0":
			return strp("no")
		default:
			return nil
		}
	}
	return strp("no")
}

// readFileLimited reads at most limit bytes of a file and fails when it is
// larger, so a corrupt or hostile file cannot grow the agent's memory.
func readFileLimited(name string, limit int64) ([]byte, error) {
	f, err := os.Open(name)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	b, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, errTooLarge
	}
	return b, nil
}

// dpkgPackageVersion returns pkg's version from a dpkg status database, or "".
// Reading the file replaces running pveversion, so Detect never executes
// anything.
func dpkgPackageVersion(statusFile, pkg string) string {
	f, err := os.Open(statusFile)
	if err != nil {
		return ""
	}
	defer func() { _ = f.Close() }()
	sc := bufio.NewScanner(io.LimitReader(f, maxDpkgStatusBytes))
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	in := false
	for sc.Scan() {
		line := sc.Text()
		switch {
		case line == "":
			in = false
		case strings.HasPrefix(line, "Package: "):
			in = strings.TrimSpace(strings.TrimPrefix(line, "Package: ")) == pkg
		case in && strings.HasPrefix(line, "Version: "):
			return clip(strings.TrimSpace(strings.TrimPrefix(line, "Version: ")), 48)
		}
	}
	return ""
}
