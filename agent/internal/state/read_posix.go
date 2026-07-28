//go:build !windows

package state

import "os"

func readStateFile(path string) ([]byte, error) {
	return os.ReadFile(path)
}
