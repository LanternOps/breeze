package collectors

import "testing"

func TestClassifySystemLogEntry(t *testing.T) {
	tests := []struct {
		name     string
		provider string
		eventID  int
		want     string
	}{
		// Storage / filesystem providers -> hardware
		{"disk bad block", "disk", 7, "hardware"},
		{"Disk capitalised", "Disk", 11, "hardware"},
		{"ntfs corruption", "Ntfs", 55, "hardware"},
		{"ntfs case-insensitive", "Microsoft-Windows-Ntfs", 98, "hardware"},
		{"volmgr", "volmgr", 46, "hardware"},
		{"volsnap", "volsnap", 25, "hardware"},
		{"storahci", "storahci", 129, "hardware"},
		{"stornvme", "stornvme", 11, "hardware"},
		{"intel rst iaStorA", "iaStorA", 9, "hardware"},
		{"intel rst iaStorAVC", "iaStorAVC", 129, "hardware"},
		// Machine-check / thermal -> hardware
		{"whea logger", "Microsoft-Windows-WHEA-Logger", 17, "hardware"},
		{"whea logger short", "WHEA-Logger", 18, "hardware"},
		{"kernel whea", "Microsoft-Windows-Kernel-WHEA", 20, "hardware"},
		{"thermal provider", "Microsoft-Windows-Thermal-Polling", 1, "hardware"},
		{"thermal provider lowercase", "thermalzone", 2, "hardware"},
		// Everything else -> system
		{"service control manager", "Service Control Manager", 7000, "system"},
		{"dcom", "Microsoft-Windows-DistributedCOM", 10016, "system"},
		{"kernel pnp", "Microsoft-Windows-Kernel-PnP", 219, "system"},
		{"kernel boot", "Microsoft-Windows-Kernel-Boot", 29, "system"},
		{"kernel power unexpected shutdown", "Microsoft-Windows-Kernel-Power", 41, "system"},
		{"netlogon", "NETLOGON", 5719, "system"},
		{"dns client", "Microsoft-Windows-DNS-Client", 1014, "system"},
		{"time service", "Microsoft-Windows-Time-Service", 36, "system"},
		{"group policy", "Microsoft-Windows-GroupPolicy", 1129, "system"},
		{"winrm", "Microsoft-Windows-WinRM", 10149, "system"},
		{"schannel", "Schannel", 36887, "system"},
		// "disk" must match as a provider, not as a substring of an unrelated one
		{"diskdiagnostic is not the disk driver", "Microsoft-Windows-DiskDiagnostic", 1, "system"},
		{"empty provider", "", 0, "system"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := classifySystemLogEntry(tt.provider, tt.eventID); got != tt.want {
				t.Fatalf("classifySystemLogEntry(%q, %d) = %q, want %q", tt.provider, tt.eventID, got, tt.want)
			}
		})
	}
}

func TestSystemLogCategoryFor(t *testing.T) {
	tests := []struct {
		name       string
		categories []string
		provider   string
		eventID    int
		wantCat    string
		wantKeep   bool
	}{
		{"hardware entry, hardware only", []string{"hardware"}, "disk", 7, "hardware", true},
		{"system entry, hardware only is dropped", []string{"hardware"}, "Service Control Manager", 7000, "system", false},
		{"system entry, system only", []string{"system"}, "Service Control Manager", 7000, "system", true},
		{"hardware entry, system only is dropped", []string{"system"}, "disk", 7, "hardware", false},
		{"both enabled keeps hardware", []string{"hardware", "system"}, "Ntfs", 55, "hardware", true},
		{"both enabled keeps system", []string{"hardware", "system"}, "Schannel", 36887, "system", true},
		{"neither enabled", []string{"security", "application"}, "disk", 7, "hardware", false},
		{"nil categories", nil, "disk", 7, "hardware", false},
		// Power IDs are owned by collectPowerEvents (which runs whenever
		// "system" is enabled); the error query must not emit them again.
		{"kernel-power 41 left to power collector", []string{"system"}, "Microsoft-Windows-Kernel-Power", 41, "system", false},
		{"eventlog 6008 left to power collector", []string{"hardware", "system"}, "EventLog", 6008, "system", false},
		{"non-power system id still kept", []string{"system"}, "Microsoft-Windows-Kernel-Power", 42, "system", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cat, keep := systemLogCategoryFor(tt.categories, tt.provider, tt.eventID)
			if cat != tt.wantCat || keep != tt.wantKeep {
				t.Fatalf("systemLogCategoryFor(%v, %q, %d) = (%q, %v), want (%q, %v)",
					tt.categories, tt.provider, tt.eventID, cat, keep, tt.wantCat, tt.wantKeep)
			}
		})
	}
}

func TestSystemLogQueryEnabled(t *testing.T) {
	tests := []struct {
		categories []string
		want       bool
	}{
		{[]string{"hardware"}, true},
		{[]string{"system"}, true},
		{[]string{"hardware", "system"}, true},
		{[]string{"security", "application"}, false},
		{nil, false},
	}
	for _, tt := range tests {
		if got := systemLogQueryEnabled(tt.categories); got != tt.want {
			t.Fatalf("systemLogQueryEnabled(%v) = %v, want %v", tt.categories, got, tt.want)
		}
	}
}
