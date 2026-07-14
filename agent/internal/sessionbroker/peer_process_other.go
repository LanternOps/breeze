//go:build !windows

package sessionbroker

func openOwnedPeerProcess(uint32) (ownedPeerProcess, error) { return nil, nil }
