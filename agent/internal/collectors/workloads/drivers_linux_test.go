package workloads

import "testing"

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
