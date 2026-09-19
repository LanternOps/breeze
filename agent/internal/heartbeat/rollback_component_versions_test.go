package heartbeat

import "testing"

func TestBuildRollbackComponentVersionsIncludesCompleteInstalledSet(t *testing.T) {
	versions, ok := buildRollbackComponentVersions("windows", "2.0.0", map[string]rollbackComponentProbe{
		"helper":      {Installed: true, Version: "2.0.0", Trusted: true},
		"user-helper": {Installed: true, Version: "2.0.0", Trusted: true},
		"watchdog":    {Installed: true, Version: "2.0.0", Trusted: true},
		"backup":      {Installed: false, Trusted: true},
	})
	if !ok {
		t.Fatal("complete inventory was rejected")
	}
	want := map[string]string{"agent": "2.0.0", "helper": "2.0.0", "user-helper": "2.0.0", "watchdog": "2.0.0"}
	if len(versions) != len(want) {
		t.Fatalf("versions = %#v, want %#v", versions, want)
	}
	for component, version := range want {
		if versions[component] != version {
			t.Fatalf("versions[%q] = %q, want %q", component, versions[component], version)
		}
	}
}

func TestBuildRollbackComponentVersionsFailsClosedForUnprovenInstall(t *testing.T) {
	if versions, ok := buildRollbackComponentVersions("windows", "2.0.0", map[string]rollbackComponentProbe{
		"helper": {Installed: true, Trusted: false},
	}); ok || versions != nil {
		t.Fatalf("unproven installed helper produced versions=%#v ok=%v", versions, ok)
	}
}

func TestBuildRollbackComponentVersionsFailsClosedForMissingProbe(t *testing.T) {
	if versions, ok := buildRollbackComponentVersions("linux", "2.0.0", map[string]rollbackComponentProbe{}); ok || versions != nil {
		t.Fatalf("missing probes produced versions=%#v ok=%v", versions, ok)
	}
}

func TestBuildRollbackComponentVersionsRejectsUserHelperOffWindows(t *testing.T) {
	if versions, ok := buildRollbackComponentVersions("linux", "2.0.0", map[string]rollbackComponentProbe{
		"user-helper": {Installed: true, Version: "2.0.0", Trusted: true},
	}); ok || versions != nil {
		t.Fatalf("linux user-helper produced versions=%#v ok=%v", versions, ok)
	}
}
