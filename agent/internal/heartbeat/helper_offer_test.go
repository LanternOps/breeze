package heartbeat

import (
	"reflect"
	"testing"
)

type fakeHelperOffer struct {
	installed string
	onDisk    bool
	calls     []string
}

func (f *fakeHelperOffer) InstalledVersion() string { return f.installed }
func (f *fakeHelperOffer) IsInstalled() bool        { return f.onDisk }
func (f *fakeHelperOffer) CheckUpdate(v string)     { f.calls = append(f.calls, "check:"+v) }
func (f *fakeHelperOffer) WithdrawOffer()           { f.calls = append(f.calls, "withdraw") }

// #6927: a heartbeat with no helperUpgradeTo must clear the pending version,
// or a withdrawn offer keeps driving download + msiexec forever.
func TestApplyHelperOfferWithdrawsOnEmptyOffer(t *testing.T) {
	f := &fakeHelperOffer{}
	applyHelperOffer(f, "")
	if want := []string{"withdraw"}; !reflect.DeepEqual(f.calls, want) {
		t.Fatalf("calls=%v, want %v", f.calls, want)
	}
}

func TestApplyHelperOfferFreshInstall(t *testing.T) {
	f := &fakeHelperOffer{}
	applyHelperOffer(f, "0.117.0")
	if want := []string{"check:0.117.0"}; !reflect.DeepEqual(f.calls, want) {
		t.Fatalf("calls=%v, want %v", f.calls, want)
	}
}

// A refused downgrade is neither accepted nor treated as a withdrawal.
func TestApplyHelperOfferRefusedDowngradeTouchesNothing(t *testing.T) {
	f := &fakeHelperOffer{installed: "0.117.0", onDisk: true}
	applyHelperOffer(f, "0.116.0")
	if len(f.calls) != 0 {
		t.Fatalf("calls=%v, want none for a refused downgrade", f.calls)
	}
}
