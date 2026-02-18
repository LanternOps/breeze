//go:build !windows

package userhelper

func currentWinSessionID() uint32 {
	return 0
}
