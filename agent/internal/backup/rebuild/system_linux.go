//go:build linux

package rebuild

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
)

type realSystem struct{}

// NewSystem returns the real OS implementation.
func NewSystem() System { return realSystem{} }

func (realSystem) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

func (s realSystem) Chroot(root string) func(context.Context, string, ...string) ([]byte, error) {
	return func(ctx context.Context, name string, args ...string) ([]byte, error) {
		return s.Run(ctx, "chroot", append([]string{root, name}, args...)...)
	}
}

func (s realSystem) BlockDeviceSize(path string) (int64, error) {
	out, err := s.Run(context.Background(), "blockdev", "--getsize64", path)
	if err != nil {
		return 0, fmt.Errorf("blockdev --getsize64 %s: %s: %w", path, strings.TrimSpace(string(out)), err)
	}
	return strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64)
}

func (s realSystem) AttachImage(path string, sizeBytes int64) (string, func() error, error) {
	if _, err := os.Stat(path); os.IsNotExist(err) {
		if sizeBytes <= 0 {
			return "", nil, fmt.Errorf("image %s does not exist and no size was given", path)
		}
		f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0o600)
		if err != nil {
			return "", nil, err
		}
		if err := f.Truncate(sizeBytes); err != nil {
			_ = f.Close()
			return "", nil, err
		}
		_ = f.Close()
	}
	out, err := s.Run(context.Background(), "losetup", "--find", "--show", "--partscan", path)
	if err != nil {
		return "", nil, fmt.Errorf("losetup %s: %s: %w", path, strings.TrimSpace(string(out)), err)
	}
	dev := strings.TrimSpace(string(out))
	return dev, func() error { _, err := s.Run(context.Background(), "losetup", "-d", dev); return err }, nil
}

func (realSystem) PartitionDevice(disk string, n int) string { return partitionDevice(disk, n) }

func (realSystem) Exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func (s realSystem) Rescan(ctx context.Context, disk string) error {
	if out, err := s.Run(ctx, "partprobe", disk); err != nil {
		return fmt.Errorf("partprobe %s: %s: %w", disk, strings.TrimSpace(string(out)), err)
	}
	_, _ = s.Run(ctx, "udevadm", "settle", "--timeout=15")
	return nil
}

func (realSystem) MountedSources() ([]string, error) {
	data, err := os.ReadFile("/proc/self/mounts")
	if err != nil {
		return nil, err
	}
	return parseMountSources(string(data)), nil
}

func (s realSystem) RootSources() ([]string, error) {
	var out []string
	for _, mp := range []string{"/", "/run/live/medium", "/lib/live/mount/medium"} {
		b, err := s.Run(context.Background(), "findmnt", "-no", "SOURCE", mp)
		if err == nil {
			if src := strings.TrimSpace(string(b)); src != "" {
				out = append(out, src)
			}
		}
	}
	return out, nil
}

func (s realSystem) Mount(ctx context.Context, device, dir, fstype string, opts ...string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	args := []string{}
	if fstype != "" {
		args = append(args, "-t", fstype)
	}
	if len(opts) > 0 {
		args = append(args, "-o", strings.Join(opts, ","))
	}
	args = append(args, device, dir)
	if out, err := s.Run(ctx, "mount", args...); err != nil {
		return fmt.Errorf("mount %s %s: %s: %w", device, dir, strings.TrimSpace(string(out)), err)
	}
	return nil
}

func (s realSystem) BindMount(ctx context.Context, src, dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if out, err := s.Run(ctx, "mount", "--bind", src, dir); err != nil {
		return fmt.Errorf("bind mount %s %s: %s: %w", src, dir, strings.TrimSpace(string(out)), err)
	}
	return nil
}

func (s realSystem) Unmount(ctx context.Context, dir string) error {
	if out, err := s.Run(ctx, "umount", dir); err != nil {
		return fmt.Errorf("umount %s: %s: %w", dir, strings.TrimSpace(string(out)), err)
	}
	return nil
}

func (s realSystem) Sync(ctx context.Context) error { _, err := s.Run(ctx, "sync"); return err }
func (realSystem) Arch() string                     { return runtime.GOARCH }
