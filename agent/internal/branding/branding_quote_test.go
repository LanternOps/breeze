package branding

import "testing"

// A double quote is dropped silently when PowerShell passes the value on to
// wix.exe, so every build-time gate refuses it instead of building a package
// with altered text.
func TestValidRejectsDoubleQuote(t *testing.T) {
	if Valid(`Acme "Pro"`) {
		t.Error("Valid must refuse a double quote")
	}
}

func TestUnitWithDescriptionRejectsDoubleQuote(t *testing.T) {
	unit := "[Unit]\nDescription=Breeze RMM Agent\n"
	got, err := UnitWithDescription(unit, `Acme "Pro"`)
	if err == nil {
		t.Error("want an error for a double quote")
	}
	if got != unit {
		t.Error("the unit must come back unchanged")
	}
}
