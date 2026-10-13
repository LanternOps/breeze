package workloads

import (
	"context"
	"os"
	"testing"
)

func TestLinuxRegistersDockerPodmanContainerdProxmox(t *testing.T) {
	got := map[Runtime]bool{}
	for _, d := range DefaultDrivers() {
		got[d.Runtime()] = true
	}
	for _, want := range []Runtime{RuntimeDocker, RuntimePodman, RuntimeContainerd, RuntimeProxmox} {
		if !got[want] {
			t.Errorf("missing %s driver", want)
		}
	}
	if len(got) != 4 {
		t.Errorf("registered %d drivers, want 4", len(got))
	}
}

// The production driver must use the absolute pvesh path the read-only
// allowlist accepts, and the real filesystem readers.
func TestLinuxProxmoxDriverWiring(t *testing.T) {
	d, ok := newProxmoxDriver().(*proxmoxDriver)
	if !ok {
		t.Fatal("newProxmoxDriver did not return *proxmoxDriver")
	}
	if d.pvesh != proxmoxPvesh || d.pveDir != "/etc/pve" || d.run == nil || d.stat == nil || d.readlink == nil || d.readConf == nil || d.now == nil {
		t.Fatalf("driver wiring: %+v", d)
	}
	if _, err := os.Stat(proxmoxPvesh); err == nil {
		t.Skip("running on a Proxmox node")
	}
	if det := d.Detect(context.Background()); det.State != DetectionAbsent {
		t.Fatalf("a non-Proxmox Linux host detected %+v", det)
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
