package rebuild

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestConvert_VhdxRunsQemuImgAndRemovesRaw(t *testing.T) {
	dir := t.TempDir()
	fs := newFakeSystem(dir, 100*GiB)
	out := filepath.Join(dir, "out.vhdx")
	raw := out + ".raw"
	if err := os.WriteFile(raw, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	r := &run{opts: Options{Target: Target{Kind: TargetVHDX, Path: out}, System: fs}, sys: fs, result: &Result{}}
	if err := convert(context.Background(), r); err != nil {
		t.Fatalf("convert: %v\n%s", err, fs.dump())
	}
	want := strings.Join([]string{"qemu-img", "convert", "-f", "raw", "-O", "vhdx", "-o", "subformat=dynamic", raw, out}, " ")
	if got := strings.Join(fs.lastRun, " "); got != want {
		t.Fatalf("last command = %q, want %q", got, want)
	}
	if _, err := os.Stat(raw); !os.IsNotExist(err) {
		t.Fatalf("raw staging file must be deleted after conversion (stat err=%v)", err)
	}
	if len(r.result.Phases) != 0 {
		t.Fatalf("a real conversion must leave phase bookkeeping to the engine loop, got %+v", r.result.Phases)
	}
}

func TestConvert_QemuImgFailureIsAnError(t *testing.T) {
	dir := t.TempDir()
	fs := newFakeSystem(dir, 100*GiB)
	fs.fail["qemu-img"] = os.ErrPermission
	out := filepath.Join(dir, "out.vhdx")
	if err := os.WriteFile(out+".raw", []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	r := &run{opts: Options{Target: Target{Kind: TargetVHDX, Path: out}, System: fs}, sys: fs, result: &Result{}}
	err := convert(context.Background(), r)
	if err == nil || !strings.Contains(err.Error(), "qemu-img convert") {
		t.Fatalf("err = %v, want a qemu-img convert error", err)
	}
	if _, statErr := os.Stat(out + ".raw"); statErr != nil {
		t.Fatalf("raw staging file must survive a failed conversion (stat err=%v)", statErr)
	}
}

func TestConvert_SkippedForDiskAndImage(t *testing.T) {
	for _, kind := range []TargetKind{TargetDisk, TargetImage} {
		fs := newFakeSystem(t.TempDir(), 100*GiB)
		r := &run{opts: Options{Target: Target{Kind: kind, Path: "/x"}, System: fs}, sys: fs, result: &Result{}}
		if err := convert(context.Background(), r); err != nil {
			t.Fatalf("%s: convert: %v", kind, err)
		}
		if len(r.result.Phases) != 1 {
			t.Fatalf("%s: phases = %+v, want exactly one skipped record", kind, r.result.Phases)
		}
		last := r.result.Phases[len(r.result.Phases)-1]
		if last.Phase != PhaseConvert || last.Status != PhaseSkipped || last.Message != "not an image conversion target" {
			t.Fatalf("%s: last phase = %+v", kind, last)
		}
		if fs.has("qemu-img") {
			t.Fatalf("%s: qemu-img must not run\n%s", kind, fs.dump())
		}
	}
}

func TestTargetRawPath(t *testing.T) {
	for _, tt := range []struct {
		target Target
		want   string
	}{
		{Target{Kind: TargetVHDX, Path: "/srv/rebuild/dev-1.vhdx"}, "/srv/rebuild/dev-1.vhdx.raw"},
		{Target{Kind: TargetImage, Path: "/srv/rebuild/dev-1.img"}, "/srv/rebuild/dev-1.img"},
		{Target{Kind: TargetDisk, Path: "/dev/sdb"}, ""},
	} {
		if got := tt.target.RawPath(); got != tt.want {
			t.Errorf("%s %s: RawPath() = %q, want %q", tt.target.Kind, tt.target.Path, got, tt.want)
		}
	}
}

func TestAllPhases_ConvertIsLast(t *testing.T) {
	if len(AllPhases) != 8 || AllPhases[len(AllPhases)-1] != PhaseConvert {
		t.Fatalf("AllPhases = %v, want eight entries ending in %q", AllPhases, PhaseConvert)
	}
}

// Lab run 2026-09-19: grub-install mounted efivarfs inside the chroot's
// /sys, so the plain umount of /sys — and then of the root partition —
// failed "target is busy". Those were only warnings, and convert went on to
// read a raw image whose ext4 was still mounted read-write.
func TestConvert_RefusesWhenStagingImageWasNotReleased(t *testing.T) {
	dir := t.TempDir()
	fs := newFakeSystem(dir, 100*GiB)
	root := filepath.Join(dir, "mnt")
	fs.fail["umount "+root] = os.ErrPermission
	out := filepath.Join(dir, "out.vhdx")
	if err := os.WriteFile(out+".raw", []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	r := &run{opts: Options{Target: Target{Kind: TargetVHDX, Path: out}, System: fs}, sys: fs, result: &Result{}, rootMount: root}
	r.teardown()
	err := convert(context.Background(), r)
	if err == nil || !strings.Contains(err.Error(), "still in use") {
		t.Fatalf("err = %v, want a refusal because the staging image is still in use", err)
	}
	for _, c := range fs.cmds {
		if strings.HasPrefix(c, "qemu-img") {
			t.Fatalf("qemu-img must not read a still-mounted image, ran %q", c)
		}
	}
	if _, statErr := os.Stat(out + ".raw"); statErr != nil {
		t.Fatalf("raw staging file must survive a refused conversion (stat err=%v)", statErr)
	}
}

func TestConvert_RefusesWhenDetachFailed(t *testing.T) {
	dir := t.TempDir()
	fs := newFakeSystem(dir, 100*GiB)
	out := filepath.Join(dir, "out.vhdx")
	if err := os.WriteFile(out+".raw", []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	r := &run{opts: Options{Target: Target{Kind: TargetVHDX, Path: out}, System: fs}, sys: fs, result: &Result{},
		detach: func() error { return os.ErrPermission }}
	r.teardown()
	if err := convert(context.Background(), r); err == nil || !strings.Contains(err.Error(), "still in use") {
		t.Fatalf("err = %v, want a refusal because the loop device was not detached", err)
	}
}

// The release guard is not VHDX-only: a raw image or a physical disk handed
// back as "completed" while its root partition is still mounted is the same
// defect, so validate — the phase that releases the target — must fail.
func TestValidate_FailsWhenTargetWasNotReleased(t *testing.T) {
	for _, kind := range []TargetKind{TargetDisk, TargetImage, TargetVHDX} {
		t.Run(string(kind), func(t *testing.T) {
			dir := t.TempDir()
			fs := newFakeSystem(dir, 100*GiB)
			root := filepath.Join(dir, "mnt")
			fs.fail["umount "+root] = os.ErrPermission
			r := &run{opts: Options{Target: Target{Kind: kind}, SkipBoot: true}, sys: fs, staging: root, rootMount: root, result: &Result{Plan: &Plan{}}}
			err := validate(context.Background(), r)
			if err == nil || !strings.Contains(err.Error(), "still in use") {
				t.Fatalf("err = %v, want validate to fail because the target is still in use", err)
			}
		})
	}
}
