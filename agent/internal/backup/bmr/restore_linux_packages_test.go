//go:build linux

package bmr

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestReinstallDnf_SkipsInvalidNamesAndEndsOptions(t *testing.T) {
	withEtcTarget(t)
	calls := fakeCommands(t, nil)
	staging := t.TempDir()
	mustWriteFile(t, filepath.Join(staging, "packages", "rpm.txt"), "vim-8.2.x86_64\n--installroot=/tmp/x\n-y\nbash-5.1.x86_64\n")

	r := &linuxRestorer{}
	if err := r.RestoreSystemState(staging); err != nil {
		t.Fatalf("RestoreSystemState: %v", err)
	}
	var dnf *recordedCommand
	for i := range *calls {
		if (*calls)[i].name == "dnf" {
			dnf = &(*calls)[i]
		}
	}
	if dnf == nil {
		t.Fatalf("dnf not invoked: %+v", *calls)
	}
	want := "install -y -- vim-8.2.x86_64 bash-5.1.x86_64"
	if got := strings.Join(dnf.args, " "); got != want {
		t.Fatalf("dnf argv = %q, want %q", got, want)
	}
	if w := strings.Join(r.Warnings(), "\n"); !strings.Contains(w, "skipped 2") {
		t.Fatalf("warnings %q do not count the 2 skipped entries", w)
	}
}

func TestReinstallDnf_AllInvalid_DnfNotRun(t *testing.T) {
	withEtcTarget(t)
	calls := fakeCommands(t, nil)
	staging := t.TempDir()
	mustWriteFile(t, filepath.Join(staging, "packages", "rpm.txt"), "--installroot=/tmp/x\n")

	r := &linuxRestorer{}
	if err := r.RestoreSystemState(staging); err != nil {
		t.Fatalf("RestoreSystemState: %v", err)
	}
	if containsCall(*calls, "dnf", "") {
		t.Fatalf("dnf ran with no valid package names: %+v", *calls)
	}
	if len(r.Warnings()) == 0 {
		t.Fatal("no warning for the skipped entry")
	}
}

func TestReinstallDpkg_InvalidSelectionLine_StepSkipped(t *testing.T) {
	withEtcTarget(t)
	calls := fakeCommands(t, nil)
	staging := t.TempDir()
	mustWriteFile(t, filepath.Join(staging, "packages", "dpkg.txt"), "vim\tinstall\n--admindir=/tmp/x\tinstall\n")

	r := &linuxRestorer{}
	if err := r.RestoreSystemState(staging); err != nil {
		t.Fatalf("RestoreSystemState: %v", err)
	}
	for _, c := range *calls {
		joined := c.name + " " + strings.Join(c.args, " ")
		if strings.Contains(joined, "dpkg --set-selections") || strings.Contains(joined, "dselect-upgrade") {
			t.Fatalf("selections with an invalid line were applied: %q", joined)
		}
	}
	if w := strings.Join(r.Warnings(), "\n"); !strings.Contains(w, "1 invalid line") {
		t.Fatalf("warnings %q do not report the invalid line", w)
	}
}
