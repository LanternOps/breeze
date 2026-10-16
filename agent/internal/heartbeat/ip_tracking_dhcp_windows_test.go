//go:build windows

package heartbeat

import (
	"context"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// TestReadDHCPEnabledAliasesIPHelperMatchesGetNetIPInterface checks the
// in-process read (#7765) against the PowerShell source it replaces, on a real
// Windows host: for every IPv4 interface both report, the DHCP state must agree.
// CI runs it in a must-not-skip step (ci.yml, "Run Windows DHCP state test").
func TestReadDHCPEnabledAliasesIPHelperMatchesGetNetIPInterface(t *testing.T) {
	got, err := readDHCPEnabledAliasesIPHelper()
	if err != nil {
		t.Fatalf("in-process read failed: %v", err)
	}
	if len(got) == 0 {
		t.Fatal("in-process read returned no IPv4 adapters")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command",
		`Get-NetIPInterface -AddressFamily IPv4 | ForEach-Object { "$($_.InterfaceAlias)|$($_.Dhcp)" }`).CombinedOutput()
	if err != nil {
		t.Fatalf("Get-NetIPInterface failed: %v\n%s", err, out)
	}

	compared := 0
	for _, line := range strings.Split(string(out), "\n") {
		alias, state, ok := strings.Cut(strings.TrimSpace(line), "|")
		if !ok {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(alias))
		mine, found := got[key]
		if !found {
			t.Logf("Get-NetIPInterface alias %q not in GetAdaptersAddresses output; not compared", alias)
			continue
		}
		want := strings.EqualFold(strings.TrimSpace(state), "Enabled")
		if mine != want {
			t.Errorf("alias %q: in-process DHCP=%v, Get-NetIPInterface Dhcp=%s", alias, mine, state)
		}
		compared++
	}
	if compared == 0 {
		t.Fatalf("no interface was reported by both sources; in-process=%v powershell=%q", got, out)
	}
	t.Logf("compared %d IPv4 interfaces; in-process map: %v", compared, got)
}
