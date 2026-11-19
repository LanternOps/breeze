//go:build !linux

package sessionbroker

// The Linux desktop helper manager never runs off Linux; these keep the
// untagged manager building everywhere and never identify or signal a pid.
func linuxDesktopPeerIdentity(int) (startTime uint64, uid uint32, alive bool) { return 0, 0, false }

func killLinuxDesktopPeer(int, uint32, uint64) {}
