package security

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"testing"
)

// Ubuntu ZFS-on-root layout: natively encrypted rpool, unencrypted bpool, a
// locked user dataset, a mountpoint with an escaped space, plus mounts that
// must not become volumes (a snapshot automount and a Docker zfs-driver layer).
const procMountsZfsDatasets = `sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0
rpool/ROOT/ubuntu_abc123 / zfs rw,relatime,xattr,posixacl 0 0
bpool/BOOT/ubuntu_abc123 /boot zfs rw,relatime 0 0
rpool/USERDATA/home_x1 /home zfs rw,relatime 0 0
rpool/srv/share /srv/my\040share zfs rw,relatime 0 0
rpool/USERDATA/home_x1@autosnap /home/.zfs/snapshot/autosnap zfs ro,relatime 0 0
rpool/ROOT/ubuntu_abc123/0f3c9a /var/lib/docker/zfs/graph/0f3c9a zfs rw,relatime 0 0`

var zfsLayoutProps = map[string][3]string{
	"rpool/ROOT/ubuntu_abc123": {"aes-256-gcm", "available", "rpool"},
	"bpool/BOOT/ubuntu_abc123": {"off", "-", "-"},
	"rpool/USERDATA/home_x1":   {"aes-256-gcm", "unavailable", "rpool/USERDATA"},
	"rpool/srv/share":          {"aes-256-gcm", "available", "rpool"},
}

func volumeByMount(t *testing.T, volumes []map[string]any, mount string) map[string]any {
	t.Helper()
	for _, v := range volumes {
		if v["mount"] == mount {
			return v
		}
	}
	t.Fatalf("missing volume %q in %v", mount, volumes)
	return nil
}

func TestEvaluateLinuxEncryptionZfsDatasetVolumes(t *testing.T) {
	var queried []string
	report, err := evaluateLinuxEncryption(lsblkZfsRoot, procMountsZfsDatasets, zfsDatasetsFixture(zfsLayoutProps, &queried))
	if err != nil {
		t.Fatal(err)
	}
	if report.RootErr != nil || !report.RootProtected {
		t.Fatalf("root: protected=%v err=%v, want protected", report.RootProtected, report.RootErr)
	}
	assertVolumes(t, report.Volumes, map[string]bool{
		"/boot/efi":     false,
		"/":             true,
		"/boot":         false,
		"/home":         true,
		"/srv/my share": true,
	})

	tests := []struct {
		mount  string
		want   map[string]any
		absent []string
	}{
		{"/", map[string]any{"device": "rpool/ROOT/ubuntu_abc123", "method": "zfs", "encryption": "aes-256-gcm", "status": "available", "encryptionRoot": "rpool"}, nil},
		{"/boot", map[string]any{"device": "bpool/BOOT/ubuntu_abc123", "method": "none", "encryption": "off"}, []string{"status", "encryptionRoot"}},
		// Encrypted but locked: still protected at rest; status says locked.
		{"/home", map[string]any{"device": "rpool/USERDATA/home_x1", "method": "zfs", "encryption": "aes-256-gcm", "status": "unavailable", "encryptionRoot": "rpool/USERDATA"}, nil},
		{"/srv/my share", map[string]any{"device": "rpool/srv/share", "method": "zfs"}, nil},
	}
	for _, tt := range tests {
		t.Run(tt.mount, func(t *testing.T) {
			v := volumeByMount(t, report.Volumes, tt.mount)
			for k, want := range tt.want {
				if v[k] != want {
					t.Fatalf("%s = %v, want %v (full: %v)", k, v[k], want, v)
				}
			}
			for _, k := range tt.absent {
				if _, has := v[k]; has {
					t.Fatalf("must not carry %q: %v", k, v)
				}
			}
		})
	}

	if len(queried) != 4 {
		t.Fatalf("queried %v, want exactly the 4 real mounted datasets", queried)
	}
	for _, ds := range queried {
		if strings.Contains(ds, "@") || strings.Contains(ds, "0f3c9a") {
			t.Fatalf("snapshot/container dataset %q must not be queried (queried: %v)", ds, queried)
		}
	}
	if len(report.Warnings) != 0 {
		t.Fatalf("unexpected warnings: %v", report.Warnings)
	}
}

func TestEvaluateLinuxEncryptionZfsDataPoolBesideBlockRoot(t *testing.T) {
	// ext4 root on LVM-on-LUKS (seen by lsblk) plus a separate ZFS data pool:
	// its datasets are listed even though the root never needed zfs.
	mounts := procMountsExt4 + "\ntank/data /data zfs rw,relatime 0 0\ntank/scratch /scratch zfs rw,relatime 0 0"
	props := map[string][3]string{
		"tank/data":    {"aes-256-gcm", "available", "tank/data"},
		"tank/scratch": {"off", "-", "-"},
	}
	report, err := evaluateLinuxEncryption(lsblkLvmOnLuksRoot, mounts, zfsDatasetsFixture(props, nil))
	if err != nil {
		t.Fatal(err)
	}
	if report.RootErr != nil || !report.RootProtected {
		t.Fatalf("root: protected=%v err=%v, want protected", report.RootProtected, report.RootErr)
	}
	assertVolumes(t, report.Volumes, map[string]bool{
		"/boot/efi": false, "/boot": false, "/": true, "[SWAP]": true,
		"/data": true, "/scratch": false,
	})
	if got := volumeByMount(t, report.Volumes, "/data")["method"]; got != "zfs" {
		t.Fatalf("/data method = %v, want zfs", got)
	}
}

func TestEvaluateLinuxEncryptionZfsDatasetOnLuksVdevs(t *testing.T) {
	// Native encryption off, but every rpool vdev is on LUKS: non-root
	// datasets get the same luks fallback as the root.
	mounts := procMountsZfs + "\nrpool/home /home zfs rw,relatime 0 0"
	props := map[string][3]string{
		"rpool/ROOT/ubuntu_abc123": {"off", "-", "-"},
		"rpool/home":               {"off", "-", "-"},
		"bpool/BOOT/ubuntu_abc123": {"off", "-", "-"},
	}
	report, err := evaluateLinuxEncryption(lsblkZfsOnLuks, mounts, zfsDatasetsFixture(props, nil))
	if err != nil {
		t.Fatal(err)
	}
	if home := volumeByMount(t, report.Volumes, "/home"); home["protected"] != true || home["method"] != "luks" {
		t.Fatalf("/home = %v, want protected via luks", home)
	}
	// bpool has no zfs_member vdevs in lsblk, so it cannot borrow protection.
	if boot := volumeByMount(t, report.Volumes, "/boot"); boot["protected"] != false {
		t.Fatalf("/boot = %v, want unprotected", boot)
	}
}

func TestEvaluateLinuxEncryptionZfsDatasetUnresolvedIsOmittedNotUnencrypted(t *testing.T) {
	// /home's dataset is missing from the zfs output. Listing it as
	// unprotected would count against coverage; it is omitted with a warning.
	props := map[string][3]string{
		"rpool/ROOT/ubuntu_abc123": {"aes-256-gcm", "available", "rpool"},
		"bpool/BOOT/ubuntu_abc123": {"off", "-", "-"},
	}
	mounts := procMountsZfs + "\nrpool/USERDATA/gone /home zfs rw,relatime 0 0"
	report, err := evaluateLinuxEncryption(lsblkZfsRoot, mounts, zfsDatasetsFixture(props, nil))
	if err != nil {
		t.Fatal(err)
	}
	if report.RootErr != nil || !report.RootProtected {
		t.Fatalf("root: protected=%v err=%v", report.RootProtected, report.RootErr)
	}
	assertVolumes(t, report.Volumes, map[string]bool{"/boot/efi": false, "/": true, "/boot": false})
	if len(report.Warnings) != 1 || !strings.Contains(report.Warnings[0], "rpool/USERDATA/gone") {
		t.Fatalf("warnings = %v, want one naming the unresolved dataset", report.Warnings)
	}
}

func TestEvaluateLinuxEncryptionZfsQueryFailureWithBlockRoot(t *testing.T) {
	// A failed zfs query must not change a block-device root's headline.
	mounts := procMountsExt4 + "\ntank/data /data zfs rw,relatime 0 0"
	report, err := evaluateLinuxEncryption(lsblkLvmOnLuksRoot, mounts, func([]string) (string, error) {
		return "", errors.New("zfs: command not found")
	})
	if err != nil {
		t.Fatal(err)
	}
	if report.RootErr != nil || !report.RootProtected {
		t.Fatalf("root: protected=%v err=%v", report.RootProtected, report.RootErr)
	}
	assertVolumes(t, report.Volumes, map[string]bool{"/boot/efi": false, "/boot": false, "/": true, "[SWAP]": true})
	if len(report.Warnings) != 1 || !strings.Contains(report.Warnings[0], "command not found") {
		t.Fatalf("warnings = %v, want the zfs failure", report.Warnings)
	}
}

func TestEvaluateLinuxEncryptionZfsRootQueryFailureWarnsOnce(t *testing.T) {
	// The root's failure is already the headline error; the non-root
	// datasets that shared the failed query get one warning, not one each.
	report, err := evaluateLinuxEncryption(lsblkZfsRoot, procMountsZfsDatasets, func([]string) (string, error) {
		return "", errors.New("zfs: command not found")
	})
	if err != nil {
		t.Fatal(err)
	}
	if report.RootErr == nil {
		t.Fatal("expected RootErr")
	}
	assertVolumes(t, report.Volumes, map[string]bool{"/boot/efi": false})
	if len(report.Warnings) != 1 {
		t.Fatalf("warnings = %v, want exactly one", report.Warnings)
	}
}

func TestEvaluateLinuxEncryptionZfsDatasetCap(t *testing.T) {
	var b strings.Builder
	props := map[string][3]string{}
	for i := 0; i < maxZfsDatasetVolumes+5; i++ {
		ds := "tank/d" + strconv.Itoa(i)
		b.WriteString(ds + " /mnt/" + strconv.Itoa(i) + " zfs rw 0 0\n")
		props[ds] = [3]string{"off", "-", "-"}
	}
	var queried []string
	report, err := evaluateLinuxEncryption(lsblkLvmOnLuksRoot, procMountsExt4+"\n"+b.String(), zfsDatasetsFixture(props, &queried))
	if err != nil {
		t.Fatal(err)
	}
	if len(queried) != maxZfsDatasetVolumes {
		t.Fatalf("queried %d datasets, want cap %d", len(queried), maxZfsDatasetVolumes)
	}
	zfsVols := 0
	for _, v := range report.Volumes {
		if _, ok := v["encryption"]; ok {
			zfsVols++
		}
	}
	if zfsVols != maxZfsDatasetVolumes {
		t.Fatalf("got %d zfs volumes, want %d", zfsVols, maxZfsDatasetVolumes)
	}
	if len(report.Warnings) != 1 || !strings.Contains(report.Warnings[0], "5 more") {
		t.Fatalf("warnings = %v, want the omitted count", report.Warnings)
	}
}

func TestEvaluateLinuxEncryptionZfsRootSurvivesCap(t *testing.T) {
	// The root dataset is always queried, even when it is mounted after the
	// cap's worth of other datasets.
	var b strings.Builder
	props := map[string][3]string{"rpool/ROOT/ubuntu_abc123": {"aes-256-gcm", "available", "rpool"}}
	for i := 0; i < maxZfsDatasetVolumes+1; i++ {
		ds := "tank/d" + strconv.Itoa(i)
		b.WriteString(ds + " /mnt/" + strconv.Itoa(i) + " zfs rw 0 0\n")
		props[ds] = [3]string{"off", "-", "-"}
	}
	b.WriteString("rpool/ROOT/ubuntu_abc123 / zfs rw 0 0\n")
	report, err := evaluateLinuxEncryption(lsblkZfsRoot, b.String(), zfsDatasetsFixture(props, nil))
	if err != nil {
		t.Fatal(err)
	}
	if report.RootErr != nil || !report.RootProtected {
		t.Fatalf("root: protected=%v err=%v", report.RootProtected, report.RootErr)
	}
}

func TestLinuxEncryptionDetailsWarnings(t *testing.T) {
	d := linuxEncryptionDetails(linuxEncryptionReport{Volumes: []map[string]any{}})
	if _, has := d["warnings"]; has {
		t.Fatalf("no warnings key expected when there are none: %v", d)
	}
	d = linuxEncryptionDetails(linuxEncryptionReport{Volumes: []map[string]any{}, Warnings: []string{"w"}})
	if w, _ := d["warnings"].([]string); len(w) != 1 || w[0] != "w" {
		t.Fatalf("warnings = %v", d["warnings"])
	}
}

func TestQueryZfsDatasets(t *testing.T) {
	row := func(ds string) string { return ds + "\tencryption\toff\n" }
	t.Run("one batched call", func(t *testing.T) {
		calls := 0
		out, err := queryZfsDatasets([]string{"a/x", "b/y"}, func([]string) (string, error) {
			calls++
			return row("a/x") + row("b/y"), nil
		})
		if err != nil || calls != 1 || !strings.Contains(out, "b/y") {
			t.Fatalf("out=%q err=%v calls=%d", out, err, calls)
		}
	})
	t.Run("batch failure falls back per dataset", func(t *testing.T) {
		// One dataset vanished: the batch exits non-zero, the survivors are
		// still answered individually.
		out, err := queryZfsDatasets([]string{"a/x", "gone/z", "b/y"}, func(datasets []string) (string, error) {
			if len(datasets) > 1 || datasets[0] == "gone/z" {
				return "", errors.New("cannot open 'gone/z': dataset does not exist")
			}
			return row(datasets[0]), nil
		})
		if err != nil || !strings.Contains(out, "a/x") || !strings.Contains(out, "b/y") {
			t.Fatalf("out=%q err=%v", out, err)
		}
	})
	t.Run("single dataset failure is not retried", func(t *testing.T) {
		calls := 0
		_, err := queryZfsDatasets([]string{"a/x"}, func([]string) (string, error) {
			calls++
			return "", errors.New("boom")
		})
		if err == nil || calls != 1 {
			t.Fatalf("err=%v calls=%d", err, calls)
		}
	})
	t.Run("every call fails returns the error", func(t *testing.T) {
		_, err := queryZfsDatasets([]string{"a/x", "b/y"}, func([]string) (string, error) {
			return "", errors.New("zfs: command not found")
		})
		if err == nil || !strings.Contains(err.Error(), "command not found") {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestParseZfsGetOutput(t *testing.T) {
	out := "rpool/a\tencryption\tAES-256-GCM\nrpool/a\tkeystatus\tavailable\nrpool/a\tencryptionroot\trpool\n" +
		"bpool/b\tencryption\toff\n" +
		"garbage line\n"
	got := parseZfsGetOutput(out)
	if p := got["rpool/a"]; p.encryption != "aes-256-gcm" || p.keystatus != "available" || p.encryptionRoot != "rpool" {
		t.Fatalf("rpool/a = %+v", p)
	}
	if p := got["bpool/b"]; p.encryption != "off" || p.keystatus != "" {
		t.Fatalf("bpool/b = %+v", p)
	}
	if len(got) != 2 {
		t.Fatalf("got %d datasets, want 2: %+v", len(got), got)
	}
}

func TestUnescapeMountField(t *testing.T) {
	for in, want := range map[string]string{
		`/srv/my\040share`: "/srv/my share",
		`/a\011b\134c`:     "/a\tb\\c",
		`/plain`:           "/plain",
		`/bad\09`:          `/bad\09`,
		`/trailing\`:       `/trailing\`,
	} {
		if got := unescapeMountField(in); got != want {
			t.Fatalf("unescapeMountField(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestQueryZfsDatasetsRetryBookkeeping(t *testing.T) {
	row := func(ds string) string { return ds + "\tencryption\toff\n" }
	gone := func(calls *int) zfsGetFunc {
		return func(datasets []string) (string, error) {
			*calls++
			if len(datasets) > 1 || datasets[0] == "gone/z" {
				return "", errors.New("cannot open 'gone/z': dataset does not exist")
			}
			return row(datasets[0]), nil
		}
	}

	t.Run("survivors answered, vanished dataset absent", func(t *testing.T) {
		calls := 0
		out, err := queryZfsDatasets([]string{"a/x", "gone/z", "b/y"}, gone(&calls))
		if err != nil || calls != 4 {
			t.Fatalf("err=%v calls=%d, want nil and 1 batch + 3 retries", err, calls)
		}
		if strings.Contains(out, "gone/z") {
			t.Fatalf("vanished dataset must be absent: %q", out)
		}
	})
	t.Run("batch timeout is not retried", func(t *testing.T) {
		calls := 0
		_, err := queryZfsDatasets([]string{"a/x", "b/y"}, func([]string) (string, error) {
			calls++
			return "", fmt.Errorf("command timed out: zfs: %w", context.DeadlineExceeded)
		})
		if !errors.Is(err, context.DeadlineExceeded) || calls != 1 {
			t.Fatalf("err=%v calls=%d", err, calls)
		}
	})
	t.Run("retry timeout stops the retries", func(t *testing.T) {
		calls := 0
		out, err := queryZfsDatasets([]string{"a/x", "b/y", "c/z"}, func(datasets []string) (string, error) {
			calls++
			switch {
			case len(datasets) > 1:
				return "", errors.New("batch failed")
			case datasets[0] == "b/y":
				return "", fmt.Errorf("command timed out: zfs: %w", context.DeadlineExceeded)
			}
			return row(datasets[0]), nil
		})
		if err != nil || calls != 3 || !strings.Contains(out, "a/x") || strings.Contains(out, "c/z") {
			t.Fatalf("out=%q err=%v calls=%d, want a/x only after 3 calls", out, err, calls)
		}
	})
	t.Run("spent budget skips the retries", func(t *testing.T) {
		saved := zfsRetryBudget
		zfsRetryBudget = -1
		defer func() { zfsRetryBudget = saved }()
		calls := 0
		_, err := queryZfsDatasets([]string{"a/x", "gone/z"}, gone(&calls))
		if err == nil || calls != 1 {
			t.Fatalf("err=%v calls=%d, want the batch error and no retries", err, calls)
		}
	})
}

func TestEvaluateLinuxEncryptionZfsPartialBatchEndToEnd(t *testing.T) {
	// The real composition: a batch that fails because one dataset vanished,
	// retried per dataset, feeding the evaluation.
	mounts := procMountsZfs + "\nrpool/USERDATA/gone /home zfs rw 0 0"
	answer := zfsDatasetsFixture(map[string][3]string{
		"rpool/ROOT/ubuntu_abc123": {"aes-256-gcm", "available", "rpool"},
		"bpool/BOOT/ubuntu_abc123": {"off", "-", "-"},
	}, nil)
	run := func(datasets []string) (string, error) {
		return queryZfsDatasets(datasets, func(ds []string) (string, error) {
			for _, d := range ds {
				if d == "rpool/USERDATA/gone" {
					return "", errors.New("cannot open 'rpool/USERDATA/gone': dataset does not exist")
				}
			}
			return answer(ds)
		})
	}
	report, err := evaluateLinuxEncryption(lsblkZfsRoot, mounts, run)
	if err != nil {
		t.Fatal(err)
	}
	if report.RootErr != nil || !report.RootProtected {
		t.Fatalf("root: protected=%v err=%v", report.RootProtected, report.RootErr)
	}
	assertVolumes(t, report.Volumes, map[string]bool{"/boot/efi": false, "/": true, "/boot": false})
	if len(report.Warnings) != 1 || !strings.Contains(report.Warnings[0], "rpool/USERDATA/gone (/home)") {
		t.Fatalf("warnings = %v", report.Warnings)
	}
}

func TestEvaluateLinuxEncryptionZfsRootDatasetGoneOthersAnswer(t *testing.T) {
	props := map[string][3]string{"bpool/BOOT/ubuntu_abc123": {"off", "-", "-"}}
	report, err := evaluateLinuxEncryption(lsblkZfsRoot, procMountsZfs, zfsDatasetsFixture(props, nil))
	if err != nil {
		t.Fatal(err)
	}
	if report.RootErr == nil || !strings.Contains(report.RootErr.Error(), "rpool/ROOT/ubuntu_abc123") {
		t.Fatalf("RootErr = %v, want the root dataset named", report.RootErr)
	}
	assertVolumes(t, report.Volumes, map[string]bool{"/boot/efi": false, "/boot": false})
	if len(report.Warnings) != 0 {
		t.Fatalf("root failure belongs in RootErr only, got warnings %v", report.Warnings)
	}
}

func TestEvaluateLinuxEncryptionZfsDatasetMountedTwice(t *testing.T) {
	// A bind mount or repeat mount of a dataset adds no volume; nor does a
	// second mount of the root dataset.
	mounts := procMountsZfs + "\ntank/data /data zfs rw 0 0\ntank/data /srv/data zfs rw 0 0\nrpool/ROOT/ubuntu_abc123 /mnt/root zfs rw 0 0"
	var queried []string
	props := map[string][3]string{
		"rpool/ROOT/ubuntu_abc123": {"aes-256-gcm", "available", "rpool"},
		"bpool/BOOT/ubuntu_abc123": {"off", "-", "-"},
		"tank/data":                {"aes-256-gcm", "available", "tank"},
	}
	report, err := evaluateLinuxEncryption(lsblkZfsRoot, mounts, zfsDatasetsFixture(props, &queried))
	if err != nil {
		t.Fatal(err)
	}
	assertVolumes(t, report.Volumes, map[string]bool{"/boot/efi": false, "/": true, "/boot": false, "/data": true})
	if len(queried) != 3 {
		t.Fatalf("queried %v, want each dataset once", queried)
	}
}

func TestEvaluateLinuxEncryptionZfsUnresolvedWarningIsAggregated(t *testing.T) {
	var b strings.Builder
	for i := 0; i < maxUnresolvedNamesShown+3; i++ {
		b.WriteString("tank/d" + strconv.Itoa(i) + " /mnt/" + strconv.Itoa(i) + " zfs rw 0 0\n")
	}
	report, err := evaluateLinuxEncryption(lsblkLvmOnLuksRoot, procMountsExt4+"\n"+b.String(), zfsDatasetsFixture(nil, nil))
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Warnings) != 1 || !strings.Contains(report.Warnings[0], "13 zfs datasets not evaluated") || !strings.HasSuffix(report.Warnings[0], "and 3 more") {
		t.Fatalf("warnings = %v, want one aggregated warning", report.Warnings)
	}
}

func TestEvaluateLinuxEncryptionZfsQueryFailurePlusCap(t *testing.T) {
	var b strings.Builder
	for i := 0; i < maxZfsDatasetVolumes+2; i++ {
		b.WriteString("tank/d" + strconv.Itoa(i) + " /mnt/" + strconv.Itoa(i) + " zfs rw 0 0\n")
	}
	report, err := evaluateLinuxEncryption(lsblkLvmOnLuksRoot, procMountsExt4+"\n"+b.String(), func([]string) (string, error) {
		return "", errors.New("zfs: command not found")
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Warnings) != 2 || !strings.Contains(report.Warnings[0], "command not found") || !strings.Contains(report.Warnings[1], "2 more") {
		t.Fatalf("warnings = %v, want the query failure and the cap", report.Warnings)
	}
}

func TestParseZfsGetOutputMalformed(t *testing.T) {
	for _, out := range []string{"", "rpool/a\tencryption\n", "rpool/a encryption off\n"} {
		if got := parseZfsGetOutput(out); len(got) != 0 {
			t.Fatalf("parseZfsGetOutput(%q) = %+v, want empty", out, got)
		}
	}
	// Valid shape with "-" (pre-0.8) is parsed, then rejected as unusable.
	got := parseZfsGetOutput("rpool/a\tencryption\t-\n")
	if _, err := zfsDatasetPropsFor(got, "rpool/a", nil); err == nil {
		t.Fatal("encryption \"-\" must not be usable")
	}
}
