//go:build !windows && !linux && !darwin

package sessionbroker

import "errors"

func systemAccountEntry(string) (string, string, error) {
	return "", "", errors.New("no system account database lookup on this platform")
}
