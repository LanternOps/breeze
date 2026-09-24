package hwhealth

import (
	"errors"
	"strings"
	"testing"
)

func TestBMCFixtures(t *testing.T) {
	for _, tc := range []struct {
		kind                             Kind
		network, info, name, ip, mac, fw string
	}{
		{"ipmi", "lan.txt", "info.txt", "iDRAC", "192.0.2.10", "02:00:00:00:00:10", "2.80"},
		{"racadm", "nic.txt", "version.txt", "iDRAC", "192.0.2.11", "02:00:00:00:00:11", "7.10.30.00"},
		{"hponcfg", "export.txt", "", "iLO", "192.0.2.12", "02:00:00:00:00:12", "2.99"},
	} {
		t.Run(string(tc.kind), func(t *testing.T) {
			var info []byte
			if tc.info != "" {
				info = fixture(t, string(tc.kind), tc.info)
			}
			c, err := parseBMC(tc.kind, fixture(t, string(tc.kind), tc.network), info)
			if err != nil {
				t.Fatal(err)
			}
			if c.ComponentKey != "bmc:"+string(tc.kind) || c.ComponentType != "bmc" || c.Source != tc.kind || c.Name != tc.name || c.State != "ok" {
				t.Fatalf("%+v", c)
			}
			if c.Attributes["ip"] != tc.ip || c.Attributes["mac"] != tc.mac || c.Firmware == nil || *c.Firmware != tc.fw {
				t.Fatalf("%+v", c)
			}
			if len(c.Attributes) != 3 {
				t.Fatal("non-allowlisted export data", c.Attributes)
			}
		})
	}
}

func TestBMCNoHardwareAndMalformed(t *testing.T) {
	for _, tc := range []struct {
		kind Kind
		file string
	}{
		{"ipmi", "no-bmc.txt"}, {"ipmi", "driver-missing.txt"},
		{"racadm", "no-bmc.txt"}, {"hponcfg", "no-bmc.txt"},
	} {
		if _, err := parseBMC(tc.kind, fixture(t, string(tc.kind), tc.file), nil); !errors.Is(err, errNoBMC) {
			t.Fatalf("%s: %v", tc.file, err)
		}
	}
	for _, raw := range [][]byte{nil, []byte("unrecognized output"), fixture(t, "hponcfg", "malformed.txt"), []byte(strings.Repeat("x", 4*1024*1024+1))} {
		if _, err := parseBMC("hponcfg", raw, nil); err == nil {
			t.Fatal("accepted invalid export")
		}
	}
}

func TestBMCHPEFirmwareBanner(t *testing.T) {
	c, err := parseBMC("hponcfg", []byte(`<RIBCL><IP_ADDRESS VALUE="192.0.2.12"/><MAC_ADDRESS VALUE="02:00:00:00:00:12"/></RIBCL>`), []byte("Firmware Revision = 2.99\nDevice type = iLO"))
	if err != nil || c.Firmware == nil || *c.Firmware != "2.99" {
		t.Fatal(c, err)
	}
}

func TestBMCUnknownVendorAndAbsentOptionalFacts(t *testing.T) {
	c, err := parseBMC("ipmi", []byte("IP Address : 0.0.0.0\nMAC Address : 00:00:00:00:00:00"), []byte("Device ID : 32\nManufacturer Name : Future Vendor"))
	if err != nil || c.Name != "BMC" || c.Firmware != nil {
		t.Fatal(c, err)
	}
	if c.Attributes["ip"] != "" || c.Attributes["mac"] != "" {
		t.Fatal(c.Attributes)
	}
	c, err = parseBMC("ipmi", fixture(t, "ipmi", "lan.txt"), []byte("Manufacturer Name : Lenovo\nFirmware Revision : 1"))
	if err != nil || c.Name != "XClarity Controller" {
		t.Fatal(c, err)
	}
}
