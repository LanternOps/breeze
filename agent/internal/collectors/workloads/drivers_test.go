package workloads

import (
	"context"
	"io/fs"
	"os"
	"runtime"
	"testing"
)

func statOnly(existing ...string) func(string) (fs.FileInfo, error) {
	set := map[string]bool{}
	for _, p := range existing {
		set[p] = true
	}
	return func(p string) (fs.FileInfo, error) {
		if set[p] {
			return nil, nil
		}
		return nil, &fs.PathError{Op: "stat", Path: p, Err: fs.ErrNotExist}
	}
}

func TestContainerdIsDetectOnly(t *testing.T) {
	const sock, docker = "/run/containerd/containerd.sock", "/var/run/docker.sock"
	cases := []struct {
		name     string
		existing []string
		want     string
	}{
		{"kubernetes node", []string{sock}, DetectionPresent},
		{"docker host (bundled containerd)", []string{sock, docker}, DetectionAbsent},
		{"nothing installed", nil, DetectionAbsent},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := &containerdDriver{socket: sock, dockerSocket: docker, stat: statOnly(tc.existing...)}
			if got := d.Detect(context.Background()); got.State != tc.want {
				t.Fatalf("detection = %+v, want %s", got, tc.want)
			}
		})
	}
	d := &containerdDriver{socket: sock, dockerSocket: docker, stat: statOnly(sock)}
	res := d.Collect(context.Background(), Detection{State: DetectionPresent})
	if res.Collection != CollectionUnsupported || !res.Complete || len(res.Workloads) != 0 {
		t.Fatalf("collect = %+v", res)
	}
}

func TestContainerdStatErrorIsUnknownNotAbsent(t *testing.T) {
	d := &containerdDriver{socket: "/s", dockerSocket: "/d", stat: func(string) (fs.FileInfo, error) {
		return nil, &fs.PathError{Op: "stat", Path: "/s", Err: os.ErrInvalid}
	}}
	if got := d.Detect(context.Background()); got.State != DetectionUnknown {
		t.Fatalf("detection = %+v", got)
	}
}

func TestDefaultDriversHaveUniqueKnownRuntimes(t *testing.T) {
	seen := map[Runtime]bool{}
	for _, d := range DefaultDrivers() {
		if seen[d.Runtime()] {
			t.Fatalf("duplicate driver for %s", d.Runtime())
		}
		seen[d.Runtime()] = true
	}
	// Each VM runtime registers only on the OS that can host it.
	if seen[RuntimeHyperV] != (runtime.GOOS == "windows") {
		t.Fatalf("hyperv registered=%v on %s", seen[RuntimeHyperV], runtime.GOOS)
	}
	if seen[RuntimeProxmox] != (runtime.GOOS == "linux") {
		t.Fatalf("proxmox registered=%v on %s", seen[RuntimeProxmox], runtime.GOOS)
	}
}
