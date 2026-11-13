package wayland

import "testing"

func TestKeycode(t *testing.T) {
	cases := []struct {
		name string
		code uint32
	}{
		{"a", 30},
		{"A", 30},
		{"q", 16},
		{"enter", 28},
		{"super", 125},
		{"win", 125},
		{"Left", 105},
		{"f5", 63},
		{" ", 57},
	}
	for _, tc := range cases {
		got, ok := Keycode(tc.name)
		if !ok || got != tc.code {
			t.Errorf("%q: got %d ok=%v, want %d", tc.name, got, ok, tc.code)
		}
	}
	if _, ok := Keycode("not-a-key"); ok {
		t.Fatal("unknown key should not map")
	}
}

func TestButtonCode(t *testing.T) {
	if buttonCode("left") != 0x110 || buttonCode("right") != 0x111 || buttonCode("") != 0x110 {
		t.Fatal(buttonCode("left"), buttonCode("right"), buttonCode(""))
	}
}
