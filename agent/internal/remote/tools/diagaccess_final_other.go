//go:build !windows && !linux && !darwin

package tools

import "os"

// Platforms without a handle-to-path primitive refuse grant mode outright.
func finalPathOfFile(_ *os.File) (string, error) { return "", errDiagUnsupported }

func linkCountOfFile(_ *os.File, _ os.FileInfo) (uint32, error) { return 0, errDiagUnsupported }

func mountIdentityOfFile(_ *os.File) (string, error) { return "", errDiagUnsupported }

// diagOpenFlags is OR'd into the read-only open (see the unix variants).
const diagOpenFlags = 0
