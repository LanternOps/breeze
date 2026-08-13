package heartbeat

import (
	"errors"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// orderedIndex returns the index of needle in haystack, failing the test when
// it is absent. Used to assert that teardown steps appear in a load-bearing
// order (#2878: the agent's own service stop must come after the ack delay
// and after the watchdog re-assert, and deletes/removals must come after the
// stop that unlocks them).
func orderedIndex(t *testing.T, haystack, needle string) int {
	t.Helper()
	idx := strings.Index(haystack, needle)
	if idx < 0 {
		t.Fatalf("script missing expected fragment %q\nscript:\n%s", needle, haystack)
	}
	return idx
}

func assertOrder(t *testing.T, script string, fragments ...string) {
	t.Helper()
	last := -1
	lastFrag := ""
	for _, frag := range fragments {
		idx := orderedIndex(t, script, frag)
		if idx <= last {
			t.Errorf("expected %q to appear after %q\nscript:\n%s", frag, lastFrag, script)
		}
		last = idx
		lastFrag = frag
	}
}

func TestBuildWindowsUninstallScript(t *testing.T) {
	base := windowsUninstallScriptOptions{
		ServiceName:         "BreezeAgent",
		WatchdogServiceName: "BreezeWatchdog",
		AgentBinaryPath:     `C:\Program Files\Nodes Unlimited\nu-agent.exe`,
		WatchdogBinaryPath:  `C:\Program Files\Nodes Unlimited\nu-watchdog.exe`,
		ConfigDir:           `C:\ProgramData\Nodes Unlimited`,
		RemoveConfig:        true,
		DelaySeconds:        5,
	}

	tests := []struct {
		name        string
		opts        windowsUninstallScriptOptions
		wantOrder   []string
		wantAbsent  []string
		wantPresent []string
	}{
		{
			name: "full teardown ordering: delay, watchdog re-assert, stop own service, delete registrations, kill processes, remove binaries, config last, self-delete",
			opts: base,
			wantOrder: []string{
				"Start-Sleep -Seconds 5",
				"sc.exe stop 'BreezeWatchdog'",
				"sc.exe delete 'BreezeWatchdog'",
				"Stop-Service -Name 'BreezeAgent' -Force",
				"sc.exe delete 'BreezeAgent'",
				"Stop-Process -Force",
				`Remove-Item -LiteralPath 'C:\Program Files\Nodes Unlimited\nu-watchdog.exe' -Force`,
				`Remove-Item -LiteralPath 'C:\Program Files\Nodes Unlimited\nu-agent.exe' -Force`,
				`Remove-Item -LiteralPath 'C:\ProgramData\Nodes Unlimited' -Recurse -Force`,
				"Remove-Item -LiteralPath $PSCommandPath -Force",
			},
			// -Path would glob-expand [ ] in install paths into a silent no-op.
			wantAbsent: []string{"Remove-Item -Path"},
		},
		{
			name: "kill list covers a watchdog-respawned agent and lock-holding siblings",
			opts: base,
			wantPresent: []string{
				"Get-Process -Name 'nu-agent','nu-user-helper','nu-desktop-helper','nu-watchdog'",
			},
		},
		{
			name: "removeConfig=false omits config removal but keeps the rest",
			opts: func() windowsUninstallScriptOptions {
				o := base
				o.RemoveConfig = false
				return o
			}(),
			wantAbsent: []string{`'C:\ProgramData\Nodes Unlimited'`},
			wantOrder: []string{
				"Stop-Service -Name 'BreezeAgent'",
				"sc.exe delete 'BreezeAgent'",
				"Remove-Item -LiteralPath $PSCommandPath",
			},
		},
		{
			name: "empty ConfigDir skips config removal even when RemoveConfig is true",
			opts: func() windowsUninstallScriptOptions {
				o := base
				o.ConfigDir = ""
				return o
			}(),
			wantAbsent:  []string{"-Recurse"},
			wantPresent: []string{"Remove-Item -LiteralPath $PSCommandPath"},
		},
		{
			name: "single quotes in paths are doubled for PowerShell",
			opts: func() windowsUninstallScriptOptions {
				o := base
				o.AgentBinaryPath = `C:\O'Brien\nu-agent.exe`
				return o
			}(),
			wantPresent: []string{`'C:\O''Brien\nu-agent.exe'`},
			wantAbsent:  []string{`'C:\O'Brien`},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			script := buildWindowsUninstallScript(tt.opts)
			if len(tt.wantOrder) > 0 {
				assertOrder(t, script, tt.wantOrder...)
			}
			for _, frag := range tt.wantPresent {
				if !strings.Contains(script, frag) {
					t.Errorf("script missing %q\nscript:\n%s", frag, script)
				}
			}
			for _, frag := range tt.wantAbsent {
				if strings.Contains(script, frag) {
					t.Errorf("script unexpectedly contains %q\nscript:\n%s", frag, script)
				}
			}
		})
	}
}

// The false-success bug (#2878): the agent must never stop its own service
// before the ack delay, the watchdog must be re-asserted dead before the
// agent stops (or it may respawn it), and the service must be deleted before
// its binary is removed (a still-registered auto-start service with a missing
// binary is the residual ghost observed in QA).
func TestBuildWindowsUninstallScript_SelfStopComesAfterDelayAndWatchdog(t *testing.T) {
	script := buildWindowsUninstallScript(windowsUninstallScriptOptions{
		ServiceName:         "BreezeAgent",
		WatchdogServiceName: "BreezeWatchdog",
		AgentBinaryPath:     `C:\pf\nu-agent.exe`,
		WatchdogBinaryPath:  `C:\pf\nu-watchdog.exe`,
		DelaySeconds:        7,
	})
	assertOrder(t, script,
		"Start-Sleep -Seconds 7",
		"sc.exe stop 'BreezeWatchdog'",
		"Stop-Service -Name 'BreezeAgent'",
	)
	assertOrder(t, script,
		"sc.exe delete 'BreezeAgent'",
		`Remove-Item -LiteralPath 'C:\pf\nu-agent.exe'`,
	)
}

func TestBuildDarwinUninstallScript(t *testing.T) {
	base := darwinUninstallScriptOptions{
		Label:           "com.nodesunlimited.agent",
		WatchdogLabel:   "com.nodesunlimited.watchdog",
		WatchdogProcess: "nu-watchdog",
		PlistPath:       "/Library/LaunchDaemons/com.nodesunlimited.agent.plist",
		BinaryPath:      "/usr/local/bin/nu-agent",
		ConfigDir:       "/Library/Application Support/Nodes Unlimited",
		RemoveConfig:    true,
		DelaySeconds:    5,
	}

	tests := []struct {
		name       string
		opts       darwinUninstallScriptOptions
		wantOrder  []string
		wantAbsent []string
	}{
		{
			name: "ordering: delay, watchdog re-assert (bootout + pkill), bootout own daemon, remove plist, remove binary, config last",
			opts: base,
			wantOrder: []string{
				"sleep 5",
				"launchctl bootout system/'com.nodesunlimited.watchdog'",
				"pkill -x 'nu-watchdog'",
				"launchctl bootout system/'com.nodesunlimited.agent' || launchctl unload '/Library/LaunchDaemons/com.nodesunlimited.agent.plist'",
				"rm -f '/Library/LaunchDaemons/com.nodesunlimited.agent.plist'",
				"rm -f '/usr/local/bin/nu-agent'",
				"rm -rf '/Library/Application Support/Nodes Unlimited'",
			},
		},
		{
			name: "removeConfig=false omits config removal",
			opts: func() darwinUninstallScriptOptions {
				o := base
				o.RemoveConfig = false
				return o
			}(),
			wantOrder:  []string{"rm -f '/usr/local/bin/nu-agent'"},
			wantAbsent: []string{"rm -rf"},
		},
		{
			name: "single quotes in paths are escaped for sh",
			opts: func() darwinUninstallScriptOptions {
				o := base
				o.PlistPath = "/tmp/o'brien.plist"
				return o
			}(),
			wantOrder: []string{`rm -f '/tmp/o'\''brien.plist'`},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			script := buildDarwinUninstallScript(tt.opts)
			assertOrder(t, script, tt.wantOrder...)
			for _, frag := range tt.wantAbsent {
				if strings.Contains(script, frag) {
					t.Errorf("script unexpectedly contains %q\nscript:\n%s", frag, script)
				}
			}
		})
	}
}

func TestBuildLinuxUninstallScript(t *testing.T) {
	base := linuxUninstallScriptOptions{
		ServiceName:     "nu-agent",
		WatchdogService: "nu-watchdog",
		WatchdogProcess: "nu-watchdog",
		UnitPath:        "/etc/systemd/system/nu-agent.service",
		BinaryPath:      "/usr/local/bin/nu-agent",
		ConfigDir:       "/etc/nodesunlimited",
		RemoveConfig:    true,
		DelaySeconds:    5,
	}

	tests := []struct {
		name       string
		opts       linuxUninstallScriptOptions
		wantOrder  []string
		wantAbsent []string
	}{
		{
			name: "ordering: delay, watchdog re-assert, stop own unit, remove unit, daemon-reload, remove binary, config last",
			opts: base,
			wantOrder: []string{
				"sleep 5",
				"systemctl stop 'nu-watchdog'",
				"pkill -x 'nu-watchdog'",
				"systemctl stop 'nu-agent'",
				"rm -f '/etc/systemd/system/nu-agent.service'",
				"systemctl daemon-reload",
				"rm -f '/usr/local/bin/nu-agent'",
				"rm -rf '/etc/nodesunlimited'",
			},
		},
		{
			name: "removeConfig=false omits config removal",
			opts: func() linuxUninstallScriptOptions {
				o := base
				o.RemoveConfig = false
				return o
			}(),
			wantOrder:  []string{"rm -f '/usr/local/bin/nu-agent'"},
			wantAbsent: []string{"rm -rf"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			script := buildLinuxUninstallScript(tt.opts)
			assertOrder(t, script, tt.wantOrder...)
			for _, frag := range tt.wantAbsent {
				if strings.Contains(script, frag) {
					t.Errorf("script unexpectedly contains %q\nscript:\n%s", frag, script)
				}
			}
		})
	}
}

// TestHandleSelfUninstall_ResultContract pins the handler's core promise
// (#2878): when the detached teardown cannot be handed off, the command must
// report FAILURE — the offboarding drain must never count a machine that will
// remain installed as a clean uninstall — and no shutdown may be scheduled.
// On success, the ack says "initiated"/"handed off", never "completed".
func TestHandleSelfUninstall_ResultContract(t *testing.T) {
	origPrepare := prepareSelfUninstallFn
	origSchedule := scheduleSelfUninstallShutdownFn
	t.Cleanup(func() {
		prepareSelfUninstallFn = origPrepare
		scheduleSelfUninstallShutdownFn = origSchedule
	})

	tests := []struct {
		name             string
		prepareErr       error
		payload          map[string]any
		wantStatus       string
		wantErrFragment  string
		wantMsgFragment  string
		wantShutdown     bool
		wantRemoveConfig bool
	}{
		{
			name:             "handoff failure returns failed result and schedules no shutdown",
			prepareErr:       errors.New("spawn detached teardown helper: exec blocked"),
			payload:          map[string]any{},
			wantStatus:       "failed",
			wantErrFragment:  "agent service remains installed",
			wantShutdown:     false,
			wantRemoveConfig: true,
		},
		{
			name:             "handoff success returns completed result saying initiated, schedules shutdown, honors removeConfig=false",
			prepareErr:       nil,
			payload:          map[string]any{"removeConfig": false},
			wantStatus:       "completed",
			wantMsgFragment:  "self-uninstall initiated",
			wantShutdown:     true,
			wantRemoveConfig: false,
		},
		{
			name:             "removeConfig defaults to true",
			prepareErr:       nil,
			payload:          map[string]any{},
			wantStatus:       "completed",
			wantShutdown:     true,
			wantRemoveConfig: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var gotRemoveConfig *bool
			prepareSelfUninstallFn = func(removeConfig bool) error {
				gotRemoveConfig = &removeConfig
				return tt.prepareErr
			}
			shutdownScheduled := false
			scheduleSelfUninstallShutdownFn = func(h *Heartbeat) {
				shutdownScheduled = true
			}

			result := handleSelfUninstall(&Heartbeat{}, Command{
				ID:      "cmd-1",
				Type:    tools.CmdSelfUninstall,
				Payload: tt.payload,
			})

			if result.Status != tt.wantStatus {
				t.Errorf("Status = %q, want %q (result: %+v)", result.Status, tt.wantStatus, result)
			}
			if tt.wantErrFragment != "" && !strings.Contains(result.Error, tt.wantErrFragment) {
				t.Errorf("Error %q missing fragment %q", result.Error, tt.wantErrFragment)
			}
			if tt.wantMsgFragment != "" && !strings.Contains(result.Stdout, tt.wantMsgFragment) {
				t.Errorf("Stdout %q missing fragment %q", result.Stdout, tt.wantMsgFragment)
			}
			if tt.wantStatus == "completed" && strings.Contains(result.Stdout, "uninstall completed") {
				t.Errorf("success ack must claim initiation, not completion: %q", result.Stdout)
			}
			if shutdownScheduled != tt.wantShutdown {
				t.Errorf("shutdownScheduled = %v, want %v", shutdownScheduled, tt.wantShutdown)
			}
			if gotRemoveConfig == nil {
				t.Fatal("prepare was never called")
			}
			if *gotRemoveConfig != tt.wantRemoveConfig {
				t.Errorf("removeConfig = %v, want %v", *gotRemoveConfig, tt.wantRemoveConfig)
			}
		})
	}
}

func TestShQuote(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"plain", "'plain'"},
		{"with space", "'with space'"},
		{"o'brien", `'o'\''brien'`},
		{"", "''"},
	}
	for _, tt := range tests {
		if got := shQuote(tt.in); got != tt.want {
			t.Errorf("shQuote(%q) = %s, want %s", tt.in, got, tt.want)
		}
	}
}

func TestPsQuote(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"plain", "plain"},
		{"o'brien", "o''brien"},
		{`C:\path`, `C:\path`},
	}
	for _, tt := range tests {
		if got := psQuote(tt.in); got != tt.want {
			t.Errorf("psQuote(%q) = %s, want %s", tt.in, got, tt.want)
		}
	}
}
