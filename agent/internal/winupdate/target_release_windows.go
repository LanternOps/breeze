//go:build windows

package winupdate

import (
	"errors"
	"fmt"

	"golang.org/x/sys/windows/registry"
)

// wuPolicyKeyPath is the Windows Update Group Policy key (parent of the AU key
// used by the NoAutoUpdate enforcement), relative to HKLM.
const wuPolicyKeyPath = `SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate`

// readTargetReleaseState observes the policy key without mutating it.
func readTargetReleaseState() (targetReleaseState, error) {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, wuPolicyKeyPath, registry.QUERY_VALUE)
	if err != nil {
		if errors.Is(err, registry.ErrNotExist) {
			return targetReleaseState{keyExists: false}, nil
		}
		return targetReleaseState{}, err
	}
	defer k.Close()

	return observeTargetRelease(k, func(err error) bool { return errors.Is(err, registry.ErrNotExist) }), nil
}

// ApplyTargetRelease converges the endpoint to the desired target-release pin.
// pin=nil reverts any pin Breeze previously wrote. Caller logs the Result.
func ApplyTargetRelease(pin *TargetRelease) (Result, error) {
	st, err := readTargetReleaseState()
	if err != nil {
		return Result{Supported: true}, fmt.Errorf("read WindowsUpdate target-release policy state: %w", err)
	}

	p := planTargetRelease(pin, st)

	if p.write {
		k, _, e := registry.CreateKey(registry.LOCAL_MACHINE, wuPolicyKeyPath, registry.SET_VALUE|registry.QUERY_VALUE)
		if e != nil {
			return Result{Supported: true}, fmt.Errorf("open/create WindowsUpdate policy key: %w", e)
		}
		defer k.Close()
		// Sentinel first: if the policy values land but the sentinel does not,
		// a later revert would refuse to touch them (it cannot tell our values
		// from an admin's). Writing the sentinel first means a partial write
		// is still Breeze-owned and gets cleaned up.
		if e := k.SetDWordValue(breezeManagedTargetReleaseValue, 1); e != nil {
			return Result{Supported: true}, fmt.Errorf("set Breeze ownership sentinel: %w", e)
		}
		if e := k.SetStringValue(productVersionValue, pin.ProductVersion); e != nil {
			return Result{Supported: true}, fmt.Errorf("set ProductVersion: %w", e)
		}
		if e := k.SetStringValue(targetReleaseVersionInfoValue, pin.TargetVersion); e != nil {
			return Result{Supported: true}, fmt.Errorf("set TargetReleaseVersionInfo: %w", e)
		}
		if e := k.SetDWordValue(targetReleaseVersionValue, 1); e != nil {
			return Result{Supported: true}, fmt.Errorf("set TargetReleaseVersion: %w", e)
		}
		// Verify the read-back so a silently-rejected write is reported.
		got, _, gerr := k.GetStringValue(targetReleaseVersionInfoValue)
		res := p.result
		if gerr != nil || got != pin.TargetVersion {
			res.Reason = "TargetReleaseVersionInfo write could not be verified (read-back mismatch)"
			return res, fmt.Errorf("verify TargetReleaseVersionInfo read-back: got %q (err %v)", got, gerr)
		}
		return res, nil
	}

	if p.revert {
		k, e := registry.OpenKey(registry.LOCAL_MACHINE, wuPolicyKeyPath, registry.SET_VALUE|registry.QUERY_VALUE|registry.READ)
		if e != nil {
			return Result{Supported: true}, fmt.Errorf("open WindowsUpdate policy key for revert: %w", e)
		}
		rerr := executeTargetReleaseRevert(k, func(err error) bool { return errors.Is(err, registry.ErrNotExist) })
		k.Close()
		if rerr != nil {
			return Result{Supported: true}, rerr
		}
		// The WindowsUpdate key is shared with other policies (and the AU
		// subkey), so it is never deleted here.
		return p.result, nil
	}

	return p.result, nil
}
