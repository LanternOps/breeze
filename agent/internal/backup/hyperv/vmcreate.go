//go:build windows

package hyperv

import "context"

// CreateVMFromVHDX creates a Generation 2 VM booting the rebuilt VHDX, with
// Secure Boot on against the Microsoft Windows template and no network
// adapter unless req.SwitchName is set. It does not start the VM. The one
// PowerShell process honours ctx and a 10-minute timeout (runPSContext). On
// failure the half-configured VM is removed; the VHDX is never touched.
func CreateVMFromVHDX(ctx context.Context, req CreateVMRequest) error {
	return createVMFromVHDXWith(ctx, runPSContext, req)
}
