package yarac

import (
	"errors"
	"fmt"
)

// The YARA engine is YARA-X compiled to WebAssembly and run by wazero, and
// yaraxwasm always selects wazero's optimizing compiler (it hard-codes
// wazero.NewRuntimeConfig(), with no interpreter option). On darwin the
// compiler mmaps anonymous PROT_READ|PROT_WRITE memory, writes machine code
// and mprotects it to PROT_READ|PROT_EXEC — no MAP_JIT. Under the hardened
// runtime the kernel kills the process (SIGKILL, CODESIGNING "Invalid Page")
// the first time it executes such a page unless the binary carries
// com.apple.security.cs.allow-unsigned-executable-memory; allow-jit does not
// cover it, because it only applies to MAP_JIT regions (#10375).
//
// The release pipelines sign breeze-agent with that entitlement
// (agent/entitlements/agent-macos.entitlements.plist). This check is the
// backstop for a binary signed without it — a stale signing lane, a BYO
// signing template copied before the change, a dev build: EnsureEngine
// refuses to start the engine, so the scan reports engine_unavailable and
// falls back to the built-in signatures instead of the kernel killing the
// agent mid-command.

// EntitlementAllowUnsignedExecutableMemory is the hardened-runtime exception
// the YARA engine needs on macOS.
const EntitlementAllowUnsignedExecutableMemory = "com.apple.security.cs.allow-unsigned-executable-memory"

// ErrExecutableMemoryDenied: this process may not execute the machine code
// the YARA engine generates, so the engine is not started.
var ErrExecutableMemoryDenied = errors.New("YARA engine disabled: this process may not execute the code the engine compiles")

// codeSigning is the slice of this process's code-signing state that decides
// whether executing anonymous r-x pages is safe.
type codeSigning struct {
	// enforced: the kernel enforces code signing on this process's executable
	// pages (darwin: any of CS_RUNTIME, CS_HARD or CS_ENFORCEMENT is set).
	enforced                        bool
	allowUnsignedExecutableMemory   bool
	disableExecutablePageProtection bool
	// allowJIT is read only so the decision can ignore it explicitly: it
	// covers MAP_JIT regions, which wazero does not use.
	allowJIT bool
}

// Test seams. readCodeSigning is platformCodeSigning outside tests.
var (
	readCodeSigning  = platformCodeSigning
	initialiseEngine = initialiseYaraX
)

func checkExecutableMemory() error {
	cs, err := readCodeSigning()
	return executableMemoryDecision(cs, err)
}

// executableMemoryDecision fails closed: if the code-signing state cannot be
// read on a platform that enforces it, the engine stays off. A disabled
// engine degrades the scan to the built-in signatures; a wrong guess gets the
// agent killed.
func executableMemoryDecision(cs codeSigning, readErr error) error {
	if readErr != nil {
		return fmt.Errorf("%w: could not read this process's code-signing state (%v), so whether it holds %s is unknown (#10375)",
			ErrExecutableMemoryDenied, readErr, EntitlementAllowUnsignedExecutableMemory)
	}
	if !cs.enforced || cs.allowUnsignedExecutableMemory || cs.disableExecutablePageProtection {
		return nil
	}
	return fmt.Errorf("%w: the binary is signed with code-signing enforcement (hardened runtime) but without the %s entitlement, and macOS would kill the agent when the engine runs (#10375)",
		ErrExecutableMemoryDenied, EntitlementAllowUnsignedExecutableMemory)
}
