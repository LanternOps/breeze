package workloads

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// noDial fails the test if anything tries to open a connection.
func noDial(t *testing.T) DialFunc {
	t.Helper()
	return func(context.Context) (net.Conn, error) {
		t.Error("dialed an engine socket whose daemon is not running")
		return nil, errors.New("must not dial")
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// fakeProc writes procDir/<pid>/{comm,cmdline}.
func fakeProc(t *testing.T, procDir string, pid int, comm string, argv ...string) {
	t.Helper()
	dir := filepath.Join(procDir, strconv.Itoa(pid))
	writeFile(t, filepath.Join(dir, "comm"), comm+"\n")
	cmdline := ""
	for _, a := range argv {
		cmdline += a + "\x00"
	}
	writeFile(t, filepath.Join(dir, "cmdline"), cmdline)
}

type dockerHost struct {
	socket, pidFile, procDir string
}

// newDockerHost creates a socket stand-in file (Detect only stats it) and empty
// pid/proc locations.
func newDockerHost(t *testing.T) dockerHost {
	t.Helper()
	dir := t.TempDir()
	h := dockerHost{socket: filepath.Join(dir, "docker.sock"), pidFile: filepath.Join(dir, "docker.pid"), procDir: filepath.Join(dir, "proc")}
	writeFile(t, h.socket, "")
	if err := os.MkdirAll(h.procDir, 0o755); err != nil {
		t.Fatal(err)
	}
	return h
}

func (h dockerHost) driver(dial DialFunc) *engineDriver {
	return newEngineDriver(RuntimeDocker, dial, withSocketPath(h.socket), withLiveness(pidFileLiveness(h.pidFile, h.procDir, "dockerd")))
}

func TestDockerNeverConnectsUnlessDaemonIsAlreadyRunning(t *testing.T) {
	cases := []struct {
		name  string
		setup func(t *testing.T, h dockerHost)
	}{
		{"no pid file (stopped socket-activated daemon)", func(*testing.T, dockerHost) {}},
		{"garbage pid file", func(t *testing.T, h dockerHost) { writeFile(t, h.pidFile, "not-a-pid") }},
		{"zero pid", func(t *testing.T, h dockerHost) { writeFile(t, h.pidFile, "0\n") }},
		{"stale pid, process gone", func(t *testing.T, h dockerHost) { writeFile(t, h.pidFile, "4242\n") }},
		{"pid reused by another program", func(t *testing.T, h dockerHost) {
			writeFile(t, h.pidFile, "4242\n")
			fakeProc(t, h.procDir, 4242, "bash")
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newDockerHost(t)
			tc.setup(t, h)
			d := h.driver(noDial(t))
			det := d.Detect(context.Background())
			if det.State != DetectionPresent || det.Reason != ReasonNotRunning {
				t.Fatalf("detection = %+v, want present/not_running", det)
			}
			res := d.Collect(context.Background(), det)
			if res.Collection != CollectionUnavailable || res.Error != "daemon not running" || len(res.Workloads) != 0 {
				t.Fatalf("collect = %+v", res)
			}
		})
	}
}

func TestDockerConnectsOnceDaemonIsRunning(t *testing.T) {
	h := newDockerHost(t)
	writeFile(t, h.pidFile, "4242\n")
	fakeProc(t, h.procDir, 4242, "dockerd", "/usr/bin/dockerd")
	_, dial := newFakeEngine(t, dockerRoutes(t))
	det := h.driver(dial).Detect(context.Background())
	if det.State != DetectionPresent || det.Version != "27.1.1" || det.Reason != "" {
		t.Fatalf("detection = %+v", det)
	}
}

func TestDockerSocketMissingIsAbsentWithoutConnecting(t *testing.T) {
	h := newDockerHost(t)
	if err := os.Remove(h.socket); err != nil {
		t.Fatal(err)
	}
	if det := h.driver(noDial(t)).Detect(context.Background()); det.State != DetectionAbsent {
		t.Fatalf("detection = %+v", det)
	}
}

// podman-docker links /var/run/docker.sock to Podman's socket. The docker driver
// must recognise that from the path alone, with no connection and no pid check.
func TestDockerSocketLinkedToPodmanIsAbsentWithoutConnecting(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "podman.sock")
	writeFile(t, target, "")
	link := filepath.Join(dir, "docker.sock")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	d := newEngineDriver(RuntimeDocker, noDial(t), withSocketPath(link), withLiveness(func(context.Context) liveness { return livenessRunning }))
	if det := d.Detect(context.Background()); det.State != DetectionAbsent {
		t.Fatalf("detection = %+v, want absent", det)
	}
}

func TestPodmanNeverConnectsWithoutARunningServiceProcess(t *testing.T) {
	dir := t.TempDir()
	socket, procDir := filepath.Join(dir, "podman.sock"), filepath.Join(dir, "proc")
	writeFile(t, socket, "")
	fakeProc(t, procDir, 1, "systemd", "/sbin/init")
	fakeProc(t, procDir, 200, "bash", "bash")
	fakeProc(t, procDir, 201, "podman", "/usr/bin/podman", "ps", "-a") // a CLI call, not the service
	fakeProc(t, procDir, 202, "conmon", "/usr/bin/conmon")
	writeFile(t, filepath.Join(procDir, "self-not-a-pid", "cmdline"), "podman\x00system\x00service\x00")

	d := newEngineDriver(RuntimePodman, noDial(t), withSocketPath(socket), withLiveness(podmanServiceLiveness(procDir, socket, allRoot)))
	det := d.Detect(context.Background())
	if det.State != DetectionPresent || det.Reason != ReasonNotRunning {
		t.Fatalf("detection = %+v, want present/not_running", det)
	}
	if res := d.Collect(context.Background(), det); res.Collection != CollectionUnavailable || res.Error != "daemon not running" {
		t.Fatalf("collect = %+v", res)
	}

	// Once a service process exists the driver connects.
	fakeProc(t, procDir, 300, "podman", "/usr/bin/podman", "--log-level=info", "system", "service", "--time=0")
	_, dial := newFakeEngine(t, map[string]func(http.ResponseWriter){
		"/_ping": serve([]byte("OK")), "/version": serve(fixture(t, "podman_version.json")),
	})
	d = newEngineDriver(RuntimePodman, dial, withSocketPath(socket), withLiveness(podmanServiceLiveness(procDir, socket, allRoot)))
	if det := d.Detect(context.Background()); det.State != DetectionPresent || det.Version != "5.1.2" {
		t.Fatalf("detection with a running service = %+v", det)
	}
}

func TestIsPodmanService(t *testing.T) {
	for name, tc := range map[string]struct {
		args []string
		want bool
	}{
		"plain":            {[]string{"/usr/bin/podman", "system", "service"}, true},
		"with flags":       {[]string{"podman", "--log-level=info", "system", "service", "--time=0"}, true},
		"cli ps":           {[]string{"/usr/bin/podman", "ps", "-a"}, false},
		"system prune":     {[]string{"podman", "system", "prune"}, false},
		"other binary":     {[]string{"/usr/bin/docker", "system", "service"}, false},
		"too short":        {[]string{"podman", "system"}, false},
		"empty cmdline":    {[]string{""}, false},
		"podman-remote":    {[]string{"podman-remote", "system", "service"}, false},
		"service not last": {[]string{"podman", "service", "system"}, false},
	} {
		if got := isPodmanService(tc.args); got != tc.want {
			t.Errorf("%s: isPodmanService(%v) = %v, want %v", name, tc.args, got, tc.want)
		}
	}
}

func TestLivenessFromService(t *testing.T) {
	for state, want := range map[serviceState]liveness{
		serviceRunning: livenessRunning,
		serviceMissing: livenessAbsent,
		serviceStopped: livenessStopped,
		serviceUnknown: livenessStopped, // when in doubt, do not connect
	} {
		if got := livenessFromService(state); got != want {
			t.Errorf("livenessFromService(%d) = %d, want %d", state, got, want)
		}
	}
}

// allRoot treats every fake process as root-owned; rootOwnedExcept marks the
// listed pids as belonging to an unprivileged user.
func allRoot(string) bool { return true }

func rootOwnedExcept(pids ...int) func(string) bool {
	return func(pidDir string) bool {
		for _, p := range pids {
			if filepath.Base(pidDir) == strconv.Itoa(p) {
				return false
			}
		}
		return true
	}
}

// Only a root-owned service process listening on the rootful socket proves the
// rootful engine is up. A rootless user's `podman system service`, or a root
// one serving another URI, says nothing about the rootful socket, and dialing
// that socket would make systemd start the rootful podman.service.
func TestPodmanLivenessIgnoresServicesForOtherSockets(t *testing.T) {
	dir := t.TempDir()
	socket, procDir := filepath.Join(dir, "podman.sock"), filepath.Join(dir, "proc")
	writeFile(t, socket, "")
	fakeProc(t, procDir, 400, "podman", "/usr/bin/podman", "system", "service", "--time=0") // rootless user unit
	fakeProc(t, procDir, 401, "podman", "/usr/bin/podman", "system", "service", "unix:///tmp/other.sock")
	fakeProc(t, procDir, 402, "podman", "/usr/bin/podman", "system", "service", "tcp://127.0.0.1:8888")

	d := newEngineDriver(RuntimePodman, noDial(t), withSocketPath(socket),
		withLiveness(podmanServiceLiveness(procDir, socket, rootOwnedExcept(400))))
	if det := d.Detect(context.Background()); det.State != DetectionPresent || det.Reason != ReasonNotRunning {
		t.Fatalf("detection = %+v, want present/not_running without dialing", det)
	}

	for name, args := range map[string][]string{
		"systemd unit (no URI)": {"/usr/bin/podman", "--log-level=info", "system", "service"},
		"explicit unix URI":     {"podman", "system", "service", "--time", "0", "unix://" + socket},
		"unix: form":            {"podman", "system", "service", "-t", "5", "unix:" + socket},
	} {
		pd := filepath.Join(t.TempDir(), "proc")
		fakeProc(t, pd, 500, "podman", args...)
		if got := podmanServiceLiveness(pd, socket, allRoot)(context.Background()); got != livenessRunning {
			t.Errorf("%s: liveness = %d, want running", name, got)
		}
		if got := podmanServiceLiveness(pd, socket, rootOwnedExcept(500))(context.Background()); got != livenessStopped {
			t.Errorf("%s owned by a user: liveness = %d, want stopped", name, got)
		}
	}
}
