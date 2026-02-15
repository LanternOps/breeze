//go:build windows

package desktop

import (
	"syscall"
	"unsafe"
)

const (
	spiGetDeskWallpaper = 0x0073
	spiSetDeskWallpaper = 0x0014
	spifUpdateINIFile   = 0x01
	spifSendChange      = 0x02
	maxWallpaperPath    = 260
)

var (
	// Reuse user32 LazyDLL from input_windows.go (same package).
	procSystemParametersInfoW = user32.NewProc("SystemParametersInfoW")
)

type windowsWallpaperBackend struct{}

func newWallpaperBackend() wallpaperBackend {
	return &windowsWallpaperBackend{}
}

func (b *windowsWallpaperBackend) GetCurrent() (*WallpaperState, error) {
	buf := make([]uint16, maxWallpaperPath)
	ret, _, err := procSystemParametersInfoW.Call(
		spiGetDeskWallpaper,
		uintptr(maxWallpaperPath),
		uintptr(unsafe.Pointer(&buf[0])),
		0,
	)
	if ret == 0 {
		return nil, err
	}
	return &WallpaperState{
		WallpaperPath: syscall.UTF16ToString(buf),
	}, nil
}

func (b *windowsWallpaperBackend) SetSolidBlack() error {
	// Setting wallpaper to empty string removes the image, showing the
	// desktop solid color (which defaults to black on most configurations).
	empty := [1]uint16{0}
	ret, _, err := procSystemParametersInfoW.Call(
		spiSetDeskWallpaper,
		0,
		uintptr(unsafe.Pointer(&empty[0])),
		spifUpdateINIFile|spifSendChange,
	)
	if ret == 0 {
		return err
	}
	return nil
}

func (b *windowsWallpaperBackend) Restore(state *WallpaperState) error {
	if state.WallpaperPath == "" {
		return nil // was already empty
	}
	path, err := syscall.UTF16PtrFromString(state.WallpaperPath)
	if err != nil {
		return err
	}
	ret, _, sysErr := procSystemParametersInfoW.Call(
		spiSetDeskWallpaper,
		0,
		uintptr(unsafe.Pointer(path)),
		spifUpdateINIFile|spifSendChange,
	)
	if ret == 0 {
		return sysErr
	}
	return nil
}
