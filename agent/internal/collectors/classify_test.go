package collectors

import "testing"

func TestClassifyDeviceRole(t *testing.T) {
	tests := []struct {
		name string
		sys  *SystemInfo
		hw   *HardwareInfo
		want string
	}{
		{
			name: "windows server 2022 on hyper-v VM (chassis=3 desktop) is server",
			sys:  &SystemInfo{OSVersion: "Microsoft Windows Server 2022 Datacenter"},
			hw:   &HardwareInfo{ChassisType: "3", Manufacturer: "Microsoft Corporation", Model: "Virtual Machine"},
			want: "server",
		},
		{
			name: "windows server 2019 standard on VMware (chassis=3) is server",
			sys:  &SystemInfo{OSVersion: "Microsoft Windows Server 2019 Standard"},
			hw:   &HardwareInfo{ChassisType: "3", Manufacturer: "VMware, Inc.", Model: "VMware Virtual Platform"},
			want: "server",
		},
		{
			name: "windows 11 pro desktop is workstation",
			sys:  &SystemInfo{OSVersion: "Microsoft Windows 11 Pro"},
			hw:   &HardwareInfo{ChassisType: "3"},
			want: "workstation",
		},
		{
			name: "laptop chassis is workstation",
			sys:  &SystemInfo{OSVersion: "Microsoft Windows 10 Pro"},
			hw:   &HardwareInfo{ChassisType: "10"},
			want: "workstation",
		},
		{
			name: "rack mount chassis with workstation OS is server",
			sys:  &SystemInfo{OSVersion: "Microsoft Windows 10 Pro"},
			hw:   &HardwareInfo{ChassisType: "17"},
			want: "server",
		},
		{
			name: "dell poweredge model heuristic is server",
			sys:  &SystemInfo{OSVersion: "Microsoft Windows 11 Pro"},
			hw:   &HardwareInfo{Model: "PowerEdge R740"},
			want: "server",
		},
		{
			name: "synology model heuristic is nas",
			sys:  &SystemInfo{OSVersion: "DSM 7.2"},
			hw:   &HardwareInfo{Model: "Synology DS920+"},
			want: "nas",
		},
		{
			name: "nil hardware with windows server OS is server",
			sys:  &SystemInfo{OSVersion: "Microsoft Windows Server 2022 Datacenter"},
			hw:   nil,
			want: "server",
		},
		{
			name: "nil inputs default to workstation",
			sys:  nil,
			hw:   nil,
			want: "workstation",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := ClassifyDeviceRole(tc.sys, tc.hw)
			if got != tc.want {
				t.Errorf("ClassifyDeviceRole() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestClassifyVirtualization(t *testing.T) {
	tests := []struct {
		name         string
		hw           *HardwareInfo
		wantVirtual  bool
		wantPlatform string
	}{
		{
			name:         "vmware manufacturer + model",
			hw:           &HardwareInfo{Manufacturer: "VMware, Inc.", Model: "VMware Virtual Platform"},
			wantVirtual:  true,
			wantPlatform: "vmware",
		},
		{
			name:         "vmware modern model string (VMware20,1)",
			hw:           &HardwareInfo{Manufacturer: "VMware, Inc.", Model: "VMware20,1"},
			wantVirtual:  true,
			wantPlatform: "vmware",
		},
		{
			name:         "hyper-v: microsoft manufacturer + Virtual Machine model",
			hw:           &HardwareInfo{Manufacturer: "Microsoft Corporation", Model: "Virtual Machine"},
			wantVirtual:  true,
			wantPlatform: "hyperv",
		},
		{
			name:         "virtualbox via innotek manufacturer",
			hw:           &HardwareInfo{Manufacturer: "innotek GmbH", Model: "VirtualBox"},
			wantVirtual:  true,
			wantPlatform: "virtualbox",
		},
		{
			name:         "qemu manufacturer",
			hw:           &HardwareInfo{Manufacturer: "QEMU", Model: "Standard PC (Q35 + ICH9, 2009)"},
			wantVirtual:  true,
			wantPlatform: "qemu",
		},
		{
			name:         "kvm product name",
			hw:           &HardwareInfo{Manufacturer: "Red Hat", Model: "KVM"},
			wantVirtual:  true,
			wantPlatform: "kvm",
		},
		{
			name:         "xen HVM domU model",
			hw:           &HardwareInfo{Manufacturer: "Xen", Model: "HVM domU"},
			wantVirtual:  true,
			wantPlatform: "xen",
		},
		{
			name:         "parallels virtual platform (mac VDI)",
			hw:           &HardwareInfo{Manufacturer: "Parallels Software International Inc.", Model: "Parallels Virtual Platform"},
			wantVirtual:  true,
			wantPlatform: "parallels",
		},
		{
			name:         "marker matched in BIOS vendor string when model is generic",
			hw:           &HardwareInfo{Manufacturer: "", Model: "Standard PC", BIOSVersion: "SeaBIOS / VirtualBox"},
			wantVirtual:  true,
			wantPlatform: "virtualbox",
		},
		{
			name:         "physical Microsoft Surface is NOT virtual (model is not Virtual Machine)",
			hw:           &HardwareInfo{Manufacturer: "Microsoft Corporation", Model: "Surface Laptop 5"},
			wantVirtual:  false,
			wantPlatform: "",
		},
		{
			name:         "physical Dell workstation is not virtual",
			hw:           &HardwareInfo{Manufacturer: "Dell Inc.", Model: "OptiPlex 7090"},
			wantVirtual:  false,
			wantPlatform: "",
		},
		{
			name:         "physical Apple Mac is not virtual",
			hw:           &HardwareInfo{Manufacturer: "Apple", Model: "MacBookPro18,3"},
			wantVirtual:  false,
			wantPlatform: "",
		},
		{
			name:         "case-insensitive match (lowercased vendor string)",
			hw:           &HardwareInfo{Manufacturer: "vmware, inc.", Model: "vmware7,1"},
			wantVirtual:  true,
			wantPlatform: "vmware",
		},
		{
			name:         "nil hardware is not virtual",
			hw:           nil,
			wantVirtual:  false,
			wantPlatform: "",
		},
		{
			name:         "empty hardware is not virtual",
			hw:           &HardwareInfo{},
			wantVirtual:  false,
			wantPlatform: "",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := ClassifyVirtualization(tc.hw)
			if got.IsVirtual != tc.wantVirtual {
				t.Errorf("ClassifyVirtualization().IsVirtual = %v, want %v", got.IsVirtual, tc.wantVirtual)
			}
			if got.Platform != tc.wantPlatform {
				t.Errorf("ClassifyVirtualization().Platform = %q, want %q", got.Platform, tc.wantPlatform)
			}
		})
	}
}
