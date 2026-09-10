package rebuild

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
)

// fakeSystem records every command, "mounts" devices by creating directories,
// and answers size/mount questions from fields. Files restored under a
// mounted dir land in the real filesystem under fake.dir, so later phases
// and assertions can inspect them.
type fakeSystem struct {
	mu       sync.Mutex
	dir      string   // temp root
	cmds     []string // "name arg1 arg2"
	diskSize int64
	mounted  []string // devices reported by MountedSources
	rootSrcs []string
	fail     map[string]error // command prefix → error
	arch     string
	mountLog []string // "device dir"
	unmounts []string
}

func newFakeSystem(dir string, diskSize int64) *fakeSystem {
	return &fakeSystem{dir: dir, diskSize: diskSize, fail: map[string]error{}, arch: "amd64"}
}

func (f *fakeSystem) record(name string, args ...string) ([]byte, error) {
	line := strings.TrimSpace(name + " " + strings.Join(args, " "))
	f.mu.Lock()
	f.cmds = append(f.cmds, line)
	f.mu.Unlock()
	for prefix, err := range f.fail {
		if strings.HasPrefix(line, prefix) {
			return []byte("simulated failure"), err
		}
	}
	return nil, nil
}

func (f *fakeSystem) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	return f.record(name, args...)
}
func (f *fakeSystem) Chroot(root string) func(context.Context, string, ...string) ([]byte, error) {
	return func(_ context.Context, name string, args ...string) ([]byte, error) {
		return f.record("chroot", append([]string{root, name}, args...)...)
	}
}
func (f *fakeSystem) BlockDeviceSize(string) (int64, error) { return f.diskSize, nil }
func (f *fakeSystem) AttachImage(path string, size int64) (string, func() error, error) {
	_, _ = f.record("losetup", "--find", "--show", "--partscan", path)
	return "/dev/loop7", func() error { _, _ = f.record("losetup", "-d", "/dev/loop7"); return nil }, nil
}
func (f *fakeSystem) PartitionDevice(disk string, n int) string { return partitionDevice(disk, n) }
func (f *fakeSystem) Rescan(_ context.Context, disk string) error {
	_, err := f.record("partprobe", disk)
	return err
}
func (f *fakeSystem) MountedSources() ([]string, error) { return f.mounted, nil }
func (f *fakeSystem) RootSources() ([]string, error)    { return f.rootSrcs, nil }
func (f *fakeSystem) Mount(_ context.Context, device, dir, fstype string, opts ...string) error {
	_, err := f.record("mount", append([]string{"-t", fstype, device, dir}, opts...)...)
	if err != nil {
		return err
	}
	f.mountLog = append(f.mountLog, device+" "+dir)
	return os.MkdirAll(dir, 0o755)
}
func (f *fakeSystem) BindMount(_ context.Context, src, dir string) error {
	_, err := f.record("mount", "--bind", src, dir)
	if err != nil {
		return err
	}
	return os.MkdirAll(dir, 0o755)
}
func (f *fakeSystem) Unmount(_ context.Context, dir string) error {
	f.unmounts = append(f.unmounts, dir)
	_, err := f.record("umount", dir)
	return err
}
func (f *fakeSystem) Sync(context.Context) error { _, err := f.record("sync"); return err }
func (f *fakeSystem) Arch() string               { return f.arch }

func (f *fakeSystem) has(prefix string) bool {
	for _, c := range f.cmds {
		if strings.HasPrefix(c, prefix) {
			return true
		}
	}
	return false
}

func (f *fakeSystem) indexOf(prefix string) int {
	for i, c := range f.cmds {
		if strings.HasPrefix(c, prefix) {
			return i
		}
	}
	return -1
}

func (f *fakeSystem) dump() string {
	return fmt.Sprintf("commands:\n  %s", strings.Join(f.cmds, "\n  "))
}

var _ System = (*fakeSystem)(nil)
