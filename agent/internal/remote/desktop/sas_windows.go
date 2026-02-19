//go:build windows

package desktop

import (
	"fmt"
	"log/slog"
	"syscall"

	"golang.org/x/sys/windows/registry"
)

var (
	sasDLL  *syscall.LazyDLL
	sendSAS *syscall.LazyProc
)

func init() {
	sasDLL = syscall.NewLazyDLL("sas.dll")
	sendSAS = sasDLL.NewProc("SendSAS")
}

// InvokeSAS triggers the Secure Attention Sequence (Ctrl+Alt+Del) via sas.dll.
// The helper runs as SYSTEM in the user's session, spawned by the service via
// CreateProcessAsUser. Windows treats SYSTEM processes as "services" for SAS
// purposes (checks LocalSystem identity, not SCM registration), so we use
// AsUser=FALSE (service context). Requires SoftwareSASGeneration >= 1.
func InvokeSAS() error {
	if err := sasDLL.Load(); err != nil {
		return fmt.Errorf("sas.dll not available (Server Core?): %w", err)
	}
	if err := sendSAS.Find(); err != nil {
		return fmt.Errorf("SendSAS proc not found in sas.dll: %w", err)
	}

	// SendSAS(BOOL AsUser) — FALSE = service context. The helper is a SYSTEM
	// process, and Windows verifies the LocalSystem identity (not SCM registration).
	// SAS targets the caller's session. Requires SoftwareSASGeneration >= 1.
	// SendSAS is a void function, no HRESULT to check.
	sendSAS.Call(uintptr(0))
	slog.Info("SendSAS invoked (AsUser=FALSE, service context)")
	return nil
}

// SASPolicyStatus represents the SoftwareSASGeneration registry value.
type SASPolicyStatus int

const (
	SASPolicyDisabled     SASPolicyStatus = 0 // SAS generation disabled
	SASPolicyServices     SASPolicyStatus = 1 // Only services can generate SAS
	SASPolicyApps         SASPolicyStatus = 2 // Only applications can generate SAS (unused)
	SASPolicyServicesApps SASPolicyStatus = 3 // Services and applications can generate SAS
)

const sasRegistryPath = `SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System`
const sasRegistryKey = "SoftwareSASGeneration"

// CheckSASPolicy reads the SoftwareSASGeneration registry value to determine
// if software-generated SAS is allowed.
func CheckSASPolicy() SASPolicyStatus {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, sasRegistryPath, registry.QUERY_VALUE)
	if err != nil {
		// Key doesn't exist — SAS generation is disabled (default)
		return SASPolicyDisabled
	}
	defer k.Close()

	val, _, err := k.GetIntegerValue(sasRegistryKey)
	if err != nil {
		return SASPolicyDisabled
	}
	return SASPolicyStatus(val)
}

// SetSASPolicy writes the SoftwareSASGeneration registry value.
// Requires SYSTEM or admin privileges.
func SetSASPolicy(value uint32) error {
	k, _, err := registry.CreateKey(registry.LOCAL_MACHINE, sasRegistryPath, registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("failed to open registry key for writing: %w", err)
	}
	defer k.Close()

	if err := k.SetDWordValue(sasRegistryKey, value); err != nil {
		return fmt.Errorf("failed to set %s to %d: %w", sasRegistryKey, value, err)
	}
	return nil
}
