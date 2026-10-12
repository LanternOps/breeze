package workloads

import (
	"os"
	"testing"
)

func TestLinuxRegistersDockerPodmanContainerd(t *testing.T) {
	got := map[Runtime]bool{}
	for _, d := range DefaultDrivers() {
		got[d.Runtime()] = true
	}
	for _, want := range []Runtime{RuntimeDocker, RuntimePodman, RuntimeContainerd} {
		if !got[want] {
			t.Errorf("missing %s driver", want)
		}
	}
	if len(got) != 3 {
		t.Errorf("registered %d drivers, want 3", len(got))
	}
}

// /proc/<pid> is owned by the process's effective uid; the Podman gate relies on
// that to ignore rootless services.
func TestProcOwnedByRootFollowsEffectiveUID(t *testing.T) {
	if got, want := procOwnedByRoot("/proc/self"), os.Geteuid() == 0; got != want {
		t.Fatalf("procOwnedByRoot(/proc/self) = %v with euid %d", got, os.Geteuid())
	}
	if procOwnedByRoot("/proc/does-not-exist") {
		t.Fatal("a missing process must not count as root-owned")
	}
}
