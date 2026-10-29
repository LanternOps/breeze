package winupdate

import (
	"fmt"
	"strings"
)

// Windows Update for Business "target release" policy. When an update ring
// pins its devices to one Windows feature release, the agent writes the
// documented Group Policy values under
//
//	HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate
//
// so Windows Update itself offers exactly that release and holds there —
// which also makes the Windows Update Agent search Breeze drives return the
// pinned feature update instead of whatever Microsoft's rollout happens to
// target. The same ownership contract as the NoAutoUpdate enforcement applies:
// Breeze marks the values it wrote with a sentinel, re-asserts or moves only
// its own pin, and a revert never touches a value an admin set by GPO.
//
// The decision logic (planTargetRelease, executeTargetReleaseRevert) is
// platform-independent and unit-tested everywhere; the registry I/O lives in
// target_release_windows.go with a no-op stub elsewhere.

const (
	// targetReleaseVersionValue (DWORD 1) turns the target-release policy on.
	targetReleaseVersionValue = "TargetReleaseVersion"
	// targetReleaseVersionInfoValue (SZ) is the release, e.g. "25H2".
	targetReleaseVersionInfoValue = "TargetReleaseVersionInfo"
	// productVersionValue (SZ) is "Windows 11" or "Windows 10"; required on
	// Windows 11 and for a Windows 10 → 11 upgrade.
	productVersionValue = "ProductVersion"
	// breezeManagedTargetReleaseValue marks the three values as Breeze-owned.
	breezeManagedTargetReleaseValue = "BreezeManagedTargetRelease"
)

// TargetRelease is the pin to apply: the WUfB ProductVersion string and the
// release token.
type TargetRelease struct {
	ProductVersion string // "Windows 11" | "Windows 10"
	TargetVersion  string // "25H2"
}

// targetReleaseState is the observed state at the WindowsUpdate policy key.
type targetReleaseState struct {
	keyExists      bool
	targetPresent  bool // TargetReleaseVersion value exists
	targetEnabled  bool // ... and is 1
	infoPresent    bool // TargetReleaseVersionInfo value exists (any content)
	productPresent bool // ProductVersion value exists (any content)
	targetVersion  string
	productVersion string
	breezeManaged  bool
}

// anyPolicyValuePresent reports whether any of the three target-release
// policy values exists. Without the Breeze sentinel, any one of them is an
// admin's (#10305): an admin can stage TargetReleaseVersionInfo/ProductVersion
// ahead of flipping the DWORD, and Breeze must neither overwrite nor delete it.
func (st targetReleaseState) anyPolicyValuePresent() bool {
	return st.targetPresent || st.infoPresent || st.productPresent
}

// targetReleaseValueReader is the read half of a registry key;
// golang.org/x/sys/windows/registry.Key satisfies it.
type targetReleaseValueReader interface {
	GetIntegerValue(name string) (uint64, uint32, error)
	GetStringValue(name string) (string, uint32, error)
}

// observeTargetRelease reads the policy values from an open key. A value that
// exists but cannot be read as the expected type (or at all) still counts as
// present: ownership errs toward "someone else's", so an unreadable admin
// value is never overwritten. The sentinel errs the other way — only a
// readable DWORD 1 is Breeze ownership.
func observeTargetRelease(k targetReleaseValueReader, isNotExist func(error) bool) targetReleaseState {
	st := targetReleaseState{keyExists: true}
	if v, _, e := k.GetIntegerValue(targetReleaseVersionValue); e == nil {
		st.targetPresent = true
		st.targetEnabled = v == 1
	} else if !isNotExist(e) {
		st.targetPresent = true
	}
	if v, _, e := k.GetStringValue(targetReleaseVersionInfoValue); e == nil {
		st.infoPresent = true
		st.targetVersion = v
	} else if !isNotExist(e) {
		st.infoPresent = true
	}
	if v, _, e := k.GetStringValue(productVersionValue); e == nil {
		st.productPresent = true
		st.productVersion = v
	} else if !isNotExist(e) {
		st.productPresent = true
	}
	if v, _, e := k.GetIntegerValue(breezeManagedTargetReleaseValue); e == nil && v == 1 {
		st.breezeManaged = true
	}
	return st
}

// targetReleasePlan is the mutation set that converges on the desired state.
type targetReleasePlan struct {
	write  bool // write TargetReleaseVersion=1, info, product, sentinel
	revert bool // delete the three values and the sentinel
	result Result
}

// planTargetRelease decides what to do for the desired pin (nil = none) given
// the observed registry state. Pure.
func planTargetRelease(pin *TargetRelease, st targetReleaseState) targetReleasePlan {
	// Any one of the three values without the sentinel is an admin's (#10305).
	adminOwned := st.anyPolicyValuePresent() && !st.breezeManaged
	if pin != nil {
		if adminOwned {
			return targetReleasePlan{result: Result{
				Supported: true,
				Managed:   false,
				Enforced:  st.targetEnabled,
				Reason: fmt.Sprintf("pre-existing Windows Update target-release policy detected (%s, set outside Breeze); left as-found, not managed by Breeze",
					describeAdminTargetRelease(st)),
			}}
		}
		reason := fmt.Sprintf("Windows Update target release pinned (%s %s)", pin.ProductVersion, pin.TargetVersion)
		if st.breezeManaged && st.anyPolicyValuePresent() {
			if st.targetEnabled && st.targetVersion == pin.TargetVersion && st.productVersion == pin.ProductVersion {
				reason = fmt.Sprintf("Windows Update target release already pinned (re-asserted %s %s)", pin.ProductVersion, pin.TargetVersion)
			} else {
				reason = fmt.Sprintf("Windows Update target release pin moved (%s %s -> %s %s)",
					orUnset(st.productVersion), orUnset(st.targetVersion), pin.ProductVersion, pin.TargetVersion)
			}
		}
		return targetReleasePlan{
			write:  true,
			result: Result{Supported: true, Managed: true, Enforced: true, Reason: reason},
		}
	}

	// Revert path: only undo what Breeze itself set.
	if !st.keyExists || !st.breezeManaged {
		return targetReleasePlan{result: Result{
			Supported: true,
			Managed:   false,
			Enforced:  st.keyExists && st.targetEnabled,
			Reason:    "no Breeze-managed Windows Update target-release pin to revert; left as-found",
		}}
	}
	return targetReleasePlan{
		revert: true,
		result: Result{
			Supported: true,
			Managed:   false,
			Enforced:  false,
			Reverted:  true,
			Reason:    "reverted Breeze Windows Update target-release pin",
		},
	}
}

// describeAdminTargetRelease lists which admin-set values were found, for the
// "left as-found" reason, e.g. "TargetReleaseVersionInfo=23H2, TargetReleaseVersion absent".
func describeAdminTargetRelease(st targetReleaseState) string {
	parts := make([]string, 0, 3)
	switch {
	case st.targetEnabled:
		parts = append(parts, targetReleaseVersionValue+"=1")
	case st.targetPresent:
		parts = append(parts, targetReleaseVersionValue+" not 1 (policy off)")
	default:
		parts = append(parts, targetReleaseVersionValue+" absent (policy off)")
	}
	if st.infoPresent {
		parts = append(parts, targetReleaseVersionInfoValue+"="+st.targetVersion)
	}
	if st.productPresent {
		parts = append(parts, productVersionValue+"="+st.productVersion)
	}
	return strings.Join(parts, ", ")
}

func orUnset(s string) string {
	if s == "" {
		return "(unset)"
	}
	return s
}

// executeTargetReleaseRevert deletes Breeze's three policy values and the
// sentinel from an already-open key. A missing value is tolerated; any other
// delete error propagates so a half-reverted state is never reported as clean.
func executeTargetReleaseRevert(k regKey, isNotExist func(error) bool) error {
	for _, name := range []string{targetReleaseVersionValue, targetReleaseVersionInfoValue, productVersionValue, breezeManagedTargetReleaseValue} {
		if e := k.DeleteValue(name); e != nil && !isNotExist(e) {
			return fmt.Errorf("delete %s: %w", name, e)
		}
	}
	return nil
}
