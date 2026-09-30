package security

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
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
// with NAME,TYPE,FSTYPE,MOUNTPOINT[,MOUNTPOINTS]; procMounts is the content of
// /proc/self/mounts; zfsProps runs `zfs get` for a dataset. It returns an
// error only when the lsblk output itself is unusable.
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

	var walk func(node lsblkEncryptionNode, inheritedProtected bool)
	walk = func(node lsblkEncryptionNode, inheritedProtected bool) {
		isProtected := inheritedProtected || lsblkNodeIsEncryptionLayer(node)
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
				// A device can be listed under several parents (e.g. md RAID
				// members); only call root protected if every path is.
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
	if !ok || fstype != "zfs" {
		report.RootErr = errors.New("root filesystem not found in lsblk output")
		if ok {
			report.RootErr = fmt.Errorf("root filesystem (%s on %s) not found in lsblk output", fstype, source)
		}
		return report, nil
	}

	out, err := zfsProps(source)
	if err != nil {
		report.RootErr = fmt.Errorf("zfs root %s: %w", source, err)
		return report, nil
	}
	encryption, keystatus, err := parseZfsEncryptionProps(out)
	if err != nil {
		report.RootErr = fmt.Errorf("zfs root %s: %w", source, err)
		return report, nil
	}
	// Any cipher other than "off" means the dataset is encrypted at rest,
	// whether or not its key is currently loaded.
	protected := encryption != "off"
	method := "none"
	if protected {
		method = "zfs"
	}
	vol := map[string]any{
		"mount":      "/",
		"device":     source,
		"method":     method,
		"protected":  protected,
		"encryption": encryption,
	}
	if keystatus != "" && keystatus != "-" {
		vol["status"] = keystatus
	}
	report.Volumes = append(report.Volumes, vol)
	report.RootProtected = protected
	return report, nil
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
	output, err := runCommand(8*time.Second, "lsblk", "-J", "-o", "NAME,TYPE,FSTYPE,MOUNTPOINT,MOUNTPOINTS")
	if err != nil {
		// util-linux < 2.37 has no MOUNTPOINTS column and rejects the
		// whole invocation; retry with the single-mountpoint column.
		output, err = runCommand(8*time.Second, "lsblk", "-J", "-o", "NAME,TYPE,FSTYPE,MOUNTPOINT")
		if err != nil {
			return linuxEncryptionReport{}, err
		}
	}

	procMounts := ""
	if data, readErr := os.ReadFile("/proc/self/mounts"); readErr == nil {
		procMounts = string(data)
	}

	return evaluateLinuxEncryption(output, procMounts, func(dataset string) (string, error) {
		if !hasCommand("zfs") {
			return "", fmt.Errorf("zfs command not found")
		}
		return runCommand(5*time.Second, "zfs", "get", "-H", "-o", "property,value", "encryption,keystatus", dataset)
	})
}
