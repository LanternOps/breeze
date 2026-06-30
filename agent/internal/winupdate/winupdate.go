// Package winupdate enforces "Breeze as the sole patch source" on Windows
// endpoints (issue #1872). When enabled, it disables the native Windows Update
// automatic-install channel by setting the documented Group Policy registry
// value NoAutoUpdate=1 under
//
//	HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU
//
// NoAutoUpdate=1 stops the unattended, OS-initiated Automatic Updates client
// only. It does NOT block the Windows Update Agent COM API
// (Microsoft.Update.Session / IUpdateInstaller) that Breeze's own patch
// installer drives — so Breeze's scan/approve/install path keeps working.
//
// Enforcement is fully reversible. Breeze records its own ownership with
// sentinel values in the same key, and revert only touches state Breeze
// created: a pre-existing admin Group Policy is detected and left as-found.
//
// The platform-independent decision logic (planAction) lives here so it can be
// unit-tested on any OS; the registry I/O is in winupdate_windows.go, with a
// no-op stub for other platforms in winupdate_stub.go.
package winupdate

// Result reports the outcome of an Apply call, for logging.
type Result struct {
	// Supported is false on non-Windows platforms (Apply is a no-op there).
	Supported bool
	// Managed is true when Breeze owns the NoAutoUpdate policy value after this
	// call (its sentinel is present). False when a pre-existing admin GPO was
	// left as-found, or after a revert.
	Managed bool
	// Enforced reports whether NoAutoUpdate is effectively 1 after the call.
	Enforced bool
	// Reverted is true when this call removed Breeze's prior enforcement.
	Reverted bool
	// Reason is a human-readable detail for slog.
	Reason string
}

// regState is the observed state at the WindowsUpdate\AU policy key.
type regState struct {
	keyExists           bool
	noAutoUpdatePresent bool
	noAutoUpdateValue   uint32
	// breezeManaged is true when Breeze's NoAutoUpdate ownership sentinel is set.
	breezeManaged bool
	// breezeCreatedKey is true when Breeze created the AU key itself (so revert
	// may remove it again if it ends up empty).
	breezeCreatedKey bool
}

// plan is the set of registry mutations needed to converge to the desired state.
type plan struct {
	// writeEnforcement: (create the key path as needed and) set NoAutoUpdate=1
	// plus Breeze's ownership sentinel.
	writeEnforcement bool
	// recordKeyCreated: the AU key did not exist, so after creating it set the
	// "Breeze created this key" sentinel for a clean revert later.
	recordKeyCreated bool
	// revert: delete NoAutoUpdate and Breeze's sentinels.
	revert bool
	// deleteKeyIfEmpty: after reverting, delete the AU key if Breeze created it
	// and nothing else remains.
	deleteKeyIfEmpty bool
	// result is the Result to surface once the plan executes successfully.
	result Result
}

// planAction decides what to do given the desired enforcement state and the
// currently observed registry state. It is pure and side-effect free.
func planAction(enforce bool, st regState) plan {
	if enforce {
		// A NoAutoUpdate value Breeze never set means a pre-existing admin Group
		// Policy owns this key. Leave it as-found rather than clobber it.
		if st.noAutoUpdatePresent && !st.breezeManaged {
			return plan{result: Result{
				Supported: true,
				Managed:   false,
				Enforced:  st.noAutoUpdateValue == 1,
				Reason:    "pre-existing Windows Update policy detected (NoAutoUpdate already set by another GPO); left as-found, not managed by Breeze",
			}}
		}
		reason := "Windows Update suppression applied (NoAutoUpdate=1)"
		if st.breezeManaged && st.noAutoUpdatePresent && st.noAutoUpdateValue == 1 {
			reason = "Windows Update suppression already in effect (re-asserted NoAutoUpdate=1)"
		}
		return plan{
			writeEnforcement: true,
			recordKeyCreated: !st.keyExists,
			result: Result{
				Supported: true,
				Managed:   true,
				Enforced:  true,
				Reason:    reason,
			},
		}
	}

	// Revert path: only undo what Breeze itself set.
	if !st.keyExists || !st.breezeManaged {
		return plan{result: Result{
			Supported: true,
			Managed:   false,
			Enforced:  st.keyExists && st.noAutoUpdatePresent && st.noAutoUpdateValue == 1,
			Reason:    "no Breeze-managed Windows Update suppression to revert; left as-found",
		}}
	}
	return plan{
		revert:           true,
		deleteKeyIfEmpty: st.breezeCreatedKey,
		result: Result{
			Supported: true,
			Managed:   false,
			Enforced:  false,
			Reverted:  true,
			Reason:    "reverted Breeze Windows Update suppression (deleted NoAutoUpdate)",
		},
	}
}
