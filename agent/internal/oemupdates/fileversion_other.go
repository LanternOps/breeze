//go:build !windows

package oemupdates

import "errors"

func peFileVersion(string) (string, error) {
	return "", errors.New("file versions are only read on windows")
}
