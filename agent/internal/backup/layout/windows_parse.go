package layout

import (
	"encoding/json"
	"fmt"
	"strings"
)

// windowsLayoutScript is run by the Windows collector through
// `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`.
// Get-BitLockerVolume is absent on editions without the BitLocker module, so
// it is best-effort and reported as Incomplete "bitlocker".
const windowsLayoutScript = `$ErrorActionPreference='Stop'
$disks = @(Get-Disk | Select-Object Number,FriendlyName,SerialNumber,Size,PartitionStyle,IsSystem,IsBoot,LogicalSectorSize,BusType)
$parts = @(Get-Partition | Select-Object DiskNumber,PartitionNumber,Guid,GptType,Offset,Size,DriveLetter,IsSystem,IsBoot,IsActive,IsHidden,Type,AccessPaths)
$vols  = @(Get-Volume | Select-Object DriveLetter,Path,UniqueId,FileSystem,FileSystemLabel,Size,SizeRemaining)
$bl = $null
try { $bl = @(Get-BitLockerVolume | Select-Object MountPoint,ProtectionStatus) } catch { $bl = $null }
[pscustomobject]@{
  firmware = [string]$env:firmware_type
  os       = (Get-CimInstance Win32_OperatingSystem).Caption
  hostname = $env:COMPUTERNAME
  disks = $disks; partitions = $parts; volumes = $vols; bitlocker = $bl
} | ConvertTo-Json -Depth 6 -Compress`

type winDisk struct {
	Number            int    `json:"Number"`
	FriendlyName      string `json:"FriendlyName"`
	SerialNumber      string `json:"SerialNumber"`
	Size              int64  `json:"Size"`
	PartitionStyle    string `json:"PartitionStyle"`
	IsSystem          bool   `json:"IsSystem"`
	IsBoot            bool   `json:"IsBoot"`
	LogicalSectorSize int    `json:"LogicalSectorSize"`
	BusType           string `json:"BusType"`
}

type winPartition struct {
	DiskNumber      int             `json:"DiskNumber"`
	PartitionNumber int             `json:"PartitionNumber"`
	Guid            *string         `json:"Guid"`
	GptType         *string         `json:"GptType"`
	Offset          int64           `json:"Offset"`
	Size            int64           `json:"Size"`
	DriveLetter     json.RawMessage `json:"DriveLetter"`
	IsSystem        bool            `json:"IsSystem"`
	IsBoot          bool            `json:"IsBoot"`
	IsActive        bool            `json:"IsActive"`
	IsHidden        bool            `json:"IsHidden"`
	Type            string          `json:"Type"`
	AccessPaths     []string        `json:"AccessPaths"`
}

type winVolume struct {
	DriveLetter     json.RawMessage `json:"DriveLetter"`
	Path            string          `json:"Path"`
	UniqueId        string          `json:"UniqueId"`
	FileSystem      string          `json:"FileSystem"`
	FileSystemLabel string          `json:"FileSystemLabel"`
	Size            int64           `json:"Size"`
	SizeRemaining   int64           `json:"SizeRemaining"`
}

type winBitLocker struct {
	MountPoint       string          `json:"MountPoint"`
	ProtectionStatus json.RawMessage `json:"ProtectionStatus"`
}

type winLayoutDoc struct {
	Firmware   string          `json:"firmware"`
	OS         string          `json:"os"`
	Hostname   string          `json:"hostname"`
	Disks      []winDisk       `json:"disks"`
	Partitions []winPartition  `json:"partitions"`
	Volumes    []winVolume     `json:"volumes"`
	BitLocker  json.RawMessage `json:"bitlocker"`
}

// driveLetter decodes PowerShell's [char] DriveLetter: "C", "\u0000", "", null, or 0.
func driveLetter(raw json.RawMessage) string {
	s := strings.Trim(strings.TrimSpace(string(raw)), `"`)
	if s == "" || s == "null" || s == "0" || s == `\u0000` || s == "\x00" {
		return ""
	}
	return strings.ToUpper(s[:1])
}

func normalizeGUID(p *string) string {
	if p == nil {
		return ""
	}
	return strings.ToLower(strings.Trim(strings.TrimSpace(*p), "{}"))
}

func removableBus(bus string) bool {
	switch strings.ToUpper(bus) {
	case "USB", "SD", "MMC", "1394":
		return true
	}
	return false
}

// parseWindowsLayout converts the script's JSON into a Manifest.
func parseWindowsLayout(data []byte) (*Manifest, error) {
	var doc winLayoutDoc
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("decode windows layout json: %w", err)
	}
	m := &Manifest{SchemaVersion: SchemaVersion, Platform: "windows", OSRelease: doc.OS, Hostname: doc.Hostname, BootMode: BootModeBIOS}
	if strings.EqualFold(doc.Firmware, "UEFI") {
		m.BootMode = BootModeUEFI
	}

	volByPath := map[string]winVolume{}
	volByLetter := map[string]winVolume{}
	for _, v := range doc.Volumes {
		if v.Path != "" {
			volByPath[strings.ToLower(v.Path)] = v
		}
		if v.UniqueId != "" {
			volByPath[strings.ToLower(v.UniqueId)] = v
		}
		if l := driveLetter(v.DriveLetter); l != "" {
			volByLetter[l] = v
		}
	}

	bitlocked := map[string]bool{}
	var bl []winBitLocker
	if len(doc.BitLocker) == 0 || string(doc.BitLocker) == "null" {
		m.Incomplete = append(m.Incomplete, "bitlocker")
	} else if err := json.Unmarshal(doc.BitLocker, &bl); err != nil {
		m.Incomplete = append(m.Incomplete, "bitlocker")
	} else {
		for _, b := range bl {
			status := strings.Trim(strings.TrimSpace(string(b.ProtectionStatus)), `"`)
			if status == "1" || strings.EqualFold(status, "On") {
				bitlocked[strings.ToUpper(strings.TrimSuffix(b.MountPoint, ":"))] = true
			}
		}
	}

	byDisk := map[int]*Disk{}
	for _, d := range doc.Disks {
		disk := Disk{
			Name:       fmt.Sprintf(`\\.\PHYSICALDRIVE%d`, d.Number),
			Model:      d.FriendlyName,
			Serial:     strings.TrimSpace(d.SerialNumber),
			SizeBytes:  d.Size,
			SectorSize: d.LogicalSectorSize,
			TableType:  tableType(d.PartitionStyle),
			Removable:  removableBus(d.BusType),
			IsSystem:   d.IsBoot,
			Partitions: []Partition{},
		}
		if disk.SectorSize == 0 {
			disk.SectorSize = 512
		}
		if strings.EqualFold(d.PartitionStyle, "RAW") {
			disk.TableType = "none"
		}
		m.Disks = append(m.Disks, disk)
	}
	// Index by disk number only after every disk has been appended: taking
	// &m.Disks[i] earlier is unsafe because a later append can reallocate
	// the backing array and silently strand the pointer.
	for i := range m.Disks {
		byDisk[doc.Disks[i].Number] = &m.Disks[i]
	}

	for _, p := range doc.Partitions {
		disk, ok := byDisk[p.DiskNumber]
		if !ok {
			continue
		}
		part := Partition{
			Number:     p.PartitionNumber,
			Name:       fmt.Sprintf(`\\.\PHYSICALDRIVE%d#%d`, p.DiskNumber, p.PartitionNumber),
			TypeGUID:   normalizeGUID(p.GptType),
			PartUUID:   normalizeGUID(p.Guid),
			StartBytes: p.Offset,
			SizeBytes:  p.Size,
			Encryption: EncryptionNone,
			Role:       RoleUnknown,
		}
		letter := driveLetter(p.DriveLetter)
		if letter != "" {
			part.MountPoint = letter + `:\`
		}
		if p.IsActive {
			part.Flags = append(part.Flags, "active")
		}
		if p.IsHidden {
			part.Flags = append(part.Flags, "hidden")
		}
		var vol *winVolume
		if letter != "" {
			if v, ok := volByLetter[letter]; ok {
				vol = &v
			}
		}
		if vol == nil {
			for _, ap := range p.AccessPaths {
				if v, ok := volByPath[strings.ToLower(ap)]; ok {
					vol = &v
					break
				}
			}
		}
		if vol != nil {
			part.Filesystem = strings.ToLower(vol.FileSystem)
			part.Label = vol.FileSystemLabel
			part.FSUUID = strings.Trim(strings.TrimPrefix(strings.ToLower(vol.UniqueId), `\\?\volume{`), `}\`)
			if vol.Size > 0 && vol.Size >= vol.SizeRemaining {
				part.UsedBytes = vol.Size - vol.SizeRemaining
			}
		}
		if letter != "" && bitlocked[letter] {
			part.Encryption = EncryptionBitLocker
		}
		switch {
		case part.TypeGUID == GUIDEFISystem, strings.EqualFold(p.Type, "System") && disk.TableType == "gpt":
			part.Role = RoleEFI
		case part.TypeGUID == GUIDMicrosoftMSR, strings.EqualFold(p.Type, "Reserved"):
			part.Role = RoleMSR
		case part.TypeGUID == GUIDWindowsRecovery, strings.EqualFold(p.Type, "Recovery"):
			part.Role = RoleRecovery
		case p.IsBoot, part.MountPoint == `C:\`:
			part.Role = RoleRoot
			disk.IsSystem = true
		case part.Filesystem != "" || part.MountPoint != "":
			part.Role = RoleData
		}
		disk.Partitions = append(disk.Partitions, part)
	}
	return m, nil
}
