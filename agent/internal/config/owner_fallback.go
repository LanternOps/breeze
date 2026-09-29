package config

import "fmt"

// ownerAssignment records how assignOwnerWithFallback got an owner onto an
// object.
type ownerAssignment int

const (
	// ownerAssignedDirect: the preferred owner was accepted with the process
	// token as it was. This is the LocalSystem service path: SYSTEM may always
	// name itself as owner.
	ownerAssignedDirect ownerAssignment = iota
	// ownerAssignedWithPrivilege: the preferred owner was refused as-is and
	// accepted once SeRestorePrivilege was enabled. This is the elevated
	// local-Administrator path (`breeze-agent enroll` from an admin prompt):
	// the token holds the privilege but has it disabled by default, and
	// without it Windows refuses any owner that is not the caller's own user
	// or an SE_GROUP_OWNER group (issue #7394).
	ownerAssignedWithPrivilege
	// ownerAssignedFallback: the preferred owner could not be assigned even
	// with the privilege, so the fallback owner was applied instead.
	ownerAssignedFallback
)

// ownerAssignResult is what assignOwnerWithFallback did. privilegeErr and
// primaryErr are only set on the fallback path, so the caller can log why the
// preferred owner was not used.
type ownerAssignResult struct {
	how          ownerAssignment
	privilegeErr error // SeRestorePrivilege could not be enabled (nil if it was)
	primaryErr   error // the invalid-owner refusal the fallback replaced
}

// assignOwnerWithFallback applies a security descriptor whose owner is
// primary, stepping down only as far as it must:
//
//  1. apply(primary) with the token as it is;
//  2. on an invalid-owner refusal, enable the restore privilege and
//     apply(primary) again, releasing the privilege straight afterwards;
//  3. if that is still refused as invalid-owner (or the privilege could not
//     be enabled), apply(fallback).
//
// Any error that is not an invalid-owner refusal is returned unchanged at the
// step it happened: access denied, a missing path or a sharing violation
// never trigger the fallback, so the fallback can only ever change WHICH
// trusted owner is written, never whether the descriptor is written. When
// primary == fallback there is nothing to fall back to and the refusal is
// returned.
//
// apply must write the whole descriptor (owner, group and protected DACL) in
// one call, so an owner fallback still installs the hardened DACL.
//
// It is generic, and takes every side effect as a function, so the decision
// can be tested on every platform; permissions_windows.go supplies the real
// SetNamedSecurityInfo and privilege calls.
func assignOwnerWithFallback[T comparable](
	primary, fallback T,
	apply func(owner T) error,
	isInvalidOwner func(error) bool,
	enablePrivilege func() (release func(), err error),
) (ownerAssignResult, error) {
	err := apply(primary)
	if err == nil {
		return ownerAssignResult{how: ownerAssignedDirect}, nil
	}
	if !isInvalidOwner(err) {
		return ownerAssignResult{}, err
	}
	primaryErr := err

	release, privErr := enablePrivilege()
	if privErr == nil {
		// Released before any fallback attempt (and on a panic): the
		// privilege is held only for the one call that needs it.
		err = func() error {
			defer release()
			return apply(primary)
		}()
		if err == nil {
			return ownerAssignResult{how: ownerAssignedWithPrivilege}, nil
		}
		if !isInvalidOwner(err) {
			return ownerAssignResult{}, err
		}
	}

	if primary == fallback {
		return ownerAssignResult{}, primaryErr
	}
	if err := apply(fallback); err != nil {
		return ownerAssignResult{}, fmt.Errorf("%w; fallback owner also refused: %w", primaryErr, err)
	}
	return ownerAssignResult{how: ownerAssignedFallback, privilegeErr: privErr, primaryErr: primaryErr}, nil
}
