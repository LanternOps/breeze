package layout

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// flexInt64 decodes a JSON number, a quoted number (util-linux < 2.37) or
// null.
type flexInt64 int64

func (f *flexInt64) UnmarshalJSON(b []byte) error {
	s := strings.Trim(strings.TrimSpace(string(b)), `"`)
	if s == "" || s == "null" {
		*f = 0
		return nil
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return fmt.Errorf("lsblk numeric field %q: %w", s, err)
	}
	*f = flexInt64(v)
	return nil
}

// flexBool decodes true/false, "0"/"1", "true"/"false" or null.
type flexBool bool

func (f *flexBool) UnmarshalJSON(b []byte) error {
	s := strings.Trim(strings.TrimSpace(string(b)), `"`)
	switch s {
	case "1", "true":
		*f = true
	default:
		*f = false
	}
	return nil
}

type lsblkNode struct {
	Name       string      `json:"name"`
	Path       string      `json:"path"`
	Type       string      `json:"type"`
	Size       flexInt64   `json:"size"`
	Model      *string     `json:"model"`
	Serial     *string     `json:"serial"`
	RM         flexBool    `json:"rm"`
	PTType     *string     `json:"pttype"`
	PartType   *string     `json:"parttype"`
	PartUUID   *string     `json:"partuuid"`
	PartFlags  *string     `json:"partflags"`
	FSType     *string     `json:"fstype"`
	UUID       *string     `json:"uuid"`
	Label      *string     `json:"label"`
	MountPoint *string     `json:"mountpoint"`
	FSUsed     flexInt64   `json:"fsused"`
	Start      flexInt64   `json:"start"`
	LogSec     flexInt64   `json:"log-sec"`
	Children   []lsblkNode `json:"children"`
}

type lsblkDoc struct {
	BlockDevices []lsblkNode `json:"blockdevices"`
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return strings.TrimSpace(*p)
}

// parseLsblk converts `lsblk -J -b -o lsblkColumns` output into Disks.
// Only TYPE=disk nodes become disks (rom/loop/zram are skipped). Partition
// children become Partitions; deeper children (lvm, crypt, raid*) are
// flattened under the same disk with Kind set and Number 0, so the guard can
// see them.
func parseLsblk(data []byte) ([]Disk, error) {
	var doc lsblkDoc
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("decode lsblk json: %w", err)
	}
	if len(doc.BlockDevices) == 0 {
		return nil, errors.New("lsblk reported no block devices")
	}
	var disks []Disk
	for _, dev := range doc.BlockDevices {
		if dev.Type != "disk" {
			continue
		}
		sector := int(dev.LogSec)
		if sector <= 0 {
			sector = 512
		}
		d := Disk{
			Name:       devicePath(dev),
			Model:      str(dev.Model),
			Serial:     str(dev.Serial),
			SizeBytes:  int64(dev.Size),
			SectorSize: sector,
			TableType:  tableType(str(dev.PTType)),
			Removable:  bool(dev.RM),
			Partitions: []Partition{},
		}
		for _, child := range dev.Children {
			appendLinuxChild(&d, child, sector)
		}
		disks = append(disks, d)
	}
	assignLinuxRoles(disks)
	return disks, nil
}

func devicePath(n lsblkNode) string {
	if n.Path != "" {
		return n.Path
	}
	return "/dev/" + n.Name
}

func tableType(pttype string) string {
	switch strings.ToLower(pttype) {
	case "gpt":
		return "gpt"
	case "dos", "mbr":
		return "mbr"
	case "":
		return "none"
	default:
		return "unknown"
	}
}

func appendLinuxChild(d *Disk, n lsblkNode, sector int) {
	p := Partition{
		Name:       devicePath(n),
		TypeGUID:   strings.ToLower(str(n.PartType)),
		PartUUID:   str(n.PartUUID),
		StartBytes: int64(n.Start) * int64(sector),
		SizeBytes:  int64(n.Size),
		UsedBytes:  int64(n.FSUsed),
		Filesystem: str(n.FSType),
		FSUUID:     str(n.UUID),
		Label:      str(n.Label),
		MountPoint: str(n.MountPoint),
		Encryption: EncryptionNone,
		Role:       RoleUnknown,
	}
	if flags := str(n.PartFlags); flags != "" {
		p.Flags = strings.Split(flags, ",")
	}
	if n.Type == "part" {
		p.Number = partitionNumberFromName(n.Name)
	} else {
		p.Kind = n.Type
		p.StartBytes = 0
	}
	if strings.EqualFold(p.Filesystem, "crypto_LUKS") || n.Type == "crypt" {
		p.Encryption = EncryptionLUKS
	}
	d.Partitions = append(d.Partitions, p)
	for _, grand := range n.Children {
		appendLinuxChild(d, grand, sector)
	}
}

var trailingDigits = regexp.MustCompile(`p?(\d+)$`)

// partitionNumberFromName extracts the partition number from a kernel
// name: sda1 → 1, nvme0n1p3 → 3, mmcblk0p2 → 2. Non-partitions → 0.
func partitionNumberFromName(name string) int {
	m := trailingDigits.FindStringSubmatch(name)
	if m == nil {
		return 0
	}
	// Reject a bare disk name whose digits are part of the base (nvme0n1, loop0).
	base := strings.TrimSuffix(name, m[0])
	if base == "" || strings.HasSuffix(base, "nvme0n") || !strings.ContainsAny(base, "abcdefghijklmnopqrstuvwxyz") {
		return 0
	}
	if strings.HasPrefix(name, "nvme") && !strings.Contains(name, "p") {
		return 0
	}
	n, _ := strconv.Atoi(m[1])
	return n
}

// assignLinuxRoles fills Partition.Role and Disk.IsSystem from GPT type
// GUIDs, filesystems and mount points.
func assignLinuxRoles(disks []Disk) {
	for i := range disks {
		d := &disks[i]
		for j := range d.Partitions {
			p := &d.Partitions[j]
			fs := strings.ToLower(p.Filesystem)
			switch {
			case p.TypeGUID == GUIDEFISystem, fs == "vfat" && (p.MountPoint == "/boot/efi" || p.MountPoint == "/efi"):
				p.Role = RoleEFI
			case p.MountPoint == "/":
				p.Role = RoleRoot
				d.IsSystem = true
			case p.MountPoint == "/boot":
				p.Role = RoleBoot
			case fs == "swap", p.TypeGUID == GUIDLinuxSwap:
				p.Role = RoleSwap
			case p.MountPoint != "" || fs != "":
				p.Role = RoleData
			}
		}
	}
}

var efiEntryRe = regexp.MustCompile(`^Boot([0-9A-Fa-f]{4})(\*?)\s+(.*?)\t(.*)$`)

// parseEFIBootMgr parses `efibootmgr -v`. Entries without a tab (no device
// path) still parse with an empty Path.
func parseEFIBootMgr(out string) []EFIEntry {
	var entries []EFIEntry
	current := ""
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.HasPrefix(line, "BootCurrent:") {
			current = strings.TrimSpace(strings.TrimPrefix(line, "BootCurrent:"))
			continue
		}
		if !strings.HasPrefix(line, "Boot") || len(line) < 8 {
			continue
		}
		m := efiEntryRe.FindStringSubmatch(line)
		if m == nil {
			// "Boot0003  Label" with no device path.
			rest := line[4:]
			if len(rest) < 4 {
				continue
			}
			num := rest[:4]
			if _, err := strconv.ParseUint(num, 16, 16); err != nil {
				continue
			}
			rest = rest[4:]
			active := strings.HasPrefix(rest, "*")
			entries = append(entries, EFIEntry{BootNum: num, Label: strings.TrimSpace(strings.TrimPrefix(rest, "*")), Active: active, Current: num == current})
			continue
		}
		entries = append(entries, EFIEntry{BootNum: m[1], Label: strings.TrimSpace(m[3]), Path: strings.TrimSpace(m[4]), Active: m[2] == "*", Current: m[1] == current})
	}
	return entries
}

// parseOSRelease returns PRETTY_NAME, falling back to NAME.
func parseOSRelease(s string) string {
	var name string
	for _, line := range strings.Split(s, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		v = strings.Trim(v, `"'`)
		switch k {
		case "PRETTY_NAME":
			return v
		case "NAME":
			name = v
		}
	}
	return name
}
