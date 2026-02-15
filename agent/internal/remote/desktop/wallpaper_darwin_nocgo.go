//go:build darwin && !cgo

package desktop

type darwinNoCgoWallpaperBackend struct{}

func newWallpaperBackend() wallpaperBackend {
	return &darwinNoCgoWallpaperBackend{}
}

func (b *darwinNoCgoWallpaperBackend) GetCurrent() (*WallpaperState, error) {
	return &WallpaperState{}, nil
}

func (b *darwinNoCgoWallpaperBackend) SetSolidBlack() error {
	return nil
}

func (b *darwinNoCgoWallpaperBackend) Restore(state *WallpaperState) error {
	return nil
}
