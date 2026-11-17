package tools

import "testing"

// Windows maps these names to devices in any folder: CON, PRN, AUX, NUL,
// CONIN$, CONOUT$, COM0-9 and LPT0-9 (and the superscript digits 1-3), with
// any extension and trailing spaces or dots.
func TestWindowsReservedDeviceNamesWithSuperscripts(t *testing.T) {
	for _, p := range []string{"C:/x/COM\u00b9", "C:/x/COM\u00b2.txt", "C:/x/LPT\u00b3", "C:/x/com0", "C:/x/LPT0.log", "C:/x/NUL.txt", "C:/x/nul. .", "C:/x/CONOUT$", "C:/x/conin$.txt", "C:/x/PRN ", "C:/x/Aux.tar.gz"} {
		if !hasWindowsReservedDeviceName(p) {
			t.Errorf("%q: not recognised", p)
		}
	}
	for _, p := range []string{"C:/x/COM\u00b9\u00b9", "C:/x/COM\u2074", "C:/x/COMA", "C:/x/LPTs", "C:/x/conout", "C:/x/nulls.txt"} {
		if hasWindowsReservedDeviceName(p) {
			t.Errorf("%q: wrongly recognised", p)
		}
	}
}
