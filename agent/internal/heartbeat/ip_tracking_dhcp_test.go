package heartbeat

import (
	"errors"
	"testing"
)

// stubDHCPSources swaps the in-process DHCP reader and the PowerShell
// fallback for the duration of a test and counts calls to each (#7765).
func stubDHCPSources(t *testing.T, inProcess func() (map[string]bool, error), fallback func() (map[string]bool, error)) (inProcessCalls, fallbackCalls *int) {
	t.Helper()
	origReader, origFallback := readDHCPEnabledAliases, readDHCPEnabledAliasesPowerShell
	t.Cleanup(func() {
		readDHCPEnabledAliases, readDHCPEnabledAliasesPowerShell = origReader, origFallback
	})
	dhcpInProcessFailureLogged.Store(false)
	t.Cleanup(func() { dhcpInProcessFailureLogged.Store(false) })
	in, fb := 0, 0
	readDHCPEnabledAliases = func() (map[string]bool, error) { in++; return inProcess() }
	readDHCPEnabledAliasesPowerShell = func() (map[string]bool, error) { fb++; return fallback() }
	return &in, &fb
}

func TestWindowsDHCPLeaseEvidence_InProcessReadDoesNotSpawnPowerShell(t *testing.T) {
	in, fb := stubDHCPSources(t,
		func() (map[string]bool, error) {
			return map[string]bool{"ethernet": true, "wi-fi": false}, nil
		},
		func() (map[string]bool, error) {
			t.Fatal("PowerShell fallback must not run when the in-process read succeeds")
			return nil, nil
		},
	)

	if !windowsDHCPLeaseEvidence("Ethernet", "192.168.1.20") {
		t.Fatal("Ethernet has DHCP enabled: want true")
	}
	if windowsDHCPLeaseEvidence("Wi-Fi", "192.168.1.21") {
		t.Fatal("Wi-Fi has DHCP disabled: want false")
	}
	if windowsDHCPLeaseEvidence("Unknown Adapter", "192.168.1.22") {
		t.Fatal("alias absent from the adapter list: want false")
	}
	if *in != 3 || *fb != 0 {
		t.Fatalf("calls: in-process=%d fallback=%d, want 3 and 0", *in, *fb)
	}
}

func TestWindowsDHCPLeaseEvidence_AliasMatchIsCaseAndSpaceInsensitive(t *testing.T) {
	stubDHCPSources(t,
		func() (map[string]bool, error) { return map[string]bool{"ethernet 2": true}, nil },
		func() (map[string]bool, error) { return nil, errors.New("unused") },
	)
	if !windowsDHCPLeaseEvidence("  ETHERNET 2 ", "10.0.0.5") {
		t.Fatal("alias match must ignore case and surrounding space, as the PowerShell path did")
	}
}

func TestWindowsDHCPLeaseEvidence_FallsBackToPowerShellWhenInProcessReadFails(t *testing.T) {
	in, fb := stubDHCPSources(t,
		func() (map[string]bool, error) {
			return nil, errors.New("GetAdaptersAddresses: ERROR_NOT_ENOUGH_MEMORY")
		},
		func() (map[string]bool, error) { return map[string]bool{"ethernet": true}, nil },
	)
	if !windowsDHCPLeaseEvidence("Ethernet", "192.168.1.20") {
		t.Fatal("fallback reports DHCP enabled: want true")
	}
	if *in != 1 || *fb != 1 {
		t.Fatalf("calls: in-process=%d fallback=%d, want 1 and 1", *in, *fb)
	}
}

func TestWindowsDHCPLeaseEvidence_BothSourcesFailingReportsNoEvidence(t *testing.T) {
	stubDHCPSources(t,
		func() (map[string]bool, error) { return nil, errors.New("in-process failed") },
		func() (map[string]bool, error) { return nil, errors.New("powershell failed") },
	)
	if windowsDHCPLeaseEvidence("Ethernet", "192.168.1.20") {
		t.Fatal("no source answered: want false (hasDHCPLease then applies its name heuristic)")
	}
}

func TestParseDHCPEnabledAliasesPowerShellOutput(t *testing.T) {
	got := parseDHCPEnabledAliases([]byte("Ethernet\r\n  Wi-Fi \r\n\r\n"))
	if !got["ethernet"] || !got["wi-fi"] || len(got) != 2 {
		t.Fatalf("got %v, want ethernet and wi-fi only", got)
	}
}

func TestWindowsDHCPLeaseEvidence_EmptyAdapterListIsAnAnswerNotAFailure(t *testing.T) {
	// ERROR_NO_DATA (no adapter has IPv4) maps to an empty map, not an error:
	// no evidence, and no PowerShell spawn.
	_, fb := stubDHCPSources(t,
		func() (map[string]bool, error) { return map[string]bool{}, nil },
		func() (map[string]bool, error) { return map[string]bool{"ethernet": true}, nil },
	)
	if windowsDHCPLeaseEvidence("Ethernet", "192.168.1.20") {
		t.Fatal("empty in-process answer: want false")
	}
	if *fb != 0 {
		t.Fatalf("fallback ran %d times, want 0", *fb)
	}
}

func TestWindowsDHCPLeaseEvidence_SuccessReArmsFailureWarning(t *testing.T) {
	fail := true
	stubDHCPSources(t,
		func() (map[string]bool, error) {
			if fail {
				return nil, errors.New("in-process failed")
			}
			return map[string]bool{}, nil
		},
		func() (map[string]bool, error) { return map[string]bool{}, nil },
	)
	windowsDHCPLeaseEvidence("Ethernet", "192.168.1.20")
	if !dhcpInProcessFailureLogged.Load() {
		t.Fatal("first failure must arm the warn-once gate")
	}
	fail = false
	windowsDHCPLeaseEvidence("Ethernet", "192.168.1.20")
	if dhcpInProcessFailureLogged.Load() {
		t.Fatal("a successful read must re-arm the gate so a later failure warns again")
	}
}
