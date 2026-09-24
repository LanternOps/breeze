package patching

import (
	"errors"
	"fmt"
)

// errUpdateNotFound is returned by the WUA provider's findUpdate when the
// search succeeded but no update matched the requested ID/KB. Distinct from a
// search failure, which must remain an install error (#6910).
var errUpdateNotFound = errors.New("update not found")

func isUpdateNotFound(err error) bool {
	return err != nil && errors.Is(err, errUpdateNotFound)
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
