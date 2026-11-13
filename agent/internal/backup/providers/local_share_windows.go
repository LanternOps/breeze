//go:build windows

package providers

import (
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

var procNtQueryVolumeInformationFile = windows.NewLazySystemDLL("ntdll.dll").NewProc("NtQueryVolumeInformationFile")

const (
	fileFsDeviceInformation = 4   // FS_INFORMATION_CLASS FileFsDeviceInformation
	volumeNameNT            = 0x2 // GetFinalPathNameByHandle VOLUME_NAME_NT
)

// volumeIsRemote opens the root of the volume that the absolute path base
// names, without following a link, and asks the system whether that volume
// is reached over the network (handleIsRemote). The store path below the
// volume root is walked without following reparse points, so the volume
// root decides the volume of the store. A drive letter mapped to a share is
// decided here, whatever the path looks like.
func volumeIsRemote(base string) (bool, error) {
	root := storeVolumeRoot(base)
	if root == "" {
		return false, nil
	}
	rootPtr, err := windows.UTF16PtrFromString(root)
	if err != nil {
		return false, err
	}
	handle, err := windows.CreateFile(rootPtr, windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return false, err
	}
	defer windows.CloseHandle(handle)
	return handleIsRemote(handle)
}

// rootIsRemote asks the system whether the opened store root is on a volume
// reached over the network.
func rootIsRemote(root *os.Root) (bool, error) {
	dir, err := root.Open(".")
	if err != nil {
		return false, err
	}
	defer dir.Close()
	return handleIsRemote(windows.Handle(dir.Fd()))
}

// handleIsRemote reports whether an open handle is on a network volume, from
// its volume's device information and its final NT path (remoteVolume). An
// answer the system cannot give is an error, so callers fail closed.
func handleIsRemote(handle windows.Handle) (bool, error) {
	var info volumeDeviceInfo
	var iosb windows.IO_STATUS_BLOCK
	status, _, _ := procNtQueryVolumeInformationFile.Call(uintptr(handle),
		uintptr(unsafe.Pointer(&iosb)), uintptr(unsafe.Pointer(&info)), unsafe.Sizeof(info), fileFsDeviceInformation)
	if status != 0 {
		return false, windows.NTStatus(status)
	}
	if remoteVolume(info, "") {
		return true, nil
	}
	ntPath, err := finalNTPath(handle)
	if err != nil {
		return false, err
	}
	return remoteVolume(info, ntPath), nil
}

func finalNTPath(handle windows.Handle) (string, error) {
	buf := make([]uint16, 512)
	for {
		n, err := windows.GetFinalPathNameByHandle(handle, &buf[0], uint32(len(buf)), volumeNameNT)
		if err != nil {
			return "", err
		}
		if n < uint32(len(buf)) {
			return windows.UTF16ToString(buf[:n]), nil
		}
		buf = make([]uint16, n+1)
	}
}
