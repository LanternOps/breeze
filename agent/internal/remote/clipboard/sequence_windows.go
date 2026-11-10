//go:build windows

package clipboard

var procGetClipboardSequenceNumber = user32.NewProc("GetClipboardSequenceNumber")

// SequenceNumber is the window station's clipboard sequence number. Windows
// bumps it on every clipboard change, and reading it does not open the
// clipboard. ok is false when it is 0, which means this process may not access
// the window station's clipboard.
func SequenceNumber() (uint64, bool) {
	r, _, _ := procGetClipboardSequenceNumber.Call()
	if r == 0 {
		return 0, false
	}
	return uint64(uint32(r)), true
}
