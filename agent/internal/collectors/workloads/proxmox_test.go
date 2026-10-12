package workloads

import (
	"context"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// pveHost is a fake Proxmox host: which paths exist, where /etc/pve/local
// points, and the guest config files.
type pveHost struct {
	pvesh    bool
	statErr  error
	local    string // "" = pmxcfs not mounted
	confs    map[string]string
	dpkgFile string
}

func newTestProxmox(t *testing.T, h pveHost, r *fakeRunner) *proxmoxDriver {
	t.Helper()
	return &proxmoxDriver{
		pvesh:      proxmoxPvesh,
		pveDir:     "/etc/pve",
		dpkgStatus: h.dpkgFile,
		stat: func(p string) (fs.FileInfo, error) {
			if p != proxmoxPvesh {
				t.Fatalf("unexpected stat %s", p)
			}
			if h.statErr != nil {
				return nil, h.statErr
			}
			if !h.pvesh {
				return nil, &fs.PathError{Op: "stat", Path: p, Err: fs.ErrNotExist}
			}
			return nil, nil
		},
		readlink: func(p string) (string, error) {
			if p != "/etc/pve/local" || h.local == "" {
				return "", &fs.PathError{Op: "readlink", Path: p, Err: fs.ErrNotExist}
			}
			return h.local, nil
		},
		readConf: func(p string, _ int64) ([]byte, error) {
			if c, ok := h.confs[p]; ok {
				return []byte(c), nil
			}
			return nil, &fs.PathError{Op: "open", Path: p, Err: fs.ErrNotExist}
		},
		run: r.run,
		now: hvNow,
	}
}

func pveListRunner(t *testing.T, qemu, lxc func(string, []string) (cmdOutput, error)) *fakeRunner {
	return &fakeRunner{fn: func(path string, args []string) (cmdOutput, error) {
		if !allowedCommand(path, args) {
			t.Errorf("driver built a command outside the allowlist: %s %q", path, args)
		}
		switch {
		case strings.HasSuffix(args[1], "/qemu"):
			return qemu(path, args)
		case strings.HasSuffix(args[1], "/lxc"):
			return lxc(path, args)
		}
		t.Fatalf("unexpected argv %q", args)
		return cmdOutput{}, nil
	}}
}

var testdataDpkg = filepath.Join("testdata", "dpkg_status")

func TestProxmoxDetectNeverExecs(t *testing.T) {
	cases := []struct {
		name string
		host pveHost
		want Detection
	}{
		{"not a proxmox host", pveHost{}, Detection{State: DetectionAbsent}},
		{"stat permission", pveHost{statErr: &fs.PathError{Op: "stat", Err: fs.ErrPermission}}, Detection{State: DetectionPresent, Reason: ReasonPermissionDenied}},
		{"stat other error", pveHost{statErr: &fs.PathError{Op: "stat", Err: os.ErrInvalid}}, Detection{State: DetectionUnknown, Reason: ReasonUnreachable}},
		{"pmxcfs not mounted", pveHost{pvesh: true, dpkgFile: testdataDpkg}, Detection{State: DetectionPresent, Version: "pve-manager/8.2.4", Reason: ReasonNotRunning}},
		{"running", pveHost{pvesh: true, local: "nodes/pve-a", dpkgFile: testdataDpkg}, Detection{State: DetectionPresent, Version: "pve-manager/8.2.4"}},
		{"running, no dpkg status", pveHost{pvesh: true, local: "nodes/pve-a", dpkgFile: "/nonexistent"}, Detection{State: DetectionPresent}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := &fakeRunner{fn: stdout("[]")}
			if got := newTestProxmox(t, tc.host, r).Detect(context.Background()); got != tc.want {
				t.Fatalf("Detect = %+v, want %+v", got, tc.want)
			}
			if r.calls.Load() != 0 {
				t.Fatal("Detect executed a command")
			}
		})
	}
}

func TestProxmoxCollectMapsFixtures(t *testing.T) {
	host := pveHost{pvesh: true, local: "nodes/pve-a", confs: map[string]string{
		"/etc/pve/nodes/pve-a/qemu-server/100.conf": "boot: order=scsi0\ncores: 4\nonboot: 1\nname: web-frontend\n",
		"/etc/pve/nodes/pve-a/lxc/200.conf":         "arch: amd64\nhostname: dns-cache\n\n[snap1]\nonboot: 1\n",
		"/etc/pve/nodes/pve-a/lxc/201.conf":         "onboot: 0\nhostname: mail-relay\n",
	}}
	r := pveListRunner(t, stdout(string(fixture(t, "proxmox_qemu.json"))), stdout(string(fixture(t, "proxmox_lxc.json"))))
	d := newTestProxmox(t, host, r)
	res := d.Collect(context.Background(), d.Detect(context.Background()))
	if res.Collection != CollectionOK || !res.Complete || res.Error != "" || res.ObservedCount != 4 {
		t.Fatalf("result = %+v", res)
	}
	want := [][]string{
		{proxmoxPvesh, "get", "/nodes/pve-a/qemu", "--output-format", "json"},
		{proxmoxPvesh, "get", "/nodes/pve-a/lxc", "--output-format", "json"},
	}
	if mustJSON(r.argv) != mustJSON(want) {
		t.Fatalf("argv = %q", r.argv)
	}
	type exp struct {
		kind, name, state string
		cpu, mem          int
		restart, started  string
	}
	expect := map[string]exp{
		"100": {KindVM, "web-frontend", StateRunning, 4, 8192, "always", "2026-10-06T11:00:00Z"},
		"101": {KindVM, "db-replica", StateStopped, 2, 4096, "", ""},
		"200": {KindLXC, "dns-cache", StateRunning, 2, 512, "no", "2026-10-05T12:00:00Z"},
		"201": {KindLXC, "mail-relay", StateStopped, 1, 1024, "no", ""},
	}
	if len(res.Workloads) != len(expect) {
		t.Fatalf("workloads = %s", mustJSON(res.Workloads))
	}
	for _, w := range res.Workloads {
		e, ok := expect[w.WorkloadID]
		if !ok {
			t.Errorf("unexpected workload %s (templates must be skipped)", w.WorkloadID)
			continue
		}
		if w.Kind != e.kind || w.Name != e.name || w.State != e.state || derefInt(w.CPUCount) != e.cpu ||
			derefInt(w.MemoryMB) != e.mem || deref(w.RestartPolicy) != e.restart || deref(w.StartedAt) != e.started {
			t.Errorf("%s = %s", w.WorkloadID, mustJSON(w))
		}
		if deref(w.RawState) == "" || w.ImageRef != nil || w.GuestOS != nil {
			t.Errorf("%s field allowlist: %s", w.WorkloadID, mustJSON(w))
		}
	}
	if res.Workloads[0].State != StateRunning || res.Workloads[1].State != StateRunning {
		t.Errorf("running guests are not first: %s", mustJSON(res.Workloads))
	}
}

func TestProxmoxCollectFailures(t *testing.T) {
	ok := stdout("[]")
	fail := func(err error) func(string, []string) (cmdOutput, error) {
		return func(string, []string) (cmdOutput, error) { return cmdOutput{}, err }
	}
	exit := func(code int) func(string, []string) (cmdOutput, error) {
		return func(string, []string) (cmdOutput, error) {
			return cmdOutput{ExitCode: code, Stderr: []byte("raw pvesh error")}, nil
		}
	}
	cases := []struct {
		name       string
		qemu, lxc  func(string, []string) (cmdOutput, error)
		collection string
		code       string
		complete   bool
	}{
		{"empty host", ok, ok, CollectionOK, "", true},
		{"qemu list fails", exit(255), stdout(string(fixture(t, "proxmox_lxc.json"))), CollectionOK, "qemu_list_failed", false},
		{"lxc list malformed", stdout(string(fixture(t, "proxmox_qemu.json"))), stdout("{oops"), CollectionOK, "lxc_list_failed", false},
		{"both time out", fail(context.DeadlineExceeded), fail(context.DeadlineExceeded), CollectionUnavailable, ReasonTimeout, false},
		{"both malformed", stdout("nope"), stdout(""), CollectionError, "decode_failed", false},
		{"both fail to exec", exit(2), exit(2), CollectionError, "command_failed", false},
		{"pvesh vanished", fail(&fs.PathError{Op: "fork/exec", Err: fs.ErrNotExist}), fail(&fs.PathError{Op: "fork/exec", Err: fs.ErrNotExist}), CollectionUnavailable, "tool_missing", false},
		{"oversize", fail(errTooLarge), ok, CollectionOK, "qemu_list_failed", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := newTestProxmox(t, pveHost{pvesh: true, local: "nodes/pve-a"}, pveListRunner(t, tc.qemu, tc.lxc))
			res := d.Collect(context.Background(), Detection{State: DetectionPresent})
			if res.Collection != tc.collection || res.Error != tc.code || res.Complete != tc.complete {
				t.Fatalf("result = %+v, want %s/%q complete=%v", res, tc.collection, tc.code, tc.complete)
			}
			if res.Collection != CollectionOK && len(res.Workloads) != 0 {
				t.Fatal("a failed collection returned workloads")
			}
		})
	}
}

func TestProxmoxNodeNameIsValidatedBeforeExec(t *testing.T) {
	for _, link := range []string{"nodes/pve;rm -rf", "nodes/../x", "nodes/-x", "../nodes/pve-a", "nodes/", "nodes/a/b", "nodes/" + strings.Repeat("a", 64), "pve-a"} {
		r := &fakeRunner{fn: stdout("[]")}
		d := newTestProxmox(t, pveHost{pvesh: true, local: link}, r)
		res := d.Collect(context.Background(), Detection{State: DetectionPresent})
		if res.Collection != CollectionError || res.Error != "invalid_node" || r.calls.Load() != 0 {
			t.Errorf("link %q: result = %+v, execs = %d", link, res, r.calls.Load())
		}
	}
	r := &fakeRunner{fn: stdout("[]")}
	d := newTestProxmox(t, pveHost{pvesh: true}, r)
	if res := d.Collect(context.Background(), Detection{State: DetectionPresent}); res.Collection != CollectionUnavailable || res.Error != ReasonNotRunning || r.calls.Load() != 0 {
		t.Fatalf("pmxcfs unmounted between Detect and Collect: %+v", res)
	}
}

func TestProxmoxCollectDoesNotExecWhenNotRunning(t *testing.T) {
	for _, reason := range []string{ReasonNotRunning, ReasonPermissionDenied} {
		r := &fakeRunner{fn: stdout("[]")}
		res := newTestProxmox(t, pveHost{pvesh: true, local: "nodes/pve-a"}, r).Collect(context.Background(), Detection{State: DetectionPresent, Reason: reason})
		if res.Collection == CollectionOK || r.calls.Load() != 0 {
			t.Fatalf("reason %s: result = %+v, execs = %d", reason, res, r.calls.Load())
		}
	}
}

func TestProxmoxSkipsGuestsWithoutAUsableVMID(t *testing.T) {
	qemu := stdout(`[{"vmid":"abc","name":"x","status":"running"},{"vmid":-1,"name":"y"},{"vmid":0,"name":"z"},{"name":"no-id"},{"vmid":102,"status":"paused"},{"vmid":1e3,"name":"float"}]`)
	r := pveListRunner(t, qemu, stdout("[]"))
	res := newTestProxmox(t, pveHost{pvesh: true, local: "nodes/pve-a"}, r).Collect(context.Background(), Detection{State: DetectionPresent})
	// A guest that cannot be keyed is not reported, and the snapshot is not
	// complete: the server must not delete a row by its absence.
	if res.Collection != CollectionOK || res.Complete || res.Error != "invalid_entry" ||
		len(res.Workloads) != 1 || res.Workloads[0].WorkloadID != "102" || res.Workloads[0].State != StatePaused {
		t.Fatalf("result = %s", mustJSON(res))
	}
}

// `null` decodes into a nil slice without error; it must never read as an
// authoritative empty node.
func TestProxmoxNullListIsNotAnEmptyNode(t *testing.T) {
	r := pveListRunner(t, stdout("null"), stdout(string(fixture(t, "proxmox_lxc.json"))))
	res := newTestProxmox(t, pveHost{pvesh: true, local: "nodes/pve-a"}, r).Collect(context.Background(), Detection{State: DetectionPresent})
	if res.Collection != CollectionOK || res.Complete || res.Error != "qemu_list_failed" {
		t.Fatalf("result = %+v", res)
	}
	r = pveListRunner(t, stdout("null"), stdout(" null\n"))
	res = newTestProxmox(t, pveHost{pvesh: true, local: "nodes/pve-a"}, r).Collect(context.Background(), Detection{State: DetectionPresent})
	if res.Collection != CollectionError || res.Error != "decode_failed" {
		t.Fatalf("both null: %+v", res)
	}
}

// Only a missing /etc/pve/local means pmxcfs is down; any other readlink error
// is a fault to report, not a stopped service.
func TestProxmoxUnreadableLocalLinkIsNotNotRunning(t *testing.T) {
	r := &fakeRunner{fn: stdout("[]")}
	d := newTestProxmox(t, pveHost{pvesh: true, local: "nodes/pve-a"}, r)
	d.readlink = func(p string) (string, error) {
		return "", &fs.PathError{Op: "readlink", Path: p, Err: fs.ErrPermission}
	}
	if det := d.Detect(context.Background()); det.State != DetectionUnknown || det.Reason != ReasonUnreachable {
		t.Fatalf("Detect = %+v", det)
	}
	res := d.Collect(context.Background(), Detection{State: DetectionPresent})
	if res.Collection != CollectionError || res.Error != "pmxcfs_unreadable" || r.calls.Load() != 0 {
		t.Fatalf("Collect = %+v, execs = %d", res, r.calls.Load())
	}
}

func TestProxmoxStopsMappingWhenCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	d := newTestProxmox(t, pveHost{pvesh: true, local: "nodes/pve-a"}, &fakeRunner{})
	reads := 0
	d.readConf = func(string, int64) ([]byte, error) {
		reads++
		cancel()
		return []byte("onboot: 1\n"), nil
	}
	var guests []pveGuest
	if err := json.Unmarshal(fixture(t, "proxmox_qemu.json"), &guests); err != nil {
		t.Fatal(err)
	}
	d.appendGuests(ctx, nil, guests, KindVM, "pve-a", "qemu-server", hvNow())
	if reads != 1 {
		t.Fatalf("read %d configs after cancellation, want 1", reads)
	}
}

// The collector's per-driver timeout is not a parent cancellation, so the
// collector keeps the result: a Collect cut short must not look complete.
func TestProxmoxCollectCutShortIsNotOK(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	r := pveListRunner(t, stdout(string(fixture(t, "proxmox_qemu.json"))), stdout(string(fixture(t, "proxmox_lxc.json"))))
	d := newTestProxmox(t, pveHost{pvesh: true, local: "nodes/pve-a"}, r)
	d.readConf = func(string, int64) ([]byte, error) {
		cancel()
		return nil, fs.ErrNotExist
	}
	res := d.Collect(ctx, Detection{State: DetectionPresent})
	if res.Collection == CollectionOK || len(res.Workloads) != 0 || res.Error != ReasonTimeout {
		t.Fatalf("result = %+v", res)
	}
}

func TestProxmoxDisabledNeverExecs(t *testing.T) {
	r := &fakeRunner{fn: stdout("[]")}
	s := enabled()
	s.Proxmox = false
	rep := New([]Driver{newTestProxmox(t, pveHost{pvesh: true, local: "nodes/pve-a"}, r)}, WithClock(fixedNow)).Collect(context.Background(), s)
	if rt := rep.Runtimes[0]; rt.Collection != CollectionDisabled || rt.Detection != DetectionPresent {
		t.Fatalf("runtime = %+v", rt)
	}
	if r.calls.Load() != 0 {
		t.Fatalf("a disabled runtime executed %d commands", r.calls.Load())
	}
}

func TestProxmoxReportThroughCollector(t *testing.T) {
	qemu := stdout(`[{"vmid":100,"name":"we\u0000b","status":"running","uptime":5,"cpus":99999,"maxmem":-5}]`)
	r := pveListRunner(t, qemu, stdout(string(fixture(t, "proxmox_lxc.json"))))
	rep := New([]Driver{newTestProxmox(t, pveHost{pvesh: true, local: "nodes/pve-a"}, r)}, WithClock(fixedNow)).Collect(context.Background(), enabled())
	raw, _ := json.Marshal(rep)
	if strings.Contains(string(raw), `\u0000`) {
		t.Fatalf("NUL reached the wire: %s", raw)
	}
	rt := rep.Runtimes[0]
	if rt.Runtime != RuntimeProxmox || rt.Collection != CollectionOK || len(rt.Workloads) != 3 {
		t.Fatalf("runtime = %s", mustJSON(rt))
	}
	for _, w := range rt.Workloads {
		if w.WorkloadID == "100" && (w.CPUCount != nil || w.MemoryMB != nil || w.Name != "web") {
			t.Fatalf("out-of-range numbers must be null and NUL stripped: %s", mustJSON(w))
		}
	}
}

func TestOnbootFromConf(t *testing.T) {
	cases := []struct{ conf, want string }{
		{"onboot: 1\n", "always"},
		{"onboot:1\n", "always"},
		{"onboot: 0\n", "no"},
		{"cores: 2\n", "no"},
		{"cores: 2\n[snap]\nonboot: 1\n", "no"},
		{"#onboot: 1\n", "no"},
		{"onboot: maybe\n", ""},
		// an empty read (a pmxcfs hiccup) is unknown, not "never starts"
		{"", ""},
		{"\n", ""},
	}
	for _, tc := range cases {
		if got := deref(onbootPolicy([]byte(tc.conf))); got != tc.want {
			t.Errorf("onbootPolicy(%q) = %q, want %q", tc.conf, got, tc.want)
		}
	}
}

func TestReadFileLimited(t *testing.T) {
	p := filepath.Join(t.TempDir(), "100.conf")
	if err := os.WriteFile(p, []byte("onboot: 1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if b, err := readFileLimited(p, 64); err != nil || string(b) != "onboot: 1\n" {
		t.Fatalf("read = %q, %v", b, err)
	}
	if _, err := readFileLimited(p, 4); err != errTooLarge {
		t.Fatalf("oversize err = %v", err)
	}
	if _, err := readFileLimited(filepath.Join(t.TempDir(), "missing"), 64); !os.IsNotExist(err) {
		t.Fatalf("missing err = %v", err)
	}
}

func TestDpkgVersion(t *testing.T) {
	if got := dpkgPackageVersion(testdataDpkg, "pve-manager"); got != "8.2.4" {
		t.Fatalf("version = %q", got)
	}
	if got := dpkgPackageVersion(testdataDpkg, "pve-nothing"); got != "" {
		t.Fatalf("version = %q", got)
	}
	if got := dpkgPackageVersion("/nonexistent", "pve-manager"); got != "" {
		t.Fatalf("version = %q", got)
	}
}

func TestStartedAtFromUptime(t *testing.T) {
	now := time.Date(2026, 10, 6, 12, 0, 40, 0, time.UTC)
	if got := deref(startedAtFromUptime(now, 40)); got != "2026-10-06T12:00:00Z" {
		t.Fatalf("got %q", got)
	}
	if startedAtFromUptime(now, 0) != nil || startedAtFromUptime(now, -5) != nil {
		t.Fatal("no uptime must be null")
	}
	if startedAtFromUptime(now, 1<<62) != nil {
		t.Fatal("absurd uptime must be null")
	}
}
