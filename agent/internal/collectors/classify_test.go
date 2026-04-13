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
