//go:build !linux

package x11

// ResolveDisplayTargets is unsupported off Linux.
func ResolveDisplayTargets() ([]DisplayTarget, error) { return nil, ErrNoDisplay }

// SelectX11Target is unsupported off Linux.
func SelectX11Target() (DisplayTarget, error) { return DisplayTarget{}, ErrNoDisplay }
