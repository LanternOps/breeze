package collectors

import "strings"

// ClassifyDeviceRole determines the device role from system info and hardware data.
func ClassifyDeviceRole(sysInfo *SystemInfo, hw *HardwareInfo) string {
	// 1. OS edition: Windows Server / Datacenter. Checked first because virtualized
	// Windows Server installs (Hyper-V, VMware, etc.) often report SMBIOS chassis
	// type 3 (Desktop), which would otherwise mis-classify them as workstations.
	if sysInfo != nil {
		osLower := strings.ToLower(sysInfo.OSVersion)
		if strings.Contains(osLower, "server") || strings.Contains(osLower, "datacenter") {
			return "server"
		}
	}

	// 2. Chassis type (DMI SMBIOS codes)
	if hw != nil && hw.ChassisType != "" {
		switch hw.ChassisType {
		case "3", "4", "6", "7", "13", "35", // Desktop, Low-Profile Desktop, Mini Tower, Tower, All-in-One, Mini PC
			"8", "9", "10", "14", // Portable, Laptop, Notebook, Sub-Notebook
			"31", "32", "30": // Convertible, Detachable, Tablet
			return "workstation"
		case "17", "23", "28", "29": // Rack Mount Chassis, Main Server, Blade, Blade Enclosure
			return "server"
		case "11": // Hand Held
			return "phone"
		}
	}

	// 3. Model name heuristics
	if hw != nil {
		model := strings.ToLower(hw.Model)
		for _, kw := range []string{"poweredge", "proliant", "primergy", "system x"} {
			if strings.Contains(model, kw) {
				return "server"
			}
		}
		for _, kw := range []string{"synology", "qnap", "readynas"} {
			if strings.Contains(model, kw) {
				return "nas"
			}
		}
		for _, kw := range []string{"fortigate", "pfsense"} {
			if strings.Contains(model, kw) {
				return "firewall"
			}
		}
	}

	// 4. Linux server detection via /etc/os-release and systemd default target
	if detectLinuxServer() {
		return "server"
	}

	return "workstation"
}

// VirtualizationInfo is the orthogonal "is this a VM, and on what hypervisor"
// attribute derived from the same hardware identity strings (Manufacturer /
// Model / BIOS) already collected for role classification. It is intentionally
// separate from device role: a virtual box is still a workstation (or server)
// and must keep matching its role-based policies — virtualization is a second
// targeting axis, not a role. See issue #1387.
type VirtualizationInfo struct {
	// IsVirtual is true when the host is running on a hypervisor.
	IsVirtual bool
	// Platform is the detected hypervisor, lowercased and normalized to a
	// small known set (vmware / hyperv / virtualbox / qemu / kvm / xen /
	// parallels). Empty when IsVirtual is false, or when the host is virtual
	// but the specific platform could not be identified.
	Platform string
}

// virtualizationPlatform holds the normalized platform token plus the
// case-insensitive substrings (matched against Manufacturer/Model/BIOS) that
// identify it. Order matters: the first matching entry wins, so more specific
// vendors are listed before generic ones.
type virtualizationMarker struct {
	platform string
	needles  []string
}

// virtualizationMarkers are the SMBIOS identity strings real hypervisors stamp
// into Win32_ComputerSystem (Manufacturer/Model), Linux DMI (sys_vendor /
// product_name), and the BIOS vendor string. These values are well-documented
// and stable across the major hypervisors.
var virtualizationMarkers = []virtualizationMarker{
	// VMware: Manufacturer "VMware, Inc.", Model "VMware Virtual Platform" /
	// "VMware7,1", "VMware20,1".
	{platform: "vmware", needles: []string{"vmware"}},
	// VirtualBox: Manufacturer "innotek GmbH", Model "VirtualBox", BIOS
	// vendor "innotek GmbH".
	{platform: "virtualbox", needles: []string{"virtualbox", "innotek"}},
	// Parallels (Mac VDI / Desktop): "Parallels Software International" /
	// Model "Parallels Virtual Platform".
	{platform: "parallels", needles: []string{"parallels"}},
	// QEMU (incl. libvirt): Manufacturer "QEMU", Model "Standard PC (...)" with
	// BIOS vendor "SeaBIOS"/"QEMU". Listed before kvm/xen since QEMU is the
	// most specific identifier when present.
	{platform: "qemu", needles: []string{"qemu"}},
	// KVM: some guests report Manufacturer "KVM" or product "KVM".
	{platform: "kvm", needles: []string{"kvm"}},
	// Xen: Manufacturer "Xen", Model "HVM domU".
	{platform: "xen", needles: []string{"xen", "hvm domu"}},
	// Bochs (rare, used by some cloud/emulation stacks).
	{platform: "bochs", needles: []string{"bochs"}},
	// Hyper-V: Manufacturer "Microsoft Corporation" + Model "Virtual Machine".
	// Microsoft is ALSO the manufacturer of physical Surface hardware, so this
	// marker is the model string ("virtual machine"), never the manufacturer
	// alone — handled specially below so a physical Surface is not flagged.
	{platform: "hyperv", needles: []string{"virtual machine"}},
}

// ClassifyVirtualization derives the orthogonal virtual/VDI hardware attribute
// from hardware identity strings. It is a pure function (no syscalls) so it is
// fully unit-testable and produces identical results on every platform — the
// underlying Manufacturer/Model/BIOS strings are already collected per-OS by
// CollectHardware. Returns the zero value (not virtual, no platform) when hw is
// nil or carries no recognizable markers.
func ClassifyVirtualization(hw *HardwareInfo) VirtualizationInfo {
	if hw == nil {
		return VirtualizationInfo{}
	}

	manufacturer := strings.ToLower(hw.Manufacturer)
	model := strings.ToLower(hw.Model)
	bios := strings.ToLower(hw.BIOSVersion)
	mbManufacturer := strings.ToLower(hw.MotherboardManufacturer)
	// Single haystack so a marker can match in any identity field.
	haystack := strings.Join([]string{manufacturer, model, bios, mbManufacturer}, " ")

	for _, marker := range virtualizationMarkers {
		for _, needle := range marker.needles {
			if strings.Contains(haystack, needle) {
				return VirtualizationInfo{IsVirtual: true, Platform: marker.platform}
			}
		}
	}

	return VirtualizationInfo{}
}
