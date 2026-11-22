//go:build windows

package wakeconfig

import "github.com/breeze-rmm/agent/internal/oemupdates/bitlockerguard"

// SystemBitLockerReaders are the machine's two read-only BitLocker seams, from
// bitlockerguard.ReadOnlyDeps: the OS volume state (Get-BitLockerVolume) and
// manage-bde's TPM protector listing, both run from System32 with fixed
// arguments and timeouts. ReadOnlyDeps carries no suspend, resume or record
// seam, so nothing reachable from here can change BitLocker.
func SystemBitLockerReaders() BitLockerReaders {
	d := bitlockerguard.ReadOnlyDeps()
	return BitLockerReaders{State: d.State, Protectors: d.Protectors}
}
