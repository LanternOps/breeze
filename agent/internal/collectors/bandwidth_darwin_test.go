//go:build darwin

package collectors

import (
	"testing"
	"time"
)

func TestGetLinkSpeedRejectsInvalidInterfaceName(t *testing.T) {
	t.Parallel()

	if got := getLinkSpeed("../bad0"); got != 0 {
		t.Fatalf("getLinkSpeed rejected invalid interface name incorrectly: %d", got)
	}
}

type spawnRecord struct {
	name string
	args []string
}

// Callers must not be parallel: this swaps a package-level probe and the command hook.
func withWiFiSource(t *testing.T, src wifiSpeedSource) *[]spawnRecord {
	t.Helper()
	orig := wifiSpeedSourceProbe
	wifiSpeedSourceProbe = newCachedHostProbe(time.Hour, func() wifiSpeedSource { return src })
	var calls []spawnRecord
	hook := func(name string, args []string) { calls = append(calls, spawnRecord{name, args}) }
	collectorCommandHook.Store(&hook)
	t.Cleanup(func() {
		wifiSpeedSourceProbe = orig
		collectorCommandHook.Store(nil)
	})
	return &calls
}

func TestGetWiFiSpeedNoneSpawnsNothing(t *testing.T) {
	calls := withWiFiSource(t, wifiSpeedNone)
	if got := getWiFiSpeed(); got != 0 {
		t.Fatalf("got %d", got)
	}
	if len(*calls) != 0 {
		t.Fatalf("expected no spawn, got %v", *calls)
	}
}

func TestGetWiFiSpeedWdutilSpawnsOnce(t *testing.T) {
	calls := withWiFiSource(t, wifiSpeedWdutil)
	getWiFiSpeed()
	if len(*calls) != 1 || (*calls)[0].name != wdutilPath || len((*calls)[0].args) != 1 || (*calls)[0].args[0] != "info" {
		t.Fatalf("unexpected spawns: %v", *calls)
	}
}

func TestGetWiFiSpeedAirportSpawnsOnce(t *testing.T) {
	calls := withWiFiSource(t, wifiSpeedAirport)
	getWiFiSpeed()
	if len(*calls) != 1 || (*calls)[0].name != airportPath || len((*calls)[0].args) != 1 || (*calls)[0].args[0] != "-I" {
		t.Fatalf("unexpected spawns: %v", *calls)
	}
}
