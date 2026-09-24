package winhive

import (
	"errors"
	"testing"
)

func TestFake_CreateOpenGetSet(t *testing.T) {
	root := NewFake()
	k, err := root.CreateKey(`ControlSet001\Services\NTDS`)
	if err != nil {
		t.Fatal(err)
	}
	if err := k.SetDWORD("Start", 3); err != nil {
		t.Fatal(err)
	}
	got, err := root.OpenKey(`controlset001\services\ntds`) // case-insensitive, registry semantics
	if err != nil {
		t.Fatalf("case-insensitive OpenKey: %v", err)
	}
	v, err := got.GetDWORD("start") // value names are also case-insensitive
	if err != nil || v != 3 {
		t.Fatalf("GetDWORD = %d, %v", v, err)
	}
}

func TestFake_OpenKeyMissingReturnsErrNotExist(t *testing.T) {
	root := NewFake()
	if _, err := root.OpenKey(`Does\Not\Exist`); !errors.Is(err, ErrNotExist) {
		t.Fatalf("err = %v, want ErrNotExist", err)
	}
	if _, err := root.GetString("missing"); !errors.Is(err, ErrNotExist) {
		t.Fatalf("err = %v, want ErrNotExist", err)
	}
	if _, err := root.GetDWORD("missing"); !errors.Is(err, ErrNotExist) {
		t.Fatalf("err = %v, want ErrNotExist", err)
	}
}

func TestFake_DeleteKeyRecursiveAndIdempotent(t *testing.T) {
	root := NewFake()
	if _, err := root.CreateKey(`A\B\C`); err != nil {
		t.Fatal(err)
	}
	if err := root.DeleteKey("A"); err != nil {
		t.Fatal(err)
	}
	if _, err := root.OpenKey(`A\B\C`); !errors.Is(err, ErrNotExist) {
		t.Fatalf("A/B/C should be gone, err = %v", err)
	}
	if err := root.DeleteKey("A"); err != nil { // deleting an absent key is a no-op
		t.Fatalf("delete of absent key: %v", err)
	}
}

func TestFake_ValuesRoundTripStringDWORDBinary(t *testing.T) {
	root := NewFake()
	_ = root.SetString("Str", "hello")
	_ = root.SetDWORD("Num", 42)
	_ = root.SetBinary("Bin", []byte{1, 2, 3})
	if s, err := root.GetString("Str"); err != nil || s != "hello" {
		t.Fatalf("Str = %q, %v", s, err)
	}
	if n, err := root.GetDWORD("Num"); err != nil || n != 42 {
		t.Fatalf("Num = %d, %v", n, err)
	}
	b, err := root.GetBinary("Bin")
	if err != nil || len(b) != 3 || b[0] != 1 {
		t.Fatalf("Bin = %v, %v", b, err)
	}
	if err := root.DeleteValue("Num"); err != nil {
		t.Fatal(err)
	}
	if _, err := root.GetDWORD("Num"); !errors.Is(err, ErrNotExist) {
		t.Fatalf("Num should be deleted, err = %v", err)
	}
}

func TestFake_ValueNamesAndSubKeyNamesPreserveOriginalCase(t *testing.T) {
	root := NewFake()
	_ = root.SetString("MixedCase", "x")
	if _, err := root.CreateKey("ChildKey"); err != nil {
		t.Fatal(err)
	}
	names, err := root.ValueNames()
	if err != nil || len(names) != 1 || names[0] != "MixedCase" {
		t.Fatalf("ValueNames = %v, %v", names, err)
	}
	subs, err := root.SubKeyNames()
	if err != nil || len(subs) != 1 || subs[0] != "ChildKey" {
		t.Fatalf("SubKeyNames = %v, %v", subs, err)
	}
}

func TestFake_ImplementsKeyAndHandle(t *testing.T) {
	f := NewFake()
	var _ Key = f
	var h Handle = f
	got, ok := h.Root().(*Fake)
	if !ok || got != f {
		t.Fatalf("Root() should return the fake itself")
	}
	if err := h.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}
