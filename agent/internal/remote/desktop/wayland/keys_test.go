package wayland

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/desktop/x11"
)

// The portal path sends X keysyms, the same names the X11 injector accepts,
// including shifted and non-ASCII characters the evdev table could not name.
func TestKeysymMatchesX11(t *testing.T) {
	for _, name := range []string{"!", "@", "?", ":", "a", "A", "enter", "é"} {
		sym, ok := x11.KeysymForName(name)
		if !ok || sym == 0 {
			t.Fatalf("%q did not map (%d, %v)", name, sym, ok)
		}
	}
	if _, ok := x11.KeysymForName("not-a-key"); ok {
		t.Fatal("unknown key should not map")
	}
}

func TestButtonCode(t *testing.T) {
	if buttonCode("left") != 0x110 || buttonCode("right") != 0x111 || buttonCode("") != 0x110 {
		t.Fatal(buttonCode("left"), buttonCode("right"), buttonCode(""))
	}
}
