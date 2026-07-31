package config

import (
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/spf13/viper"
)

// Finding I2 of the wave-06 whole-branch security review: config.Load mutates
// the package-global viper singleton (SetConfigFile/AddConfigPath/AutomaticEnv/
// ReadInConfig/Unmarshal) and did NOT take persistMu, while SetAndPersist (the
// command worker pool), SaveTo (the cert-renewal goroutine) and
// SetAllAndPersist (backup-URL promotion) write viper from other goroutines.
// Several of the resulting races are MAP races, which in production are not a
// bad value but `fatal error: concurrent map read and map write` — an
// unrecoverable throw that kills the agent process. Wave 6 put Reload on the
// per-heartbeat path (one per successful manifest-key pin, one per delivered
// delegation record), roughly doubling how often the loader runs.
//
// These probes are the falsifiability harness for that fix: they drive a loader
// and a persister concurrently and MUST pass under -race. Revert Load/Reload to
// calling loadLocked's body without the lock and `go test -race
// ./internal/config` reports a data race here.
//
// Not t.Parallel(): they own the viper singleton for their duration.

func writeRaceProbeConfig(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")
	yaml := "agent_id: 00000000-0000-4000-8000-000000000001\n" +
		"server_url: http://localhost\n" +
		"heartbeat_interval_seconds: 60\n" +
		"auto_update: true\n"
	if err := os.WriteFile(cfgPath, []byte(yaml), 0o600); err != nil {
		t.Fatal(err)
	}
	return cfgPath
}

func TestLoadRacesSetAndPersist(t *testing.T) {
	cfgPath := writeRaceProbeConfig(t)
	viper.Reset()
	defer viper.Reset()

	// Bind the singleton to the fixture before the goroutines start, so
	// SetAndPersist has a ConfigFileUsed() to write back to.
	if _, err := Load(cfgPath); err != nil {
		t.Fatalf("initial Load: %v", err)
	}

	const iterations = 60
	var wg sync.WaitGroup
	errs := make(chan error, 2*iterations)

	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < iterations; i++ {
			if _, err := Load(cfgPath); err != nil {
				errs <- err
				return
			}
		}
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < iterations; i++ {
			if err := SetAndPersist("heartbeat_interval_seconds", 30+i%7); err != nil {
				errs <- err
				return
			}
		}
	}()

	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent load/persist: %v", err)
	}
}

func TestReloadRacesSaveTo(t *testing.T) {
	cfgPath := writeRaceProbeConfig(t)
	viper.Reset()
	defer viper.Reset()

	cfg, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("initial Load: %v", err)
	}

	const iterations = 40
	var wg sync.WaitGroup
	errs := make(chan error, 2*iterations)

	// Reload() is the exact call Wave 6 added per successful pin and per
	// delivered delegation record — it reads viper.ConfigFileUsed() and then
	// re-reads the whole singleton.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < iterations; i++ {
			if _, err := Reload(); err != nil {
				errs <- err
				return
			}
		}
	}()

	// SaveTo is the cert-renewal goroutine's call.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < iterations; i++ {
			snapshot := *cfg
			snapshot.MtlsCertExpires = "2030-01-0" + string(rune('1'+i%9)) + "T00:00:00Z"
			if err := SaveTo(&snapshot, cfgPath); err != nil {
				errs <- err
				return
			}
		}
	}()

	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent reload/save: %v", err)
	}
}

// The manifest paths are the ones Wave 6 put on the heartbeat path, and they are
// read-modify-write pairs: the epoch/trust-set decision is only sound if nothing
// can write the config between loadLocked and saveToLocked. This drives them
// against a competing writer.
func TestPinManifestKeysRacesSetAllAndPersist(t *testing.T) {
	cfgPath := writeRaceProbeConfig(t)
	viper.Reset()
	defer viper.Reset()

	if _, err := Load(cfgPath); err != nil {
		t.Fatalf("initial Load: %v", err)
	}

	const iterations = 30
	var wg sync.WaitGroup
	errs := make(chan error, 2*iterations)

	// The SAME key every time: idempotent after the first bootstrap, so this
	// exercises the load+compare path repeatedly without tripping the
	// expansion-rejected rule.
	keys := []ManifestTrustKey{{KeyID: "race-probe-key", PublicKeyB64: testPubKey(9)}}

	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < iterations; i++ {
			if err := PinManifestKeys(cfgPath, keys); err != nil {
				errs <- err
				return
			}
		}
	}()

	// SetAllAndPersist is the backup-URL promotion path.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < iterations; i++ {
			if err := SetAllAndPersist(map[string]any{
				"metrics_interval_seconds": 60 + i%5,
			}); err != nil {
				errs <- err
				return
			}
		}
	}()

	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent pin/persist: %v", err)
	}
}
