package heartbeat

import (
	"strings"
	"testing"
)

// orderedIndex returns the index of needle in haystack, failing the test when
// it is absent. Used to assert that teardown steps appear in a load-bearing
// order (#2878: the agent's own service stop must come after the ack delay,
// and deletes/removals must come after the stop that unlocks them).
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
		AgentBinaryPath:     `C:\Program Files\Breeze\breeze-agent.exe`,
		WatchdogBinaryPath:  `C:\Program Files\Breeze\breeze-watchdog.exe`,
		ConfigDir:           `C:\ProgramData\Breeze`,
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
			name: "full teardown ordering: delay, stop own service, delete registrations, kill helpers, remove binaries, config last, self-delete",
			opts: base,
			wantOrder: []string{
				"Start-Sleep -Seconds 5",
				"Stop-Service -Name 'BreezeAgent' -Force",
				"sc.exe delete 'BreezeAgent'",
				"sc.exe delete 'BreezeWatchdog'",
				"Stop-Process -Force",
				`Remove-Item -Path 'C:\Program Files\Breeze\breeze-watchdog.exe' -Force`,
				`Remove-Item -Path 'C:\Program Files\Breeze\breeze-agent.exe' -Force`,
				`Remove-Item -Path 'C:\ProgramData\Breeze' -Recurse -Force`,
				"Remove-Item -Path $PSCommandPath -Force",
			},
		},
		{
			name: "removeConfig=false omits config removal but keeps the rest",
			opts: func() windowsUninstallScriptOptions {
				o := base
				o.RemoveConfig = false
				return o
			}(),
			wantAbsent: []string{`'C:\ProgramData\Breeze'`},
			wantOrder: []string{
				"Stop-Service -Name 'BreezeAgent'",
				"sc.exe delete 'BreezeAgent'",
				"Remove-Item -Path $PSCommandPath",
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
			wantPresent: []string{"Remove-Item -Path $PSCommandPath"},
		},
		{
			name: "single quotes in paths are doubled for PowerShell",
			opts: func() windowsUninstallScriptOptions {
				o := base
				o.AgentBinaryPath = `C:\O'Brien\breeze-agent.exe`
				return o
			}(),
			wantPresent: []string{`'C:\O''Brien\breeze-agent.exe'`},
			wantAbsent:  []string{`'C:\O'Brien`},
		},
		{
			name: "watchdog re-assert: stop before delete",
			opts: base,
			wantOrder: []string{
				"sc.exe stop 'BreezeWatchdog'",
				"sc.exe delete 'BreezeWatchdog'",
			},
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
// before the ack delay, and the detached script must never touch the watchdog
// AGENT-RESPAWN path after the agent binary is already gone. Assert the two
// invariants that reproduce the field failure directly.
func TestBuildWindowsUninstallScript_SelfStopComesAfterDelay(t *testing.T) {
	script := buildWindowsUninstallScript(windowsUninstallScriptOptions{
		ServiceName:         "BreezeAgent",
		WatchdogServiceName: "BreezeWatchdog",
		AgentBinaryPath:     `C:\pf\breeze-agent.exe`,
		WatchdogBinaryPath:  `C:\pf\breeze-watchdog.exe`,
		DelaySeconds:        7,
	})
	assertOrder(t, script,
		"Start-Sleep -Seconds 7",
		"Stop-Service -Name 'BreezeAgent'",
	)
	// The service must be deleted before its binary is removed — deleting the
	// registration of a still-registered service with a missing binary would
	// leave an auto-start ghost (the residual state observed in QA).
	assertOrder(t, script,
		"sc.exe delete 'BreezeAgent'",
		`Remove-Item -Path 'C:\pf\breeze-agent.exe'`,
	)
}

func TestBuildDarwinUninstallScript(t *testing.T) {
	base := darwinUninstallScriptOptions{
		Label:        "com.breeze.agent",
		PlistPath:    "/Library/LaunchDaemons/com.breeze.agent.plist",
		BinaryPath:   "/usr/local/bin/breeze-agent",
		DelaySeconds: 5,
	}

	tests := []struct {
		name      string
		opts      darwinUninstallScriptOptions
		wantOrder []string
	}{
		{
			name: "ordering: delay, bootout own daemon (with unload fallback), remove plist, remove binary",
			opts: base,
			wantOrder: []string{
				"sleep 5",
				"launchctl bootout system/'com.breeze.agent' || launchctl unload '/Library/LaunchDaemons/com.breeze.agent.plist'",
				"rm -f '/Library/LaunchDaemons/com.breeze.agent.plist'",
				"rm -f '/usr/local/bin/breeze-agent'",
			},
		},
		{
			name: "single quotes in paths are escaped for sh",
			opts: darwinUninstallScriptOptions{
				Label:        "com.breeze.agent",
				PlistPath:    "/tmp/o'brien.plist",
				BinaryPath:   "/usr/local/bin/breeze-agent",
				DelaySeconds: 5,
			},
			wantOrder: []string{`rm -f '/tmp/o'\''brien.plist'`},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			script := buildDarwinUninstallScript(tt.opts)
			assertOrder(t, script, tt.wantOrder...)
		})
	}
}

func TestBuildLinuxUninstallScript(t *testing.T) {
	base := linuxUninstallScriptOptions{
		ServiceName:  "breeze-agent",
		UnitPath:     "/etc/systemd/system/breeze-agent.service",
		BinaryPath:   "/usr/local/bin/breeze-agent",
		DelaySeconds: 5,
	}

	tests := []struct {
		name      string
		opts      linuxUninstallScriptOptions
		wantOrder []string
	}{
		{
			name: "ordering: delay, stop own unit, remove unit, daemon-reload, remove binary",
			opts: base,
			wantOrder: []string{
				"sleep 5",
				"systemctl stop 'breeze-agent'",
				"rm -f '/etc/systemd/system/breeze-agent.service'",
				"systemctl daemon-reload",
				"rm -f '/usr/local/bin/breeze-agent'",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			script := buildLinuxUninstallScript(tt.opts)
			assertOrder(t, script, tt.wantOrder...)
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
