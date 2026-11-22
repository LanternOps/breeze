package collectors

import "testing"

func TestMacOSVersionAtLeast(t *testing.T) {
	cases := []struct {
		v            string
		major, minor int
		atLeast, ok  bool
	}{
		{"14.4", 14, 4, true, true},
		{"14.4.1", 14, 4, true, true},
		{"14.3.1", 14, 4, false, true},
		{"15.0", 14, 4, true, true},
		{"27.0.1", 14, 4, true, true},
		{"13.6.7", 14, 4, false, true},
		{"14", 14, 0, true, true},
		{" 14.4\n", 14, 4, true, true},
		{"", 14, 4, false, false},
		{"garbage", 14, 4, false, false},
		{"14.x", 14, 4, false, false},
	}
	for _, c := range cases {
		a, k := macOSVersionAtLeast(c.v, c.major, c.minor)
		if a != c.atLeast || k != c.ok {
			t.Errorf("macOSVersionAtLeast(%q,%d,%d) = %v,%v want %v,%v", c.v, c.major, c.minor, a, k, c.atLeast, c.ok)
		}
	}
}

func TestSelectWiFiSpeedSource(t *testing.T) {
	both := func(string) bool { return true }
	only := func(p string) func(string) bool { return func(x string) bool { return x == p } }
	cases := []struct {
		name    string
		version string
		root    bool
		exists  func(string) bool
		want    wifiSpeedSource
	}{
		{"old with airport", "14.3.1", false, both, wifiSpeedAirport},
		{"old with airport root", "13.0", true, both, wifiSpeedAirport},
		{"unknown with airport", "", false, both, wifiSpeedAirport},
		{"14.4 root wdutil", "14.4", true, both, wifiSpeedWdutil},
		{"14.4.1 root", "14.4.1", true, both, wifiSpeedWdutil},
		{"15 root", "15.0", true, both, wifiSpeedWdutil},
		{"27 root", "27.0.1", true, both, wifiSpeedWdutil},
		{"27 non-root", "27.0.1", false, both, wifiSpeedNone},
		{"14.4 non-root even with airport", "14.4", false, both, wifiSpeedNone},
		{"old, airport missing, root, wdutil", "14.3.1", true, only(wdutilPath), wifiSpeedWdutil},
		{"old, airport missing, non-root", "14.3.1", false, only(wdutilPath), wifiSpeedNone},
		{"unknown, airport missing, root", "", true, only(wdutilPath), wifiSpeedWdutil},
		{"27 root wdutil missing", "27.0.1", true, only(airportPath), wifiSpeedNone},
		{"nothing exists", "14.3.1", true, func(string) bool { return false }, wifiSpeedNone},
	}
	for _, c := range cases {
		if got := selectWiFiSpeedSource(c.version, c.root, c.exists); got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}

func TestParseAirportTxRate(t *testing.T) {
	out := "     agrCtlRSSI: -50\n     lastTxRate: 866\n     maxRate: 867\n"
	if got := parseAirportTxRate(out); got != 866_000_000 {
		t.Fatalf("got %d", got)
	}
	if got := parseAirportTxRate("AirPort: Off\n"); got != 0 {
		t.Fatalf("got %d", got)
	}
}

func TestParseWdutilTxRate(t *testing.T) {
	cases := []struct {
		name, out string
		want      uint64
	}{
		{"connected", "WIFI\n    MAC Address          : aa:bb\n    Tx Rate              : 702.0 Mbps\n    Rx Rate : 1 Mbps\n", 702_000_000},
		{"fractional", "WIFI\n    Tx Rate              : 144.4 Mbps\n", 144_400_000},
		{"no wifi section", "NETWORK\n    Router : 10.0.0.1\n", 0},
		{"disconnected", "WIFI\n    Tx Rate              : None\n", 0},
		{"zero", "WIFI\n    Tx Rate              : 0.0 Mbps\n", 0},
		{"empty", "", 0},
		{"unparsable", "WIFI\n    Tx Rate : fast\n", 0},
		{"later section unrelated", "WIFI\n    SSID : x\n    Tx Rate : 300.0 Mbps\nBLUETOOTH\n    Power : On\nNETWORK\n    DNS : 1.1.1.1\n", 300_000_000},
		{"key in other section only", "WIFI\n    SSID : x\nBLUETOOTH\n    Power : On\n", 0},
	}
	for _, c := range cases {
		if got := parseWdutilTxRate(c.out); got != c.want {
			t.Errorf("%s: got %d want %d", c.name, got, c.want)
		}
	}
}
