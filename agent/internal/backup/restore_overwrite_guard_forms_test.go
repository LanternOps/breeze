package backup

import (
	"testing"
)

// Red evidence for strix3-12654 (not a fix): recorded-path forms that the
// placement code writes onto the original (Go's Windows filepath.VolumeName
// strips them like a drive letter) but that the guard neither flags nor
// fails on. Each case wants a hit or a failed check; today each is a silent
// pass. Host: Windows, emulated (withWindowsPaths + a fake identity check).

const formsGUID = `Volume{01234567-89ab-cdef-0123-456789abcdef}`

// guardOverWindowsHost runs the guard as a Windows host would, with the
// identity check over fake directories (ids name the directory: equal ids
// are the same directory).
func guardOverWindowsHost(t *testing.T, target string, dirs map[string]string, recorded []string) overwriteFinding {
	t.Helper()
	withWindowsPaths(t)
	g := newOriginalsGuard(target)
	c, _ := newRecordingWindowsCheck(target, dirs, nil)
	g.identity = c
	for _, p := range recorded {
		g.noteOriginal(p)
	}
	return g.check(recorded, originalsOf(recorded))
}

func TestOriginalsGuard_RecordedFormsAtVolumeRoot(t *testing.T) {
	dirs := map[string]string{`C:\`: "c", `C:\Users`: "cu", `C:\Users\a`: "cua", `\\?\` + formsGUID + `\`: "c"}
	for _, tc := range []struct{ target, recorded string }{
		{`C:\`, `C:\Users\a\x`}, // control: caught today
		{`C:\`, `\??\C:\Users\a\x`},
		{`\\?\` + formsGUID + `\`, `\??\` + formsGUID + `\Users\a\x`},
		{`C:\`, `//?/C:/Users/a/x`},
		{`C:\`, `\\?/C:\Users\a\x`},
		{`C:\`, `/??/C:/Users/a/x`},
		{`C:\`, `\Users\a\x`},
		{`C:\`, `/Users/a/x`},
	} {
		f := guardOverWindowsHost(t, tc.target, dirs, []string{tc.recorded})
		if f.count == 0 && f.uncheckedErr == nil {
			t.Errorf("target %s, entry %s: neither refused nor failed (silent pass)", tc.target, tc.recorded)
		}
	}
}

// An alias target (T:\ is C:\ by identity, as a SUBST drive is) against an
// original recorded with the NT prefix or the \\.\ device prefix.
func TestOriginalsGuard_AliasTargetAgainstDevicePrefixedOriginal(t *testing.T) {
	dirs := map[string]string{`T:\`: "c", `T:\Users`: "cu", `C:\`: "c", `C:\Users`: "cu"}
	for _, recorded := range []string{`C:\Users\a\x`, `\??\C:\Users\a\x`, `\\.\C:\Users\a\x`} {
		f := guardOverWindowsHost(t, `T:\`, dirs, []string{recorded})
		if f.count == 0 && f.uncheckedErr == nil {
			t.Errorf("alias target T:\\, entry %s: neither refused nor failed (silent pass)", recorded)
		}
	}
}

// Go's Windows VolumeName gives `\\?\UNC\srv\share\x` the volume `\\?\UNC`
// (only `\\.\UNC\` keeps server and share in the volume), so placement
// writes it to <target>\srv\share\x; the guard computes <target>\x. Here
// that placement lands on another original the snapshot holds.
func TestOriginalsGuard_DestinationFollowsPlacement(t *testing.T) {
	recorded := []string{`\\?\UNC\srv.invalid\share\x`, `C:\srv.invalid\share\x`}
	g := newOriginalsGuard(`C:\`)
	for _, p := range recorded {
		g.noteOriginal(p)
	}
	withWindowsPaths(t)
	c, _ := newRecordingWindowsCheck(`C:\`, map[string]string{}, nil)
	g.identity = c
	if f := g.check(recorded[:1], originalsOf(recorded)); f.count == 0 && f.uncheckedErr == nil {
		t.Errorf("entry %s lands on original %s under C:\\ (real Go placement) but the guard passes it", recorded[0], recorded[1])
	}
}
