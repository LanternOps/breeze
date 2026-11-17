//go:build windows

package tools

import "golang.org/x/sys/windows"

// isVolumeMountPoint reports whether p is a folder at which a volume is
// mounted (not a junction to an ordinary folder).
func isVolumeMountPoint(p string) bool {
	name, err := windows.UTF16PtrFromString(p)
	if err != nil {
		return false
	}
	h, err := windows.CreateFile(name, windows.FILE_READ_ATTRIBUTES, shareAll, nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return false
	}
	defer func() { _ = windows.CloseHandle(h) }()
	buf := make([]byte, windows.MAXIMUM_REPARSE_DATA_BUFFER_SIZE)
	var returned uint32
	if err := windows.DeviceIoControl(h, windows.FSCTL_GET_REPARSE_POINT, nil, 0, &buf[0], uint32(len(buf)), &returned, nil); err != nil {
		return false
	}
	sub, ok := mountPointSubstituteName(buf[:returned])
	return ok && isVolumeRootTarget(sub)
}
