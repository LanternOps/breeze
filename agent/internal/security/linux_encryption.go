package security

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path"
	"strings"
	"time"
)

// Linux disk-encryption detection. The headline status (encrypted /
// unencrypted / unknown) and the per-volume details payload are both derived
// from ONE evaluation of the lsblk tree, so they cannot disagree (#7478):
// the headline is exactly the protection of the "/" volume in the details.
//
// Protection is inherited down the block-device tree: a filesystem is
// protected when it or any ancestor is a dm-crypt node or a LUKS container.
// That covers LUKS-direct, LVM-on-LUKS (the default Ubuntu/Debian encrypted
// install, where "/" sits on an lvm node whose parent is the crypt node) and
// btrfs-on-LUKS. ZFS datasets never appear in lsblk (they are not block
// devices), so a ZFS root and every other mounted dataset are resolved via
// /proc/self/mounts + one `zfs get` instead (#7460).

// linuxEncryptionReport is the single source for both the Linux headline and
// the encryptionDetails volumes.
type linuxEncryptionReport struct {
	// RootProtected is the headline. Meaningful only when RootErr is nil.
	RootProtected bool
	// RootErr is set when the root filesystem's protection could not be
	// determined; the headline then reports "unknown" rather than guessing
	// "unencrypted".
	RootErr error
	Volumes []map[string]any
	// Warnings name volumes that could not be evaluated (a failed or partial
	// `zfs get`, datasets over the cap). Such volumes are omitted from
	// Volumes rather than listed as unprotected.
	Warnings []string
}

type lsblkEncryptionNode struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	Fstype     string `json:"fstype"`
	Label      string `json:"label"`
	Mountpoint string `json:"mountpoint"`
	// Mountpoints (util-linux >= 2.37) lists every mount of the device, e.g.
	// each btrfs subvolume; Mountpoint then shows only one of them.
	Mountpoints []string              `json:"mountpoints"`
	Children    []lsblkEncryptionNode `json:"children"`
}

func (n lsblkEncryptionNode) mounts() []string {
	seen := make(map[string]bool, len(n.Mountpoints)+1)
	out := make([]string, 0, len(n.Mountpoints)+1)
	for _, m := range append([]string{n.Mountpoint}, n.Mountpoints...) {
		m = strings.TrimSpace(m)
		if m == "" || seen[m] {
			continue
		}
		seen[m] = true
		out = append(out, m)
	}
	return out
}

func lsblkNodeIsEncryptionLayer(n lsblkEncryptionNode) bool {
	return strings.EqualFold(n.Type, "crypt") || strings.Contains(strings.ToLower(n.Fstype), "luks")
}

// zfsGetFunc runs `zfs get -H -o name,property,value
// encryption,keystatus,encryptionroot` for the given datasets.
type zfsGetFunc func(datasets []string) (string, error)

// maxZfsDatasetVolumes bounds how many non-root ZFS datasets are queried and
// reported, keeping one collection to one bounded `zfs get` and the details
// payload well under the API's 64 KB limit.
const maxZfsDatasetVolumes = 64

// evaluateLinuxEncryption is the pure core: lsblkJSON is `lsblk -J` output
// with NAME,TYPE,FSTYPE,LABEL,MOUNTPOINT[,MOUNTPOINTS]; procMounts is the
// content of /proc/self/mounts; zfsGet queries ZFS dataset properties and is
// called at most once, only when ZFS datasets are mounted. It returns an
// error only when the lsblk output itself is unusable.
func evaluateLinuxEncryption(lsblkJSON, procMounts string, zfsGet zfsGetFunc) (linuxEncryptionReport, error) {
	var payload struct {
		Blockdevices []lsblkEncryptionNode `json:"blockdevices"`
	}
	if err := json.Unmarshal([]byte(lsblkJSON), &payload); err != nil {
		return linuxEncryptionReport{}, fmt.Errorf("parse lsblk output: %w", err)
	}

	report := linuxEncryptionReport{Volumes: make([]map[string]any, 0)}
	rootSeen := false
	rootAllProtected := true
	// A device can be listed under several parents (lsblk repeats md RAID
	// and multi-PV LVM nodes under each member), so every protection verdict
	// below is an AND across all paths: protected only if every path is.
	nodeProtected := map[string]bool{}
	zfsPoolMembers := map[string][]bool{}

	var walk func(node lsblkEncryptionNode, inheritedProtected bool)
	walk = func(node lsblkEncryptionNode, inheritedProtected bool) {
		isProtected := inheritedProtected || lsblkNodeIsEncryptionLayer(node)
		if prev, seen := nodeProtected[node.Name]; seen {
			nodeProtected[node.Name] = prev && isProtected
		} else {
			nodeProtected[node.Name] = isProtected
		}
		if strings.EqualFold(node.Fstype, "zfs_member") && node.Label != "" {
			zfsPoolMembers[node.Label] = append(zfsPoolMembers[node.Label], isProtected)
		}
		for _, mount := range node.mounts() {
			method := "none"
			if isProtected {
				method = "luks"
			}
			report.Volumes = append(report.Volumes, map[string]any{
				"mount":     mount,
				"device":    node.Name,
				"method":    method,
				"protected": isProtected,
			})
			if mount == "/" {
				rootSeen = true
				rootAllProtected = rootAllProtected && isProtected
			}
		}
		for _, child := range node.Children {
			walk(child, isProtected)
		}
	}
	for _, node := range payload.Blockdevices {
		walk(node, false)
	}

	// ZFS datasets are not block devices, so lsblk never lists them. Every
	// mounted dataset other than "/" comes from the mount table, whatever the
	// root is (an ext4 root can sit beside an encrypted ZFS data pool).
	zfsMounts, zfsOmitted := zfsDatasetMounts(procMounts)

	rootDataset := ""
	if rootSeen {
		report.RootProtected = rootAllProtected
		dedupeRootVolume(&report)
	} else {
		source, fstype, ok := rootMountFromProcMounts(procMounts)
		switch {
		case !ok:
			report.RootErr = errors.New("root filesystem not found in lsblk output or /proc/self/mounts")
		case fstype == "zfs":
			rootDataset = source
		case strings.HasPrefix(source, "/dev/"):
			// lsblk before util-linux 2.37 reports one mountpoint per device, so
			// a btrfs "/" subvolume can hide behind "/home". Resolve the root
			// device by name instead (/dev/mapper/<name>, /dev/<kname>).
			name := path.Base(source)
			protected, found := nodeProtected[name]
			if !found {
				report.RootErr = fmt.Errorf("root device %s not found in lsblk output", source)
				break
			}
			method := "none"
			if protected {
				method = "luks"
			}
			report.Volumes = append(report.Volumes, map[string]any{
				"mount":     "/",
				"device":    name,
				"method":    method,
				"protected": protected,
			})
			report.RootProtected = protected
		default:
			report.RootErr = fmt.Errorf("root filesystem (%s on %s) is not a block device lsblk can see", fstype, source)
		}
	}

	if rootDataset == "" && len(zfsMounts) == 0 {
		return report, nil
	}

	datasets := make([]string, 0, len(zfsMounts)+1)
	seen := map[string]bool{}
	for _, ds := range append([]string{rootDataset}, zfsMountDatasets(zfsMounts)...) {
		if ds != "" && !seen[ds] {
			seen[ds] = true
			datasets = append(datasets, ds)
		}
	}
	out, queryErr := zfsGet(datasets)
	props := parseZfsGetOutput(out)

	if rootDataset != "" {
		p, err := zfsDatasetPropsFor(props, rootDataset, queryErr)
		if err != nil {
			report.RootErr = fmt.Errorf("zfs root %s: %w", rootDataset, err)
		} else {
			vol := zfsVolume("/", rootDataset, p, zfsPoolMembers)
			report.Volumes = append(report.Volumes, vol)
			report.RootProtected = vol["protected"].(bool)
		}
	}

	if len(zfsMounts) > 0 && queryErr != nil {
		report.Warnings = append(report.Warnings, fmt.Sprintf("zfs datasets not evaluated: %v", queryErr))
	} else {
		for _, m := range zfsMounts {
			p, err := zfsDatasetPropsFor(props, m.dataset, nil)
			if err != nil {
				report.Warnings = append(report.Warnings, fmt.Sprintf("zfs dataset %s (%s) not evaluated: %v", m.dataset, m.mount, err))
				continue
			}
			report.Volumes = append(report.Volumes, zfsVolume(m.mount, m.dataset, p, zfsPoolMembers))
		}
	}
	if zfsOmitted > 0 {
		report.Warnings = append(report.Warnings, fmt.Sprintf("%d more zfs datasets not evaluated (limit %d)", zfsOmitted, maxZfsDatasetVolumes))
	}
	return report, nil
}

// zfsVolume builds the details entry for a mounted ZFS dataset. It is
// protected by native ZFS encryption (any cipher other than "off", whether
// or not its key is loaded; keystatus "unavailable" means encrypted but
// locked), or, when that is off, by every vdev of its pool sitting on a
// LUKS/dm-crypt device.
func zfsVolume(mount, dataset string, p zfsDatasetProps, poolMembers map[string][]bool) map[string]any {
	protected := p.encryption != "off"
	method := "none"
	if protected {
		method = "zfs"
	} else {
		pool, _, _ := strings.Cut(dataset, "/")
		members := poolMembers[pool]
		allOnCrypt := len(members) > 0
		for _, memberProtected := range members {
			allOnCrypt = allOnCrypt && memberProtected
		}
		if allOnCrypt {
			protected = true
			method = "luks"
		}
	}
	vol := map[string]any{
		"mount":      mount,
		"device":     dataset,
		"method":     method,
		"protected":  protected,
		"encryption": p.encryption,
	}
	if p.keystatus != "" && p.keystatus != "-" {
		vol["status"] = p.keystatus
	}
	if p.encryptionRoot != "" && p.encryptionRoot != "-" {
		vol["encryptionRoot"] = p.encryptionRoot
	}
	return vol
}

// dedupeRootVolume collapses repeated "/" entries (a device reached through
// several parents) into one carrying the headline's protection, so the
// details never show "/" twice with conflicting values.
func dedupeRootVolume(report *linuxEncryptionReport) {
	out := report.Volumes[:0]
	kept := false
	for _, v := range report.Volumes {
		if v["mount"] == "/" {
			if kept {
				continue
			}
			kept = true
			v["protected"] = report.RootProtected
			if !report.RootProtected {
				v["method"] = "none"
			}
		}
		out = append(out, v)
	}
	report.Volumes = out
}

// procMountEntry is one /proc/self/mounts line with octal escapes decoded.
type procMountEntry struct {
	source, mount, fstype string
}

// effectiveProcMounts returns the mount that is visible at each mount path,
// ordered by first appearance. /proc/self/mounts lists mounts in mount
// order, so the last entry for a path is the one that shadows the others.
func effectiveProcMounts(procMounts string) []procMountEntry {
	index := map[string]int{}
	var out []procMountEntry
	for _, line := range strings.Split(procMounts, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		e := procMountEntry{
			source: unescapeMountField(fields[0]),
			mount:  unescapeMountField(fields[1]),
			fstype: fields[2],
		}
		if i, ok := index[e.mount]; ok {
			out[i] = e
			continue
		}
		index[e.mount] = len(out)
		out = append(out, e)
	}
	return out
}

// rootMountFromProcMounts returns the source and fstype of the effective "/"
// mount.
func rootMountFromProcMounts(procMounts string) (source, fstype string, ok bool) {
	for _, e := range effectiveProcMounts(procMounts) {
		if e.mount == "/" {
			return e.source, e.fstype, true
		}
	}
	return "", "", false
}

type zfsMount struct {
	dataset, mount string
}

// containerStoragePrefixes hold container-runtime layers (Docker and
// podman's zfs storage drivers mount one dataset per layer). They are clones
// of a parent dataset, inherit its encryption, and would flood the details.
var containerStoragePrefixes = []string{"/var/lib/docker/", "/var/lib/containers/"}

// zfsDatasetMounts returns the effective non-root ZFS dataset mounts, at most
// maxZfsDatasetVolumes, and how many more were left out. Snapshot automounts
// (dataset@snap) and container-runtime layers are skipped.
func zfsDatasetMounts(procMounts string) (mounts []zfsMount, omitted int) {
	for _, e := range effectiveProcMounts(procMounts) {
		if e.fstype != "zfs" || e.mount == "/" || strings.Contains(e.source, "@") {
			continue
		}
		container := false
		for _, prefix := range containerStoragePrefixes {
			if strings.HasPrefix(e.mount, prefix) {
				container = true
				break
			}
		}
		if container {
			continue
		}
		if len(mounts) == maxZfsDatasetVolumes {
			omitted++
			continue
		}
		mounts = append(mounts, zfsMount{dataset: e.source, mount: e.mount})
	}
	return mounts, omitted
}

func zfsMountDatasets(mounts []zfsMount) []string {
	out := make([]string, len(mounts))
	for i, m := range mounts {
		out[i] = m.dataset
	}
	return out
}

// unescapeMountField decodes the octal escapes the kernel writes into
// /proc/self/mounts for space, tab, newline and backslash (e.g. "\040").
// Anything that is not a valid three-digit octal escape is kept verbatim.
func unescapeMountField(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s)+0 && isOctal(s[i+1]) && isOctal(s[i+2]) && isOctal(s[i+3]) {
			b.WriteByte((s[i+1]-'0')<<6 | (s[i+2]-'0')<<3 | (s[i+3] - '0'))
			i += 3
			continue
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func isOctal(c byte) bool { return c >= '0' && c <= '7' }

type zfsDatasetProps struct {
	encryption, keystatus, encryptionRoot string
}

// parseZfsGetOutput parses `zfs get -H -o name,property,value` output
// (tab-separated) into per-dataset properties.
func parseZfsGetOutput(output string) map[string]zfsDatasetProps {
	out := map[string]zfsDatasetProps{}
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Split(strings.TrimRight(line, "\r"), "\t")
		if len(fields) != 3 {
			continue
		}
		name, property, value := strings.TrimSpace(fields[0]), strings.TrimSpace(fields[1]), strings.TrimSpace(fields[2])
		if name == "" {
			continue
		}
		p := out[name]
		switch property {
		case "encryption":
			p.encryption = strings.ToLower(value)
		case "keystatus":
			p.keystatus = strings.ToLower(value)
		case "encryptionroot":
			p.encryptionRoot = value
		default:
			continue
		}
		out[name] = p
	}
	return out
}

// zfsDatasetPropsFor returns a dataset's properties, or why they are not
// usable: the query failed, or the dataset has no encryption property (gone
// since the mount table was read, or ZFS older than 0.8).
func zfsDatasetPropsFor(props map[string]zfsDatasetProps, dataset string, queryErr error) (zfsDatasetProps, error) {
	if queryErr != nil {
		return zfsDatasetProps{}, queryErr
	}
	p := props[dataset]
	if p.encryption == "" || p.encryption == "-" {
		return zfsDatasetProps{}, fmt.Errorf("zfs get: encryption property missing for %s", dataset)
	}
	return p, nil
}

// queryZfsDatasets asks for every dataset in one call. `zfs get` exits
// non-zero if any one dataset is gone (unmounted or destroyed since the
// mount table was read), discarding the answers for the rest, so a failed
// batch is retried one dataset at a time. A timeout is not retried.
func queryZfsDatasets(datasets []string, run zfsGetFunc) (string, error) {
	out, err := run(datasets)
	if err == nil || len(datasets) == 1 || errors.Is(err, context.DeadlineExceeded) {
		return out, err
	}
	var b strings.Builder
	answered := 0
	for _, ds := range datasets {
		o, dsErr := run([]string{ds})
		if dsErr != nil {
			if errors.Is(dsErr, context.DeadlineExceeded) {
				break
			}
			continue
		}
		answered++
		b.WriteString(o)
		b.WriteString("\n")
	}
	if answered == 0 {
		return "", err
	}
	return b.String(), nil
}

// collectLinuxEncryption runs the host commands and evaluates them once.
func collectLinuxEncryption() (linuxEncryptionReport, error) {
	if !hasCommand("lsblk") {
		return linuxEncryptionReport{}, fmt.Errorf("lsblk not found")
	}
	output, err := runCommandStdout(8*time.Second, "lsblk", "-J", "-o", "NAME,TYPE,FSTYPE,LABEL,MOUNTPOINT,MOUNTPOINTS")
	if err != nil {
		// util-linux < 2.37 has no MOUNTPOINTS column and rejects the
		// whole invocation; retry with the single-mountpoint column.
		var retryErr error
		output, retryErr = runCommandStdout(8*time.Second, "lsblk", "-J", "-o", "NAME,TYPE,FSTYPE,LABEL,MOUNTPOINT")
		if retryErr != nil {
			return linuxEncryptionReport{}, errors.Join(err, retryErr)
		}
	}

	procMounts := ""
	data, mountsErr := os.ReadFile("/proc/self/mounts")
	if mountsErr == nil {
		procMounts = string(data)
	}

	report, err := evaluateLinuxEncryption(output, procMounts, func(datasets []string) (string, error) {
		if !hasCommand("zfs") {
			return "", fmt.Errorf("zfs command not found")
		}
		return queryZfsDatasets(datasets, func(ds []string) (string, error) {
			args := append([]string{"get", "-H", "-o", "name,property,value", "encryption,keystatus,encryptionroot"}, ds...)
			return runCommandStdout(5*time.Second, "zfs", args...)
		})
	})
	if err == nil && report.RootErr != nil && mountsErr != nil {
		report.RootErr = fmt.Errorf("%w (reading /proc/self/mounts: %v)", report.RootErr, mountsErr)
	}
	return report, err
}

// runCommandStdout is runCommand without stderr: lsblk can print warnings on
// stderr while still exiting 0, and those must not be spliced into the JSON.
// Stderr is kept for the error message when the command fails.
func runCommandStdout(timeout time.Duration, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, name, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	output, err := cmd.Output()
	if ctx.Err() == context.DeadlineExceeded {
		return "", fmt.Errorf("command timed out: %s: %w", name, context.DeadlineExceeded)
	}
	if err != nil {
		return "", fmt.Errorf("command failed: %s: %w: %s", name, err, strings.TrimSpace(stderr.String()))
	}
	return strings.TrimSpace(string(output)), nil
}
