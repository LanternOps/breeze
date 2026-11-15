package rebuild

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Planned mount points come from the snapshot's layout. Each one must name a
// directory inside the staging root, and the mount target is reached without
// following a link.

func TestPlanPartitionsRefusesUnsafeMountPoints(t *testing.T) {
	for _, mountPoint := range []string{"/../../etc", "/boot/../../root", "boot", "/boot/", "/boot//efi", "/./boot", "/"} {
		t.Run(mountPoint, func(t *testing.T) {
			src := srcDisk()
			src.Partitions[1].MountPoint = mountPoint
			if _, err := PlanPartitions(src, 100*GiB, 512); err == nil {
				t.Fatalf("mount point %q accepted", mountPoint)
			}
		})
	}
	if _, err := PlanPartitions(srcDisk(), 100*GiB, 512); err != nil {
		t.Fatalf("regular layout: %v", err)
	}
}

func mountTreeRun(t *testing.T, mountPoints ...string) (*run, *fakeSystem) {
	t.Helper()
	dir := t.TempDir()
	sys := newFakeSystem(dir, 100*GiB)
	staging := filepath.Join(dir, "mnt")
	plan := &Plan{}
	for i, mp := range mountPoints {
		plan.Partitions = append(plan.Partitions, PlannedPartition{Number: i + 1, Filesystem: "ext4", MountPoint: mp})
	}
	return &run{sys: sys, staging: staging, disk: "/dev/loop9", result: &Result{Plan: plan}}, sys
}

func TestMountTreeRefusesUnsafeMountPoint(t *testing.T) {
	r, sys := mountTreeRun(t, "/", "/../../outside")
	if err := mountTree(context.Background(), r); err == nil {
		t.Fatal("expected an error for a mount point outside the staging root")
	}
	for _, c := range sys.cmds {
		if strings.Contains(c, "outside") {
			t.Fatalf("mounted outside the staging root: %v", sys.cmds)
		}
	}
	if _, err := os.Lstat(filepath.Join(filepath.Dir(r.staging), "..", "outside")); !os.IsNotExist(err) {
		t.Fatalf("directory created outside the staging root: %v", err)
	}
}

func TestMountTreeRefusesLinkedTarget(t *testing.T) {
	r, sys := mountTreeRun(t, "/", "/boot")
	other := t.TempDir()
	mustMkdirAll(t, r.staging)
	symlinkOrSkip(t, other, filepath.Join(r.staging, "boot"))
	if err := mountTree(context.Background(), r); err == nil {
		t.Fatal("expected an error for a mount target that is a link")
	}
	for _, c := range sys.cmds {
		if strings.HasSuffix(c, filepath.Join(r.staging, "boot")) || strings.Contains(c, other) {
			t.Fatalf("mounted onto a link: %v", sys.cmds)
		}
	}
	assertDirEmpty(t, other)
}

func TestMountTreeRegularTargets(t *testing.T) {
	r, sys := mountTreeRun(t, "/", "/boot", "/boot/efi")
	if err := mountTree(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if len(sys.mountLog) != 3 || r.rootMount != r.staging || len(r.treeMounts) != 2 {
		t.Fatalf("mounts = %v root=%q tree=%v", sys.mountLog, r.rootMount, r.treeMounts)
	}
}

// A mount target must not sit under a directory in the tree that other users
// can write to: the mount names the target by path.
func TestMountTreeRefusesSharedWritableAncestor(t *testing.T) {
	linuxEngineOnly(t)
	for _, tc := range []struct {
		name, dir, mountPoint string
		mode                  os.FileMode
	}{
		{"sticky-world", "tmp", "/tmp/data", os.ModeSticky | 0o777},
		{"group-writable", "srv", "/srv/data", 0o775},
		{"world-writable", "opt", "/opt/data", 0o757},
		{"root", ".", "/boot", 0o777},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, sys := mountTreeRun(t, "/", tc.mountPoint)
			dir := filepath.Join(r.staging, tc.dir)
			mustMkdirAll(t, dir)
			if err := os.Chmod(dir, tc.mode); err != nil {
				t.Fatal(err)
			}
			if err := mountTree(context.Background(), r); err == nil {
				t.Fatalf("mounted %s under a directory other users can write", tc.mountPoint)
			}
			target := filepath.Join(r.staging, filepath.FromSlash(strings.TrimPrefix(tc.mountPoint, "/")))
			for _, c := range sys.cmds {
				if strings.HasSuffix(c, target) {
					t.Fatalf("mount ran: %v", sys.cmds)
				}
			}
		})
	}
}

// The engine state directory is made private, and a staging root under a
// directory other users can write to is refused before any phase runs.
func TestRunPreparesPrivateDirectories(t *testing.T) {
	linuxEngineOnly(t)
	t.Run("state-directory", func(t *testing.T) {
		state := filepath.Join(t.TempDir(), "state")
		mustMkdirAll(t, state)
		if err := os.Chmod(state, 0o777); err != nil {
			t.Fatal(err)
		}
		_, _ = Run(context.Background(), Options{SnapshotID: "snap1", Provider: &memProvider{files: map[string][]byte{}}, Target: Target{Kind: TargetImage, Path: filepath.Join(t.TempDir(), "x.img")}, StateDir: state})
		info, err := os.Stat(state)
		if err != nil || info.Mode().Perm() != 0o700 {
			t.Fatalf("state directory mode %v %v, want 0700", info.Mode(), err)
		}
	})
	for _, mode := range []os.FileMode{0o777, os.ModeSticky | 0o777, 0o775} {
		t.Run(fmt.Sprint("staging-parent-", mode), func(t *testing.T) {
			parent := filepath.Join(t.TempDir(), "shared")
			mustMkdirAll(t, parent)
			if err := os.Chmod(parent, mode); err != nil {
				t.Fatal(err)
			}
			_, err := Run(context.Background(), Options{SnapshotID: "snap1", Provider: &memProvider{files: map[string][]byte{}}, Target: Target{Kind: TargetImage, Path: filepath.Join(t.TempDir(), "x.img")}, StateDir: t.TempDir(), StagingRoot: filepath.Join(parent, "mnt")})
			if err == nil || !strings.Contains(err.Error(), "writable by other users") {
				t.Fatalf("Run = %v, want a refusal of the shared staging parent", err)
			}
		})
	}
}

// Directories only their owner can write pass the shared-write checks on
// every host the package's tests run on, including a Windows host driving
// the Linux engine.
func TestOwnerOnlyDirectoriesPassTheSharedWriteChecks(t *testing.T) {
	root := t.TempDir()
	staging := filepath.Join(root, "mnt")
	mustMkdirAll(t, filepath.Join(staging, "boot"))
	if err := prepareRunDirs(filepath.Join(root, "state"), staging); err != nil {
		t.Fatalf("prepareRunDirs: %v", err)
	}
	if err := checkMountAncestors(staging, filepath.Join("boot", "efi")); err != nil {
		t.Fatalf("checkMountAncestors: %v", err)
	}
}
