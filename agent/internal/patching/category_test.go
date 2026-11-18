package patching

import (
	"errors"
	"testing"
)

func TestReportedWindowsUpdateType(t *testing.T) {
	tests := []struct {
		name       string
		updateType string
		category   string
		kind       DriverKind
		want       string
	}{
		{"plain driver", UpdateTypeDriver, "driver", DriverKindDriver, ReportedUpdateTypeDriver},
		{"driver class says firmware", UpdateTypeDriver, "driver", DriverKindFirmware, ReportedUpdateTypeFirmware},
		{"firmware classification on a driver", UpdateTypeDriver, "firmware", DriverKindDriver, ReportedUpdateTypeFirmware},
		// The type is a fact about the update. Whether a security classification
		// keeps it with Windows Update is the API's decision, which reads the category.
		{"security classification keeps its type", UpdateTypeDriver, "security", DriverKindDriver, ReportedUpdateTypeDriver},
		// The category string alone never makes a driver: the product category
		// "Windows 10 and later upgrade & servicing drivers" classifies as driver.
		{"driver category on software", UpdateTypeSoftware, "driver", DriverKindDriver, ReportedUpdateTypeOther},
		{"firmware category on software", UpdateTypeSoftware, "firmware", DriverKindDriver, ReportedUpdateTypeOther},
		{"security update", UpdateTypeSoftware, "security", DriverKindDriver, ReportedUpdateTypeQuality},
		{"update rollup", UpdateTypeSoftware, "system", DriverKindDriver, ReportedUpdateTypeQuality},
		{"definitions", UpdateTypeSoftware, "definitions", DriverKindDriver, ReportedUpdateTypeDefinition},
		{"feature release", UpdateTypeFeature, "feature", DriverKindDriver, ReportedUpdateTypeFeature},
		{"feature pack on software", UpdateTypeSoftware, "feature", DriverKindDriver, ReportedUpdateTypeFeature},
		{"unclassified", UpdateTypeSoftware, "application", DriverKindDriver, ReportedUpdateTypeOther},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := reportedWindowsUpdateType(tt.updateType, tt.category, tt.kind); got != tt.want {
				t.Errorf("reportedWindowsUpdateType(%q, %q, %q) = %q, want %q", tt.updateType, tt.category, tt.kind, got, tt.want)
			}
		})
	}
}

// The scan's read goes through one function so it can be tested off Windows. An
// argument swap at the call site would report every driver as "other".
func TestReportedWindowsUpdate(t *testing.T) {
	props := func(m map[string]string) func(string) (string, error) {
		return func(property string) (string, error) {
			v, ok := m[property]
			if !ok {
				return "", errors.New("unreadable")
			}
			return v, nil
		}
	}
	tests := []struct {
		name       string
		updateType string
		category   string
		title      string
		read       map[string]string
		wantType   string
		wantOwner  string
	}{
		{
			"a Dell driver", UpdateTypeDriver, "driver", "Dell - Network",
			map[string]string{"DriverManufacturer": "Dell Inc.", "DriverClass": "Net", "DriverModel": "Wireless"},
			ReportedUpdateTypeDriver, "dell",
		},
		{
			"a Dell BIOS capsule", UpdateTypeDriver, "driver", "Dell Inc. - Firmware - 1.2.3",
			map[string]string{"DriverManufacturer": "Dell Inc.", "DriverClass": "Firmware", "DriverModel": "System Firmware"},
			ReportedUpdateTypeFirmware, "dell",
		},
		{
			"an Intel driver has no lane owner", UpdateTypeDriver, "driver", "Intel - Display",
			map[string]string{"DriverManufacturer": "Intel", "DriverClass": "Display", "DriverModel": "Iris"},
			ReportedUpdateTypeDriver, "",
		},
		{
			"a Surface driver", UpdateTypeDriver, "driver", "Surface - System",
			map[string]string{"DriverManufacturer": "Microsoft Corporation", "DriverClass": "System", "DriverModel": "Surface Laptop 5"},
			ReportedUpdateTypeDriver, "surface",
		},
		{
			"an unreadable class is firmware, and no lane can be shown to own it", UpdateTypeDriver, "driver", "Dell - Something",
			map[string]string{"DriverManufacturer": "Dell", "DriverModel": "X"},
			ReportedUpdateTypeFirmware, "",
		},
		{
			"an unreadable manufacturer has no owner", UpdateTypeDriver, "driver", "Unknown",
			map[string]string{"DriverClass": "Net", "DriverModel": "X"},
			ReportedUpdateTypeDriver, "",
		},
		{
			"software never reads driver properties", UpdateTypeSoftware, "security", "Cumulative",
			nil,
			ReportedUpdateTypeQuality, "",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			read := props(tt.read)
			if tt.read == nil {
				read = func(property string) (string, error) {
					t.Fatalf("read %s on a non-driver update", property)
					return "", nil
				}
			}
			gotType, gotOwner := reportedWindowsUpdate(tt.updateType, tt.category, tt.title, read)
			if gotType != tt.wantType || gotOwner != tt.wantOwner {
				t.Errorf("reportedWindowsUpdate = (%q, %q), want (%q, %q)", gotType, gotOwner, tt.wantType, tt.wantOwner)
			}
		})
	}
}

func TestDriverUpdateOwner(t *testing.T) {
	tests := []struct {
		maker, class, model, want string
	}{
		{"Dell", "System", "", "dell"},
		{"dell inc", "Video", "", "dell"},
		{"Dell Inc.", "Firmware", "", "dell"},
		{"HP", "Net", "", "hp"},
		{"HP Inc.", "Sound", "", "hp"},
		{"Hewlett-Packard", " system ", "", "hp"},
		{"LENOVO", "Bluetooth", "", "lenovo"},
		{"Lenovo", "System Firmware", "", "lenovo"},
		{"Surface", "", "", "surface"},
		{"Surface", "Printers", "", "surface"},
		{"Microsoft Corporation", "System", "Surface Book 3", "surface"},
		// The vendor's name on a peripheral: a PC lane's catalog need not carry it,
		// and a class nobody has seen yet gets the same answer.
		{"HP", "Printers", "", ""},
		{"Dell", "Monitor", "", ""},
		{"Dell", "Imaging", "", ""},
		{"Lenovo", "Dock", "", ""},
		{"HP", "", "", ""},
		{"HP", "  ", "", ""},
		// Near-misses reach no lane, as on the API's own lane match.
		{"Dell EMC", "System", "", ""},
		{"HPE", "System", "", ""},
		{"Hewlett Packard Enterprise", "System", "", ""},
		{"CHP Systems", "System", "", ""},
		{"Microsoft Corporation", "System", "Virtual Machine", ""},
		{"Microsoft", "System", "Generic", ""},
		{"Intel", "System", "", ""},
		{"", "System", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.maker+"/"+tt.class+"/"+tt.model, func(t *testing.T) {
			got := driverUpdateOwner(DriverUpdate{DriverManufacturer: tt.maker, DriverClass: tt.class, DriverModel: tt.model})
			if got != tt.want {
				t.Errorf("driverUpdateOwner(%q, %q, %q) = %q, want %q", tt.maker, tt.class, tt.model, got, tt.want)
			}
		})
	}
}

func TestClassifyWindowsUpdateCategory(t *testing.T) {
	tests := []struct {
		name  string
		names []string
		want  string
	}{
		{"empty", nil, "application"},
		{"unknown only", []string{"Windows 11"}, "application"},
		{"security classification", []string{"Security Updates"}, "security"},
		{"critical is security", []string{"Critical Updates"}, "security"},
		{"driver", []string{"Drivers"}, "driver"},
		{"firmware", []string{"Firmware"}, "firmware"},
		{"definition (singular WUA name) -> definitions", []string{"Definition Updates"}, "definitions"},
		{"feature", []string{"Feature Packs"}, "feature"},
		// WUA files Windows feature releases ("Windows 11, version 25H2") under the
		// Upgrades classification; rings govern them through the feature category.
		{"upgrades -> feature", []string{"Windows 11", "Upgrades"}, "feature"},
		{"upgrade & servicing drivers product category stays driver", []string{"Windows 10 and later upgrade & servicing drivers", "Drivers"}, "driver"},
		{"service pack -> system", []string{"Service Packs"}, "system"},
		{"update rollup -> system", []string{"Update Rollups"}, "system"},
		// The core fix: product name first, real classification second — must NOT
		// land on "application".
		{"product name then security", []string{"Windows 11", "Security Updates"}, "security"},
		{"product name then driver", []string{"Windows 10", "Drivers"}, "driver"},
		// Specificity ordering: security outranks driver when both present.
		{"security beats driver", []string{"Drivers", "Security Updates"}, "security"},
		// firmware outranks driver when both present.
		{"firmware beats driver", []string{"Drivers", "Firmware"}, "firmware"},
		{"case insensitive", []string{"SECURITY UPDATES"}, "security"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := classifyWindowsUpdateCategory(tt.names); got != tt.want {
				t.Errorf("classifyWindowsUpdateCategory(%q) = %q, want %q", tt.names, got, tt.want)
			}
		})
	}
}
