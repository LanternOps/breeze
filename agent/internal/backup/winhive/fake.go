package winhive

import "strings"

type fakeValueKind int

const (
	fakeValueString fakeValueKind = iota
	fakeValueDWORD
	fakeValueBinary
)

type fakeValue struct {
	name   string // original case, for ValueNames
	kind   fakeValueKind
	str    string
	dword  uint32
	binary []byte
}

// Fake is an in-memory hive tree — every test in winhive, rebuild and bmr
// (W06c) that needs a Key/Handle without a real Windows registry uses one.
// Keys and value names are matched case-insensitively (real registry
// semantics); paths are `\`-separated.
type Fake struct {
	name     string               // this key's own original-case name ("" for the root)
	children map[string]*Fake     // lower-cased name -> child
	values   map[string]fakeValue // lower-cased name -> value
}

// NewFake returns a fresh, empty root key. *Fake implements both Key
// (directly) and Handle (Root() returns the receiver itself — a Fake used
// as a Handle IS its own root, there is no separate "hive file" concept).
func NewFake() *Fake {
	return &Fake{children: map[string]*Fake{}, values: map[string]fakeValue{}}
}

var (
	_ Key    = (*Fake)(nil)
	_ Handle = (*Fake)(nil)
)

func (f *Fake) Root() Key    { return f }
func (f *Fake) Close() error { return nil }

func splitPath(path string) []string {
	path = strings.Trim(path, `\`)
	if path == "" {
		return nil
	}
	return strings.Split(path, `\`)
}

func (f *Fake) OpenKey(path string) (Key, error) {
	cur := f
	for _, seg := range splitPath(path) {
		child, ok := cur.children[strings.ToLower(seg)]
		if !ok {
			return nil, ErrNotExist
		}
		cur = child
	}
	return cur, nil
}

func (f *Fake) CreateKey(path string) (Key, error) {
	cur := f
	for _, seg := range splitPath(path) {
		lower := strings.ToLower(seg)
		child, ok := cur.children[lower]
		if !ok {
			child = &Fake{name: seg, children: map[string]*Fake{}, values: map[string]fakeValue{}}
			cur.children[lower] = child
		}
		cur = child
	}
	return cur, nil
}

func (f *Fake) DeleteKey(path string) error {
	segs := splitPath(path)
	if len(segs) == 0 {
		return nil
	}
	cur := f
	for _, seg := range segs[:len(segs)-1] {
		child, ok := cur.children[strings.ToLower(seg)]
		if !ok {
			return nil
		}
		cur = child
	}
	delete(cur.children, strings.ToLower(segs[len(segs)-1]))
	return nil
}

func (f *Fake) GetString(name string) (string, error) {
	v, ok := f.values[strings.ToLower(name)]
	if !ok || v.kind != fakeValueString {
		return "", ErrNotExist
	}
	return v.str, nil
}

func (f *Fake) GetDWORD(name string) (uint32, error) {
	v, ok := f.values[strings.ToLower(name)]
	if !ok || v.kind != fakeValueDWORD {
		return 0, ErrNotExist
	}
	return v.dword, nil
}

func (f *Fake) GetBinary(name string) ([]byte, error) {
	v, ok := f.values[strings.ToLower(name)]
	if !ok || v.kind != fakeValueBinary {
		return nil, ErrNotExist
	}
	return append([]byte(nil), v.binary...), nil
}

func (f *Fake) SetString(name, value string) error {
	f.values[strings.ToLower(name)] = fakeValue{name: name, kind: fakeValueString, str: value}
	return nil
}

func (f *Fake) SetDWORD(name string, value uint32) error {
	f.values[strings.ToLower(name)] = fakeValue{name: name, kind: fakeValueDWORD, dword: value}
	return nil
}

func (f *Fake) SetBinary(name string, value []byte) error {
	f.values[strings.ToLower(name)] = fakeValue{name: name, kind: fakeValueBinary, binary: append([]byte(nil), value...)}
	return nil
}

func (f *Fake) DeleteValue(name string) error {
	delete(f.values, strings.ToLower(name))
	return nil
}

func (f *Fake) ValueNames() ([]string, error) {
	out := make([]string, 0, len(f.values))
	for _, v := range f.values {
		out = append(out, v.name)
	}
	return out, nil
}

func (f *Fake) SubKeyNames() ([]string, error) {
	out := make([]string, 0, len(f.children))
	for _, c := range f.children {
		out = append(out, c.name)
	}
	return out, nil
}
