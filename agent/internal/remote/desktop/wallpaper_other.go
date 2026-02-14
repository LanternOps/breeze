//go:build !darwin && !windows && !linux

package desktop

type otherWallpaperBackend struct{}

func newWallpaperBackend() wallpaperBackend {
	return &otherWallpaperBackend{}
}

func (b *otherWallpaperBackend) GetCurrent() (*WallpaperState, error) {
	return &WallpaperState{}, nil
}

func (b *otherWallpaperBackend) SetSolidBlack() error {
	return nil
}

func (b *otherWallpaperBackend) Restore(state *WallpaperState) error {
	return nil
}
