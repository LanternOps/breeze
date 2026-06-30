//go:build windows

package winupdate

import (
	"errors"
	"fmt"

	"golang.org/x/sys/windows/registry"
)

const (
	// auKeyPath is the documented Group Policy location for the Automatic
	// Updates client, relative to HKLM.
	auKeyPath = `SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU`
	// noAutoUpdateValue=1 disables the unattended Automatic Updates install
	// channel (does not affect Breeze's WUA COM-driven installs).
	noAutoUpdateValue = "NoAutoUpdate"
	// breezeManagedValue marks the NoAutoUpdate value as Breeze-owned so revert
	// never clobbers a pre-existing admin GPO.
	breezeManagedValue = "BreezeManagedNoAutoUpdate"
	// breezeCreatedKeyValue marks that Breeze created the AU key itself, so a
	// revert can remove the key again if nothing else remains.
	breezeCreatedKeyValue = "BreezeCreatedAUKey"
)

// readState observes the current AU policy key without mutating it.
func readState() (regState, error) {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, auKeyPath, registry.QUERY_VALUE)
	if err != nil {
		if errors.Is(err, registry.ErrNotExist) {
			return regState{keyExists: false}, nil
		}
		return regState{}, err
	}
	defer k.Close()

	st := regState{keyExists: true}
	if v, _, e := k.GetIntegerValue(noAutoUpdateValue); e == nil {
		st.noAutoUpdatePresent = true
		st.noAutoUpdateValue = uint32(v)
	}
	if v, _, e := k.GetIntegerValue(breezeManagedValue); e == nil && v == 1 {
		st.breezeManaged = true
	}
	if v, _, e := k.GetIntegerValue(breezeCreatedKeyValue); e == nil && v == 1 {
		st.breezeCreatedKey = true
	}
	return st, nil
}

// Apply converges the endpoint to the desired Windows Update suppression state.
// enforce=true sets NoAutoUpdate=1 (managed by Breeze); enforce=false reverts
// any enforcement Breeze previously applied. Caller logs the Result.
func Apply(enforce bool) (Result, error) {
	st, err := readState()
	if err != nil {
		return Result{Supported: true}, fmt.Errorf("read WindowsUpdate AU policy state: %w", err)
	}

	p := planAction(enforce, st)

	if p.writeEnforcement {
		k, existed, e := registry.CreateKey(registry.LOCAL_MACHINE, auKeyPath, registry.SET_VALUE|registry.QUERY_VALUE)
		if e != nil {
			return Result{Supported: true}, fmt.Errorf("open/create WindowsUpdate AU key: %w", e)
		}
		defer k.Close()
		if e := k.SetDWordValue(noAutoUpdateValue, 1); e != nil {
			return Result{Supported: true}, fmt.Errorf("set NoAutoUpdate: %w", e)
		}
		if e := k.SetDWordValue(breezeManagedValue, 1); e != nil {
			// Without the ownership sentinel a future revert would refuse to act
			// (it can't tell our value from an admin's). Surface it.
			return Result{Supported: true, Enforced: true}, fmt.Errorf("set Breeze ownership sentinel: %w", e)
		}
		if p.recordKeyCreated && !existed {
			// Best-effort: a missing created-key sentinel only means revert won't
			// remove the (otherwise empty) key — harmless. Don't fail the apply.
			_ = k.SetDWordValue(breezeCreatedKeyValue, 1)
		}
		// Verify the read-back so a silently-rejected write is reported.
		got, _, gerr := k.GetIntegerValue(noAutoUpdateValue)
		res := p.result
		if gerr != nil || got != 1 {
			res.Reason = "NoAutoUpdate write could not be verified (read-back mismatch)"
			return res, fmt.Errorf("verify NoAutoUpdate read-back: got %d (err %v)", got, gerr)
		}
		return res, nil
	}

	if p.revert {
		k, e := registry.OpenKey(registry.LOCAL_MACHINE, auKeyPath, registry.SET_VALUE|registry.QUERY_VALUE|registry.READ)
		if e != nil {
			return Result{Supported: true}, fmt.Errorf("open WindowsUpdate AU key for revert: %w", e)
		}
		// Delete our managed value and sentinels. Missing values are not an error
		// (idempotent revert).
		if e := k.DeleteValue(noAutoUpdateValue); e != nil && !errors.Is(e, registry.ErrNotExist) {
			k.Close()
			return Result{Supported: true}, fmt.Errorf("delete NoAutoUpdate: %w", e)
		}
		_ = k.DeleteValue(breezeManagedValue)
		_ = k.DeleteValue(breezeCreatedKeyValue)

		// If Breeze created the key and nothing else remains, remove it to fully
		// restore the prior state. Leaving an empty key is harmless, so any
		// failure here is non-fatal.
		removeKey := false
		if p.deleteKeyIfEmpty {
			valueNames, _ := k.ReadValueNames(-1)
			subKeys, _ := k.ReadSubKeyNames(-1)
			removeKey = len(valueNames) == 0 && len(subKeys) == 0
		}
		k.Close()
		if removeKey {
			_ = registry.DeleteKey(registry.LOCAL_MACHINE, auKeyPath)
		}
		return p.result, nil
	}

	return p.result, nil
}
