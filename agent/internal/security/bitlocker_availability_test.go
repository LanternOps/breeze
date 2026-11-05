package security

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// fakeBitLockerHost stands in for a Windows host's BitLocker surface (#10902).
// Every PowerShell spawn the security package makes for BitLocker goes
// through runBitLockerPowerShell, so spawns records exactly what would have
// been launched on a real host.
type fakeBitLockerHost struct {
	moduleInstalled bool
	getCommandOut   string
	getCommandErr   error
	statusOut       string
	statusErr       error
	volumesOut      string
	volumesErr      error
	keysOut         string
	keysErr         error

	spawns []string
}

func (f *fakeBitLockerHost) count(script string) int {
	n := 0
	for _, s := range f.spawns {
		if s == script {
			n++
		}
	}
	return n
}

// installFakeBitLockerHost swaps in a fresh availability probe on a fake
// clock and a fake PowerShell, and resets the cached posture probes.
func installFakeBitLockerHost(t *testing.T, host *fakeBitLockerHost) *time.Time {
	t.Helper()
	now := time.Unix(1_700_000_000, 0)

	prevProbe, prevRun := bitLockerAvailability, runBitLockerPowerShell
	probe := newBitLockerAvailabilityProbe()
	probe.now = func() time.Time { return now }
	probe.moduleInstalled = func() bool { return host.moduleInstalled }
	bitLockerAvailability = probe
	runBitLockerPowerShell = func(_ time.Duration, script string) (string, error) {
		host.spawns = append(host.spawns, script)
		switch script {
		case bitLockerGetCommandPS:
			return host.getCommandOut, host.getCommandErr
		case bitLockerSystemDriveStatusPS:
			return host.statusOut, host.statusErr
		case bitLockerVolumesPS:
			return host.volumesOut, host.volumesErr
		case bitlockerKeyProtectorPS:
			return host.keysOut, host.keysErr
		default:
			return "", fmt.Errorf("unexpected PowerShell script: %s", script)
		}
	}
	invalidateSlowPostureProbes()
	t.Cleanup(func() {
		bitLockerAvailability, runBitLockerPowerShell = prevProbe, prevRun
		invalidateSlowPostureProbes()
	})
	return &now
}

// Windows Server without the BitLocker feature and Windows Home have neither
// the BitLocker module nor the Get-BitLockerVolume cmdlet. None of the three
// Get-BitLockerVolume probes may spawn — in particular not the
// recovery-password query MDR products flag — and the state is reported as
// "unsupported", not as a collection error.
func TestBitLockerUnavailableSkipsAllProbes(t *testing.T) {
	for _, tc := range []struct {
		name          string
		getCommandOut string
	}{
		{name: "windows server without bitlocker feature", getCommandOut: "unavailable"},
		{name: "windows home", getCommandOut: "unavailable\r\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			host := &fakeBitLockerHost{moduleInstalled: false, getCommandOut: tc.getCommandOut}
			installFakeBitLockerHost(t, host)

			for range 3 { // three security ticks
				enabled, details, err := collectEncryptionPostureFor("windows")
				if !errors.Is(err, ErrBitLockerUnavailable) {
					t.Fatalf("posture err = %v, want ErrBitLockerUnavailable", err)
				}
				if enabled || details != nil {
					t.Fatalf("posture = %v, %v; want false, nil", enabled, details)
				}
				if got := encryptionString(enabled, err); got != "unsupported" {
					t.Fatalf("encryptionString = %q, want unsupported", got)
				}

				keys, err := collectRecoveryKeysFor("windows")
				if !errors.Is(err, ErrBitLockerUnavailable) || keys != nil {
					t.Fatalf("recovery keys = %v, %v; want nil, ErrBitLockerUnavailable", keys, err)
				}
			}
			// Uncached reads (CIS/remediation, slow-probe error-TTL refetch)
			// are gated too.
			if _, err := getEncryptionStatusWindows(); !errors.Is(err, ErrBitLockerUnavailable) {
				t.Fatalf("getEncryptionStatusWindows err = %v", err)
			}
			if _, err := collectEncryptionDetailsWindows(); !errors.Is(err, ErrBitLockerUnavailable) {
				t.Fatalf("collectEncryptionDetailsWindows err = %v", err)
			}

			if len(host.spawns) != 1 || host.spawns[0] != bitLockerGetCommandPS {
				t.Fatalf("spawns = %q, want exactly one availability check", host.spawns)
			}
		})
	}
}

func TestBitLockerAvailableUnencryptedBehavesAsBefore(t *testing.T) {
	host := &fakeBitLockerHost{
		moduleInstalled: true,
		statusOut:       "Off",
		volumesOut:      `{"MountPoint":"C:","ProtectionStatus":"Off","EncryptionMethod":"None","VolumeStatus":"FullyDecrypted","EncryptionPercentage":0}`,
		keysOut:         "[]",
	}
	installFakeBitLockerHost(t, host)

	enabled, details, err := collectEncryptionPostureFor("windows")
	if err != nil || enabled {
		t.Fatalf("posture = %v, %v; want false, nil", enabled, err)
	}
	if got := encryptionString(enabled, err); got != "unencrypted" {
		t.Fatalf("encryptionString = %q, want unencrypted", got)
	}
	if details["source"] != "bitlocker" {
		t.Fatalf("details = %#v", details)
	}
	keys, err := collectRecoveryKeysFor("windows")
	if err != nil || len(keys) != 0 {
		t.Fatalf("recovery keys = %v, %v; want empty, nil", keys, err)
	}
	// The module is on disk, so availability costs no spawn.
	if n := host.count(bitLockerGetCommandPS); n != 0 {
		t.Fatalf("availability spawns = %d, want 0 when the module is installed", n)
	}
	for _, script := range []string{bitLockerSystemDriveStatusPS, bitLockerVolumesPS, bitlockerKeyProtectorPS} {
		if n := host.count(script); n != 1 {
			t.Fatalf("spawns of %q = %d, want 1", script, n)
		}
	}
}

func TestBitLockerAvailableEncryptedEscrowsProtectors(t *testing.T) {
	host := &fakeBitLockerHost{
		moduleInstalled: true,
		statusOut:       "1",
		volumesOut:      `{"MountPoint":"C:","ProtectionStatus":"On","EncryptionMethod":"XtsAes128","VolumeStatus":"FullyEncrypted","EncryptionPercentage":100}`,
		keysOut:         `[{"Mount":"c:","ProtectorId":"{11111111-2222-3333-4444-555555555555}","RecoveryPassword":"111111-222222-333333-444444-555555-666666-777777-888888"}]`,
	}
	installFakeBitLockerHost(t, host)

	enabled, _, err := collectEncryptionPostureFor("windows")
	if got := encryptionString(enabled, err); got != "encrypted" {
		t.Fatalf("encryptionString = %q (err %v), want encrypted", got, err)
	}
	keys, err := collectRecoveryKeysFor("windows")
	if err != nil || len(keys) != 1 {
		t.Fatalf("recovery keys = %v, %v; want one key", keys, err)
	}
	if keys[0].Mount != "C:" || keys[0].ProtectorID != "11111111-2222-3333-4444-555555555555" || keys[0].KeyType != KeyTypeBitLocker {
		t.Fatalf("key = %+v", keys[0])
	}
}

// On a host that has BitLocker, a failing probe is a real failure: it must
// still surface as an error ("unknown"), never be masked as "unsupported".
func TestBitLockerAvailableRealFailureStillSurfaces(t *testing.T) {
	boom := errors.New("command timed out: powershell")
	host := &fakeBitLockerHost{moduleInstalled: true, statusErr: boom, volumesErr: boom, keysErr: boom}
	installFakeBitLockerHost(t, host)

	enabled, _, err := collectEncryptionPostureFor("windows")
	if !errors.Is(err, boom) || errors.Is(err, ErrBitLockerUnavailable) {
		t.Fatalf("posture err = %v, want the probe failure", err)
	}
	if got := encryptionString(enabled, err); got != "unknown" {
		t.Fatalf("encryptionString = %q, want unknown", got)
	}
	if _, err := collectRecoveryKeysFor("windows"); !errors.Is(err, boom) || errors.Is(err, ErrBitLockerUnavailable) {
		t.Fatalf("recovery keys err = %v, want the probe failure", err)
	}
}

// If the availability check itself fails (PowerShell cold start timing out),
// nothing is assumed: the probes run as they did before the gate, and the
// check is retried after slowProbeErrorTTL rather than the long TTL.
func TestBitLockerAvailabilityIndeterminateFallsThrough(t *testing.T) {
	host := &fakeBitLockerHost{
		moduleInstalled: false,
		getCommandErr:   errors.New("command timed out: powershell"),
		keysOut:         "[]",
	}
	now := installFakeBitLockerHost(t, host)

	if _, err := collectRecoveryKeysFor("windows"); err != nil {
		t.Fatalf("recovery keys err = %v, want the probe to run", err)
	}
	if n := host.count(bitlockerKeyProtectorPS); n != 1 {
		t.Fatalf("key protector spawns = %d, want 1 (indeterminate must not skip)", n)
	}
	_, _ = collectRecoveryKeysFor("windows")
	if n := host.count(bitLockerGetCommandPS); n != 1 {
		t.Fatalf("availability spawns = %d, want 1 within the error TTL", n)
	}
	*now = now.Add(slowProbeErrorTTL)
	_, _ = collectRecoveryKeysFor("windows")
	if n := host.count(bitLockerGetCommandPS); n != 2 {
		t.Fatalf("availability spawns after error TTL = %d, want 2", n)
	}
}

// BitLocker enabled after the agent cached "unavailable" is picked up when the
// long TTL expires.
func TestBitLockerAvailabilityReDetectsAfterTTL(t *testing.T) {
	host := &fakeBitLockerHost{moduleInstalled: false, getCommandOut: "unavailable", keysOut: "[]"}
	now := installFakeBitLockerHost(t, host)

	if _, err := collectRecoveryKeysFor("windows"); !errors.Is(err, ErrBitLockerUnavailable) {
		t.Fatalf("err = %v, want ErrBitLockerUnavailable", err)
	}
	host.moduleInstalled = true // feature installed + rebooted

	*now = now.Add(bitLockerAvailabilityTTL - time.Second)
	if _, err := collectRecoveryKeysFor("windows"); !errors.Is(err, ErrBitLockerUnavailable) {
		t.Fatalf("err before TTL = %v, want cached ErrBitLockerUnavailable", err)
	}
	*now = now.Add(time.Second)
	if _, err := collectRecoveryKeysFor("windows"); err != nil {
		t.Fatalf("err after TTL = %v, want re-detected as available", err)
	}
	if n := host.count(bitlockerKeyProtectorPS); n != 1 {
		t.Fatalf("key protector spawns = %d, want 1 after re-detect", n)
	}
	if bitLockerAvailabilityTTL < 12*time.Hour {
		t.Fatalf("bitLockerAvailabilityTTL = %s; a permanent condition needs a long TTL", bitLockerAvailabilityTTL)
	}
}

// A technician-initiated fresh status (CollectStatusFresh) re-detects
// availability so a just-installed BitLocker shows up immediately.
func TestInvalidateSlowPostureProbesReDetectsAvailability(t *testing.T) {
	host := &fakeBitLockerHost{moduleInstalled: false, getCommandOut: "unavailable", statusOut: "1"}
	installFakeBitLockerHost(t, host)

	if _, err := getEncryptionStatusWindowsCached(); !errors.Is(err, ErrBitLockerUnavailable) {
		t.Fatalf("err = %v, want ErrBitLockerUnavailable", err)
	}
	host.moduleInstalled = true
	invalidateSlowPostureProbes()
	if enabled, err := getEncryptionStatusWindowsCached(); err != nil || !enabled {
		t.Fatalf("after invalidate = %v, %v; want true, nil", enabled, err)
	}
}

func TestEncryptionStringUnsupportedOnlyForSentinel(t *testing.T) {
	if got := encryptionString(false, fmt.Errorf("collect: %w", ErrBitLockerUnavailable)); got != "unsupported" {
		t.Fatalf("wrapped sentinel = %q, want unsupported", got)
	}
	if got := encryptionString(false, errors.New("boom")); got != "unknown" {
		t.Fatalf("other error = %q, want unknown", got)
	}
}

// Output that is neither "available" nor "unavailable" (a profile banner, a
// localized warning) must never close the gate: escrow would stop silently.
func TestBitLockerAvailabilityUnexpectedOutputIsIndeterminate(t *testing.T) {
	for _, out := range []string{"", "WARNING: something\r\nunavailable", "Available"} {
		host := &fakeBitLockerHost{moduleInstalled: false, getCommandOut: out, keysOut: "[]"}
		installFakeBitLockerHost(t, host)
		if _, err := collectRecoveryKeysFor("windows"); err != nil {
			t.Fatalf("output %q: err = %v, want probe to run", out, err)
		}
		if n := host.count(bitlockerKeyProtectorPS); n != 1 {
			t.Fatalf("output %q: key protector spawns = %d, want 1", out, n)
		}
	}
}

// Explicit technician commands (collect keys, rotate) re-detect rather than
// trusting a cached "unavailable" for up to a day.
func TestRedetectBitLockerAvailability(t *testing.T) {
	host := &fakeBitLockerHost{moduleInstalled: false, getCommandOut: "unavailable", keysOut: "[]"}
	installFakeBitLockerHost(t, host)

	if _, err := collectRecoveryKeysFor("windows"); !errors.Is(err, ErrBitLockerUnavailable) {
		t.Fatalf("err = %v, want ErrBitLockerUnavailable", err)
	}
	host.moduleInstalled = true
	RedetectBitLockerAvailability()
	if _, err := collectRecoveryKeysFor("windows"); err != nil {
		t.Fatalf("err after redetect = %v, want available", err)
	}
}

func TestBitLockerModuleInstalled(t *testing.T) {
	root := t.TempDir()
	t.Setenv("SystemRoot", root)
	modules := filepath.Join(root, "System32", "WindowsPowerShell", "v1.0", "Modules")
	if err := os.MkdirAll(modules, 0o755); err != nil {
		t.Fatal(err)
	}
	if bitLockerModuleInstalled() {
		t.Fatal("module dir absent: want false")
	}
	if err := os.WriteFile(filepath.Join(modules, "BitLocker"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if bitLockerModuleInstalled() {
		t.Fatal("BitLocker is a file, not a module dir: want false")
	}
	if err := os.Remove(filepath.Join(modules, "BitLocker")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(modules, "BitLocker"), 0o755); err != nil {
		t.Fatal(err)
	}
	if !bitLockerModuleInstalled() {
		t.Fatal("module dir present: want true")
	}
}

// CollectStatus must not report a host without BitLocker as a collection
// failure, while any other encryption error still is.
func TestApplyEncryptionPosture(t *testing.T) {
	var status SecurityStatus
	if err := applyEncryptionPosture(&status, false, nil, ErrBitLockerUnavailable); err != nil {
		t.Fatalf("unavailable returned err %v, want nil", err)
	}
	if status.EncryptionStatus != "unsupported" {
		t.Fatalf("EncryptionStatus = %q, want unsupported", status.EncryptionStatus)
	}

	boom := errors.New("boom")
	status = SecurityStatus{}
	if err := applyEncryptionPosture(&status, false, nil, boom); !errors.Is(err, boom) {
		t.Fatalf("real failure returned %v, want boom", err)
	}
	if status.EncryptionStatus != "unknown" {
		t.Fatalf("EncryptionStatus = %q, want unknown", status.EncryptionStatus)
	}

	status = SecurityStatus{}
	details := map[string]any{"source": "bitlocker"}
	if err := applyEncryptionPosture(&status, true, details, nil); err != nil || status.EncryptionStatus != "encrypted" || status.EncryptionDetails == nil {
		t.Fatalf("encrypted: err %v, status %+v", err, status)
	}
}
