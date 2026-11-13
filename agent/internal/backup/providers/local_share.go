package providers

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// ErrNetworkShareStore is returned for a local backup store or vault whose
// path is on a network share. Network shares (UNC paths, mapped network
// drives, SMB and NAS shares) are not supported as local stores: the agent
// reaches them under the device's network identity, which the store's
// ownership and access checks cannot express.
var ErrNetworkShareStore = errors.New("network shares (UNC paths, mapped network drives, SMB and NAS shares) are not supported for local backup destinations or vaults: use a dedicated directory on a disk attached to this device, or an S3 destination")

// storeVolumeIsRemote reports whether an absolute store path lies on a volume
// the system reports as remote; a test seam over volumeIsRemote.
var storeVolumeIsRemote = volumeIsRemote

// storeRootIsRemote reports whether an opened store root is on a volume the
// system reports as remote; a test seam over rootIsRemote.
var storeRootIsRemote = rootIsRemote

func setStoreRootIsRemoteForTest(fn func(*os.Root) (bool, error)) (restore func()) {
	previous := storeRootIsRemote
	storeRootIsRemote = fn
	return func() { storeRootIsRemote = previous }
}

func setStoreVolumeIsRemoteForTest(fn func(string) (bool, error)) (restore func()) {
	previous := storeVolumeIsRemote
	storeVolumeIsRemote = fn
	return func() { storeVolumeIsRemote = previous }
}

// refuseNetworkShare returns an ErrNetworkShareStore error when basePath (as
// configured) or its absolute form base names a network share, or when the
// volume base lies on is reported as remote. It runs before the store path
// is created, opened or checked. The spelling check is only an early refusal
// with a clear message; the decision is the volume check here and the check
// of the opened store root in openStore, both of which ask the system about
// an open handle, with the ownership and access checks behind them.
func refuseNetworkShare(basePath, base string) error {
	windowsForm := runtime.GOOS == "windows"
	if isNetworkSharePath(basePath, windowsForm) || isNetworkSharePath(base, windowsForm) {
		return fmt.Errorf("local backup store %q is on a network share: %w", basePath, ErrNetworkShareStore)
	}
	remote, err := storeVolumeIsRemote(base)
	if err != nil {
		return fmt.Errorf("local backup store %q: determine whether its volume is a network share: %w", basePath, err)
	}
	if remote {
		return fmt.Errorf("local backup store %q is on a network drive: %w", basePath, ErrNetworkShareStore)
	}
	return nil
}

// isNetworkSharePath reports whether path is spelled as a network share:
// \\server\share, \\?\UNC\server\share, \\.\UNC\server\share,
// \??\UNC\server\share, or a GLOBALROOT path through the network redirector.
// With windowsForm, forward slashes count as separators (so //server/share is
// a share); otherwise a leading // is an ordinary absolute path. A local
// long-path or device form (\\?\C:\x, \\?\Volume{...}\x) is not a share by
// its spelling; volumeIsRemote decides for the volume it names.
func isNetworkSharePath(path string, windowsForm bool) bool {
	p := path
	if windowsForm {
		p = strings.ReplaceAll(p, "/", `\`)
	}
	upper := strings.ToUpper(p)
	for _, prefix := range []string{`\\?\UNC\`, `\\.\UNC\`, `\??\UNC\`} {
		if strings.HasPrefix(upper, prefix) {
			return true
		}
	}
	for _, prefix := range []string{`\\?\GLOBALROOT\`, `\\.\GLOBALROOT\`, `\??\GLOBALROOT\`} {
		if strings.HasPrefix(upper, prefix) {
			rest := upper[len(prefix):]
			return strings.HasPrefix(rest, `DEVICE\MUP\`) || strings.HasPrefix(rest, `DEVICE\LANMANREDIRECTOR\`)
		}
	}
	if strings.HasPrefix(p, `\\?\`) || strings.HasPrefix(p, `\\.\`) {
		return false
	}
	return strings.HasPrefix(p, `\\`)
}

// storeVolumeRoot returns the root of the volume that the absolute path base
// names ("C:\", "\\?\C:\"), or "" when it names none.
func storeVolumeRoot(base string) string {
	volume := filepath.VolumeName(base)
	if volume == "" {
		return ""
	}
	return volume + string(filepath.Separator)
}

// Device types and characteristics from FILE_FS_DEVICE_INFORMATION that mark
// a volume reached over the network.
const (
	fileDeviceNetwork           = 0x12
	fileDeviceNetworkFileSystem = 0x14
	fileDeviceNetworkRedirector = 0x28
	fileDeviceDFSFileSystem     = 0x35
	fileDeviceDFSVolume         = 0x36
	fileRemoteDevice            = 0x10
)

// volumeDeviceInfo is FILE_FS_DEVICE_INFORMATION for an open handle.
type volumeDeviceInfo struct {
	DeviceType      uint32
	Characteristics uint32
}

// remoteVolume decides, from what the system reports for an open handle (its
// volume's device information and its final NT path), whether the handle is
// on a network volume: a remote device, a network or DFS device type, or a
// path through the multiple UNC provider or the SMB redirector.
func remoteVolume(info volumeDeviceInfo, ntPath string) bool {
	if info.Characteristics&fileRemoteDevice != 0 {
		return true
	}
	switch info.DeviceType {
	case fileDeviceNetwork, fileDeviceNetworkFileSystem, fileDeviceNetworkRedirector, fileDeviceDFSFileSystem, fileDeviceDFSVolume:
		return true
	}
	upper := strings.ToUpper(ntPath)
	return strings.HasPrefix(upper, `\DEVICE\MUP\`) || strings.HasPrefix(upper, `\DEVICE\LANMANREDIRECTOR\`)
}
