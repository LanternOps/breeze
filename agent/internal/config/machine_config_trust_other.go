//go:build !windows

package config

import "errors"

// The machine config trust check is Windows-only (machineConfigTrustEnforced);
// these are never reached elsewhere.

func adminGroupMember(string) (bool, error) {
	return false, errors.New("administrator group membership is only checked on Windows")
}

func readTrustedMachineConfigFile(string) ([]byte, error) {
	return nil, errProgramDataVerifyUnsupported
}
