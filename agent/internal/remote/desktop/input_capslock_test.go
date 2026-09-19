package desktop

import "testing"

// The reported symptom of issue #3595 is inconsistent casing, so the exact bit
// matters: kCGEventFlagMaskAlphaShift is 1<<16. A typo here would silently set
// some other modifier (Shift is 1<<17) and "fix" the bug into a different one.
func TestAlphaShiftMaskIsTheCoreGraphicsValue(t *testing.T) {
	t.Parallel()

	if got, want := cgEventFlagMaskAlphaShift, 0x00010000; got != want {
		t.Fatalf("cgEventFlagMaskAlphaShift = %#x, want %#x", got, want)
	}
}

func TestIsCapsLockKey(t *testing.T) {
	t.Parallel()

	for _, name := range []string{"capslock", "CapsLock", "  CAPSLOCK  "} {
		if !isCapsLockKey(name) {
			t.Fatalf("isCapsLockKey(%q) = false, want true", name)
		}
	}
	for _, name := range []string{"caps", "a", "numlock", ""} {
		if isCapsLockKey(name) {
			t.Fatalf("isCapsLockKey(%q) = true, want false", name)
		}
	}
}

// A viewer that never states the Caps Lock state must keep the agent on its
// legacy path byte-for-byte. This is the whole backward-compatibility contract:
// an old viewer talking to a new agent behaves exactly as it does today.
func TestApplyCapsLockFlagAbsentLeavesFlagsAndReportsNotAuthoritative(t *testing.T) {
	t.Parallel()

	flags, authoritative := applyCapsLockFlag(0x00040000, nil)
	if authoritative {
		t.Fatal("a nil assertion must not be treated as authoritative")
	}
	if got, want := flags, 0x00040000; got != want {
		t.Fatalf("flags = %#x, want them untouched (%#x)", got, want)
	}
}

func TestApplyCapsLockFlagSetsAndClearsWithoutDisturbingOtherModifiers(t *testing.T) {
	t.Parallel()

	const ctrl = 0x00040000

	on, authoritative := applyCapsLockFlag(ctrl, boolPtr(true))
	if !authoritative {
		t.Fatal("an explicit assertion must be authoritative")
	}
	if got, want := on, ctrl|cgEventFlagMaskAlphaShift; got != want {
		t.Fatalf("caps-on flags = %#x, want %#x", got, want)
	}

	// Caps off must CLEAR the bit rather than merely not set it: the incoming
	// mask can already carry a latched AlphaShift, which is the desync of #3595.
	off, authoritative := applyCapsLockFlag(ctrl|cgEventFlagMaskAlphaShift, boolPtr(false))
	if !authoritative {
		t.Fatal("an explicit assertion must be authoritative")
	}
	if got, want := off, ctrl; got != want {
		t.Fatalf("caps-off flags = %#x, want %#x (AlphaShift cleared, ctrl kept)", got, want)
	}
}

func TestApplyCapsLockFlagIsIdempotent(t *testing.T) {
	t.Parallel()

	once, _ := applyCapsLockFlag(0, boolPtr(true))
	twice, _ := applyCapsLockFlag(once, boolPtr(true))
	if once != twice {
		t.Fatalf("re-asserting the same state changed flags: %#x then %#x", once, twice)
	}
}

func TestSuppressCapsLockKey(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name     string
		key      string
		capsLock *bool
		want     bool
	}{
		{"asserted caps lock key is suppressed", "capslock", boolPtr(true), true},
		{"asserted caps lock key is suppressed when off too", "CapsLock", boolPtr(false), true},
		// The backward-compatibility case: an older viewer states nothing, so
		// the key keeps being injected exactly as it is today.
		{"unasserted caps lock key still injects", "capslock", nil, false},
		{"ordinary keys are never suppressed", "a", boolPtr(true), false},
		{"other lock keys are never suppressed", "numlock", boolPtr(true), false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := suppressCapsLockKey(tc.key, tc.capsLock); got != tc.want {
				t.Fatalf("suppressCapsLockKey(%q, %v) = %v, want %v", tc.key, tc.capsLock, got, tc.want)
			}
		})
	}
}

// sendKeyDown/sendKeyUp derive two things from one call — the flags to post and
// whether to call CGEventSetFlags at all (capsLockSetFlags). They only stay in
// step if "authoritative" means exactly "the viewer stated a state". Pinned as
// its own invariant so a later simplification of the two-value contract cannot
// quietly decouple them.
func TestApplyCapsLockFlagAuthoritativeMeansTheViewerStatedIt(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name     string
		capsLock *bool
	}{
		{"absent", nil},
		{"stated on", boolPtr(true)},
		{"stated off", boolPtr(false)},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			const base = 0x00040000 // ctrl, an unrelated modifier
			got, authoritative := applyCapsLockFlag(base, tc.capsLock)
			if want := tc.capsLock != nil; authoritative != want {
				t.Fatalf("authoritative = %v, want %v", authoritative, want)
			}
			// Non-authoritative must additionally be a pure pass-through.
			if !authoritative && got != base {
				t.Fatalf("non-authoritative call changed flags: %#x -> %#x", base, got)
			}
		})
	}
}
