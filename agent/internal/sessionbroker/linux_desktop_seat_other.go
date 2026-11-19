//go:build !linux

package sessionbroker

import "context"

// LinuxActiveSeatSession has no logind to ask off Linux: there is never an
// active Linux seat session.
func LinuxActiveSeatSession(context.Context) (*DetectedSession, error) { return nil, nil }
