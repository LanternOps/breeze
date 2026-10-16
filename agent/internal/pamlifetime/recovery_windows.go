//go:build windows

package pamlifetime

import (
	"context"

	"github.com/breeze-rmm/agent/internal/elevaccount"
	"golang.org/x/sys/windows"
)

// Only a lookup of the elevation account itself may prove account absence.
// This does not replace the independent orphan-token scan: deleted accounts
// can leave surviving tokens, while domain/lookup errors remain unknown.
func (*nativeWindowsPrimitives) VerifyElevationAccountAbsent(ctx context.Context) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	_, _, _, err := windows.LookupSID("", elevaccount.AccountName)
	if elevaccount.IsAccountAbsent(err) {
		return true, nil
	}
	return false, err
}
