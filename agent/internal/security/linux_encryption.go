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
// btrfs-on-LUKS. A ZFS root never appears in lsblk (datasets are not block
// devices), so it is resolved via /proc/self/mounts + `zfs get` instead.

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

// evaluateLinuxEncryption is the pure core: lsblkJSON is `lsblk -J` output
// with NAME,TYPE,FSTYPE,LABEL,MOUNTPOINT[,MOUNTPOINTS]; procMounts is the
// content of /proc/self/mounts; zfsProps runs `zfs get` for a dataset. It
// returns an error only when the lsblk output itself is unusable.
func evaluateLinuxEncryption(lsblkJSON, procMounts string, zfsProps func(dataset string) (string, error)) (linuxEncryptionReport, error) {
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

	if rootSeen {
		report.RootProtected = rootAllProtected
		dedupeRootVolume(&report)
		return report, nil
	}

	source, fstype, ok := rootMountFromProcMounts(procMounts)
	switch {
	case !ok:
		report.RootErr = errors.New("root filesystem not found in lsblk output or /proc/self/mounts")
	case fstype == "zfs":
		evaluateZfsRoot(&report, source, zfsPoolMembers, zfsProps)
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
	return report, nil
}

// evaluateZfsRoot fills the headline and "/" volume for a ZFS root. The root
// is protected by native ZFS encryption on the dataset, or, when that is off,
// by every vdev of its pool sitting on a LUKS/dm-crypt device.
func evaluateZfsRoot(report *linuxEncryptionReport, dataset string, poolMembers map[string][]bool, zfsProps func(string) (string, error)) {
	out, err := zfsProps(dataset)
	if err != nil {
		report.RootErr = fmt.Errorf("zfs root %s: %w", dataset, err)
		return
	}
	encryption, keystatus, err := parseZfsEncryptionProps(out)
	if err != nil {
		report.RootErr = fmt.Errorf("zfs root %s: %w", dataset, err)
		return
	}
	// Any cipher other than "off" means the dataset is encrypted at rest,
	// whether or not its key is currently loaded.
	protected := encryption != "off"
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
		"mount":      "/",
		"device":     dataset,
		"method":     method,
		"protected":  protected,
		"encryption": encryption,
	}
	if keystatus != "" && keystatus != "-" {
		vol["status"] = keystatus
	}
	report.Volumes = append(report.Volumes, vol)
	report.RootProtected = protected
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

// rootMountFromProcMounts returns the source and fstype of the effective "/"
// mount. /proc/self/mounts lists mounts in mount order, so the last entry
// for "/" is the one that shadows the others.
func rootMountFromProcMounts(procMounts string) (source, fstype string, ok bool) {
	for _, line := range strings.Split(procMounts, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 || fields[1] != "/" {
			continue
		}
		source, fstype, ok = fields[0], fields[2], true
	}
	return source, fstype, ok
}

// parseZfsEncryptionProps parses `zfs get -H -o property,value
// encryption,keystatus <dataset>` output.
func parseZfsEncryptionProps(output string) (encryption, keystatus string, err error) {
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		switch fields[0] {
		case "encryption":
			encryption = strings.ToLower(fields[1])
		case "keystatus":
			keystatus = strings.ToLower(fields[1])
		}
	}
	if encryption == "" || encryption == "-" {
		return "", "", fmt.Errorf("zfs get: encryption property missing from output %q", strings.TrimSpace(output))
	}
	return encryption, keystatus, nil
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

	report, err := evaluateLinuxEncryption(output, procMounts, func(dataset string) (string, error) {
		if !hasCommand("zfs") {
			return "", fmt.Errorf("zfs command not found")
		}
		return runCommandStdout(5*time.Second, "zfs", "get", "-H", "-o", "property,value", "encryption,keystatus", dataset)
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
		return "", fmt.Errorf("command timed out: %s", name)
	}
	if err != nil {
		return "", fmt.Errorf("command failed: %s: %w: %s", name, err, strings.TrimSpace(stderr.String()))
	}
	return strings.TrimSpace(string(output)), nil
}
