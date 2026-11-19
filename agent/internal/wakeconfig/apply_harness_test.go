package wakeconfig

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type applyHarness struct {
	m        *Manager
	collects atomic.Int32
	uploads  atomic.Int32
}

func newApplyHarness(t *testing.T, mach *fakeMachine, w Writer) *applyHarness {
	t.Helper()
	h := &applyHarness{}
	h.m = New(Options{
		Collect: func(ctx context.Context) (Inputs, error) {
			h.collects.Add(1)
			in := winInputs("")
			in.Windows = mach.read()
			return in, nil
		},
		Upload: func(ctx context.Context, s Snapshot) error {
			h.uploads.Add(1)
			return nil
		},
		Writer:          w,
		Reread:          func(ctx context.Context) (*WindowsReadings, error) { return mach.read(), nil },
		BootTime:        func() (time.Time, error) { return t0.Add(-time.Hour), nil },
		StatePath:       filepath.Join(t.TempDir(), StateFileName),
		Interval:        time.Hour,
		testAllowWrites: true,
	})
	// Registered after t.TempDir so it runs first (cleanups are LIFO).
	t.Cleanup(func() { stopAndWait(t, h.m) })
	return h
}

func writeFile(path, s string) error { return os.WriteFile(path, []byte(s), 0o600) }

func TestParseShutdownWake(t *testing.T) {
	r, err := ParseWindowsReadings([]byte(`{"hiberboot":0,"adapters":[
		{"mac":"AA-BB-CC-DD-EE-01","magicPacket":"enabled","eee":null,"s5":"0"},
		{"mac":"AA-BB-CC-DD-EE-02","magicPacket":"enabled","eee":null,"s5":"1"},
		{"mac":"AA-BB-CC-DD-EE-03","magicPacket":"enabled","eee":null,"s5":null},
		{"mac":"AA-BB-CC-DD-EE-04","magicPacket":"enabled","eee":null,"s5":"error"},
		{"mac":"AA-BB-CC-DD-EE-05","magicPacket":"enabled","eee":null}]}`))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"disabled", "enabled", "absent", "unknown", "absent"}
	for i, a := range r.Adapters {
		if a.ShutdownWake != want[i] {
			t.Fatalf("adapter %d: got %q want %q", i, a.ShutdownWake, want[i])
		}
	}
}

func TestReadScriptReadsShutdownWakeByKeyword(t *testing.T) {
	if !strings.Contains(readScript, "-RegistryKeyword 'S5WakeOnLan'") || !strings.Contains(readScript, "s5=$s5") {
		t.Fatal("script must read Realtek shutdown wake by -RegistryKeyword 'S5WakeOnLan' and emit s5")
	}
}

func TestComputeShutdownWakeDisabledIsNotConfigured(t *testing.T) {
	s := Compute(winInputs("disabled", AdapterReading{MAC: "aa:bb:cc:dd:ee:01", MagicPacket: "enabled", EEE: "absent", ShutdownWake: "disabled"}))
	if s.ReadinessState != "not_configured" || !hasReason(s, "nic_shutdown_wake_disabled") {
		t.Fatalf("got %s %v", s.ReadinessState, s.ReasonCodes)
	}
}

// The fingerprint anchors server-side wake proofs and the timeout block, so a
// machine whose readings are unchanged must keep the exact W02 fingerprint
// after this release adds the shutdown-wake reading.
func TestFingerprintStableForUnchangedMachines(t *testing.T) {
	base := winInputs("disabled", goodNIC("aa:bb:cc:dd:ee:01"))
	f0 := Compute(base).Fingerprint
	for _, v := range []string{"", "absent", "enabled"} {
		in := winInputs("disabled", AdapterReading{MAC: "aa:bb:cc:dd:ee:01", MagicPacket: "enabled", EEE: "absent", ShutdownWake: v})
		if got := Compute(in).Fingerprint; got != f0 {
			t.Fatalf("shutdownWake=%q changed the fingerprint", v)
		}
	}
	// Golden values computed by the W02 code (origin/main 190c74a001).
	for i, g := range []struct {
		in    Inputs
		fp    string
		state string
	}{
		{Inputs{OS: "windows", Manufacturer: "Dell Inc.", Model: "OptiPlex 7060", Now: t0,
			Windows: &WindowsReadings{FastStartup: "enabled", Adapters: []AdapterReading{
				{MAC: "aa:bb:cc:dd:ee:01", MagicPacket: "disabled", EEE: "enabled"},
				{MAC: "aa:bb:cc:dd:ee:02", MagicPacket: "enabled", EEE: "absent"}}},
			Memory: AdapterMemory{"aa:bb:cc:dd:ee:09": {LastSeenAt: t0.Add(-48 * time.Hour), MagicPacket: "enabled", EEE: "disabled"}}},
			"cab1f73d9e4ae9ca06cb2df4b091a192613224c72300146c2536f479f1a1d176", "not_configured"},
		{Inputs{OS: "windows", Manufacturer: "Dell Inc.", Model: "OptiPlex 7090", Now: t0,
			Windows: &WindowsReadings{FastStartup: "disabled", Adapters: []AdapterReading{{MAC: "aa:bb:cc:dd:ee:01", MagicPacket: "enabled", EEE: "absent"}}}},
			"f3ac8e4c9e7b520d2074eb5832621b4d70c9f88cfcdbe2d2732168eccf5e3dc6", "unproven"},
	} {
		s := Compute(g.in)
		if s.Fingerprint != g.fp || s.ReadinessState != g.state {
			t.Fatalf("golden %d drifted from W02: %s %s", i, s.Fingerprint, s.ReadinessState)
		}
	}
	// Apply status that does not change the state must not move it either.
	in := winInputs("disabled", goodNIC("aa:bb:cc:dd:ee:01"))
	in.Apply = &ApplyStatus{Configure: true, LastApplyAt: t0, LastApplyResult: "ok"}
	if Compute(in).Fingerprint != f0 {
		t.Fatal("apply bookkeeping moved the fingerprint")
	}
}

func TestAdapterRecordWithoutShutdownWakeLoadsAsAbsent(t *testing.T) {
	var mem AdapterMemory
	if err := json.Unmarshal([]byte(`{"aa:bb:cc:dd:ee:01":{"lastSeenAt":"2026-11-15T11:00:00Z","magicPacket":"enabled","eee":"absent"}}`), &mem); err != nil {
		t.Fatal(err)
	}
	in := winInputs("disabled")
	in.Memory = mem
	if s := Compute(in); s.ReadinessState != "unproven" {
		t.Fatalf("W02 memory record: got %s %v", s.ReadinessState, s.ReasonCodes)
	}
}

// Parses (never runs) every write script with the real PowerShell parser.
func TestWriteScriptsParseUnderPwsh(t *testing.T) {
	pwsh, err := exec.LookPath("pwsh")
	if err != nil {
		if runtime.GOOS == "linux" && os.Getenv("CI") != "" {
			t.Fatal("pwsh not found on the Linux CI runner")
		}
		t.Skip("pwsh not installed")
	}
	for _, kind := range []OpKind{OpMagicPacketOn, OpEEEOff, OpShutdownWakeOn} {
		s, err := writeScript(Op{Kind: kind, MAC: "aa:bb:cc:dd:ee:01"})
		if err != nil {
			t.Fatal(err)
		}
		// The script travels as an environment variable and is only parsed.
		check := `$e=$null; $t=$null; $ast=[System.Management.Automation.Language.Parser]::ParseInput($env:BREEZE_WAKE_SCRIPT,[ref]$t,[ref]$e);
if ($e.Count -gt 0) { $e | ForEach-Object { $_.Message }; exit 3 }
$cmds=@($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object { $_.GetCommandName() })
$cmds -join ','`
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		cmd := exec.CommandContext(ctx, pwsh, "-NoProfile", "-NonInteractive", "-Command", check)
		cmd.Env = append(os.Environ(), "BREEZE_WAKE_SCRIPT="+s)
		var out, stderr bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &stderr
		err = cmd.Run()
		cancel()
		if err != nil {
			t.Fatalf("%v: parse failed: %v %s %s", kind, err, out.String(), stderr.String())
		}
		allowed := map[string]bool{"Get-NetAdapter": true, "Where-Object": true,
			"Set-NetAdapterPowerManagement": true, "Set-NetAdapterAdvancedProperty": true}
		for c := range strings.SplitSeq(strings.TrimSpace(out.String()), ",") {
			if !allowed[c] {
				t.Fatalf("%v: command %q not on the write allowlist", kind, c)
			}
		}
	}
}

func blockedFastStartupState(on Settings) State {
	return State{Adapters: AdapterMemory{}, Apply: ApplyState{Limiter: Limiter{
		PolicyFingerprint: policyFingerprint(on),
		Entries:           map[string]LimitEntry{"fast_startup": {LastAttemptAt: t0.Add(-72 * time.Hour), Failures: 3}},
	}}}
}

func (w *fakeWriter) wrote(kind OpKind) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, op := range w.ops {
		if op.Kind == kind {
			return true
		}
	}
	return false
}

// Turning configure off and back on before a cycle runs is still a policy
// change: the blocked setting gets a fresh budget.
func TestPolicyToggleBackResetsLimiter(t *testing.T) {
	m := badMachine()
	w := &fakeWriter{machine: m}
	h := newApplyHarness(t, m, w)
	on := Settings{Enabled: true, ConfigureSettings: true}
	if err := saveState(h.m.opts.StatePath, blockedFastStartupState(on)); err != nil {
		t.Fatal(err)
	}
	h.m.opts.Now = func() time.Time { return t0 }
	h.m.ApplySettings(on)
	h.m.ApplySettings(Settings{Enabled: true})
	h.m.ApplySettings(on)
	h.m.Start(context.Background())
	defer h.m.Stop()
	waitFor(t, "fast startup retried", func() bool { return w.wrote(OpFastStartupOff) })
}

func TestBlockedSettingStaysBlockedWithoutPolicyChange(t *testing.T) {
	m := badMachine()
	w := &fakeWriter{machine: m}
	h := newApplyHarness(t, m, w)
	on := Settings{Enabled: true, ConfigureSettings: true}
	if err := saveState(h.m.opts.StatePath, blockedFastStartupState(on)); err != nil {
		t.Fatal(err)
	}
	h.m.opts.Now = func() time.Time { return t0 }
	h.m.ApplySettings(on) // an agent restart re-delivers the same policy
	h.m.ApplySettings(on)
	h.m.Start(context.Background())
	defer h.m.Stop()
	waitFor(t, "first upload", func() bool { return h.uploads.Load() > 0 })
	if w.wrote(OpFastStartupOff) {
		t.Fatal("blocked setting retried after a restart with an unchanged policy")
	}
}

func TestUnreadableStateEmbargoesWrites(t *testing.T) {
	dir := t.TempDir() // a directory cannot be read as a file
	st := loadStateAt(dir, t0)
	if !st.Apply.Limiter.EmbargoUntil.Equal(t0.Add(24 * time.Hour)) {
		t.Fatalf("unreadable state must embargo writes, got %v", st.Apply.Limiter.EmbargoUntil)
	}
	if st := loadStateAt(filepath.Join(dir, "missing.json"), t0); !st.Apply.Limiter.EmbargoUntil.IsZero() {
		t.Fatal("a missing state file is a clean start, not an embargo")
	}
}

func TestShutdownWakeDisabledMovesFingerprint(t *testing.T) {
	fp := func(v string) string {
		return Compute(winInputs("disabled", AdapterReading{MAC: "aa:bb:cc:dd:ee:01", MagicPacket: "enabled", EEE: "absent", ShutdownWake: v})).Fingerprint
	}
	if a, b, c := fp("enabled"), fp("disabled"), fp("unknown"); a == b || a == c || b == c {
		t.Fatal("a shutdown-wake value that can block a wake must move the fingerprint")
	}
}
