package patching

import (
	"errors"
	"fmt"
)

// errUpdateNotFound is returned by the WUA provider's findUpdate when the
// search succeeded but no update matched the requested ID/KB. Distinct from a
// search failure, which must remain an install error (#6910).
var errUpdateNotFound = errors.New("not found")

func isUpdateNotFound(err error) bool {
	return err != nil && errors.Is(err, errUpdateNotFound)
}

// updateNotFoundError is findUpdate's miss result. It wraps errUpdateNotFound
// (skippable) only when every one of the `total` search results was actually
// inspected. If any result could not be read (a COM Item/Identity/UpdateID
// failure), the target may be one of them, so the miss is returned as a plain
// error that still fails the install and alerts. A skip must never hide a
// degraded enumeration.
func updateNotFoundError(patchID string, unreadable, total int) error {
	if unreadable > 0 {
		return fmt.Errorf("update %s not found; %d of %d search results could not be read", patchID, unreadable, total)
	}
	// Text is unchanged from before #6910: "update <id> not found".
	return fmt.Errorf("update %s %w", patchID, errUpdateNotFound)
}

// notOfferedInstallResult is the skipped outcome for an update that was in
// the scan set but is not offered at install time (#6910). WUA's fresh
// IsInstalled=0 search is the "is it still applicable" re-check; when it no
// longer returns the update, either it was installed in the meantime
// (alreadyInstalled) or it was superseded/expired — the normal case for
// Defender definition updates (KB2267602), which are republished several
// times a day. Neither is a failure; a replacement shows up on the next scan.
func notOfferedInstallResult(patchID string, alreadyInstalled bool) InstallResult {
	res := InstallResult{PatchID: patchID, Skipped: true}
	if alreadyInstalled {
		res.SkipReason = SkipReasonAlreadyInstalled
		res.Message = fmt.Sprintf("update %s is already installed; nothing to do", patchID)
	} else {
		res.SkipReason = SkipReasonNotOffered
		res.Message = fmt.Sprintf("update %s is no longer offered by Windows Update (superseded or expired since the scan); skipped", patchID)
	}
	return res
}
