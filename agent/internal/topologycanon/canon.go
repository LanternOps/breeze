// Package topologycanon holds the byte rules shared by every topology digest the
// agent computes (M1 network context, M2 SNMP adjacency and UniFi resources).
// They mirror packages/shared/src/validators/topologyCollectionCanonical.ts
// `stable()`: object keys sorted by UTF-8 bytes, undefined/omitted fields
// absent, no HTML escaping, and U+2028/U+2029 left unescaped like JSON.stringify.
package topologycanon

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
)

// ErrMalformed reports a value that cannot be canonicalized.
var ErrMalformed = errors.New("topology canonicalization: malformed value")

// Outcome is the per-scope collection outcome (shared collectionOutcomeSchema).
type Outcome string

const (
	Complete     Outcome = "complete"
	Partial      Outcome = "partial"
	Failed       Outcome = "failed"
	Unsupported  Outcome = "unsupported"
	NotAttempted Outcome = "not_attempted"
)

// StableJSON marshals v and re-encodes it with sorted keys and JSON.stringify
// escaping, preserving number text exactly (json.Number).
func StableJSON(v any) ([]byte, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var generic any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&generic); err != nil {
		return nil, err
	}
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if err := e.Encode(generic); err != nil {
		return nil, err
	}
	// JSON.stringify leaves these two separators unescaped; encoding/json does not.
	out := bytes.TrimSuffix(b.Bytes(), []byte("\n"))
	out = bytes.ReplaceAll(out, []byte(` `), []byte(" "))
	out = bytes.ReplaceAll(out, []byte(` `), []byte(" "))
	return out, nil
}

// StableString is StableJSON for sort keys; marshal errors yield "".
func StableString(v any) string { b, _ := StableJSON(v); return string(b) }

// Object round-trips v through StableJSON into a generic map for field surgery.
func Object(v any) (map[string]any, error) {
	b, err := StableJSON(v)
	if err != nil {
		return nil, err
	}
	var m map[string]any
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	if err := d.Decode(&m); err != nil {
		return nil, err
	}
	return m, nil
}

// SortValues sorts by key bytes (Go string order == TS compareUtf8 order).
func SortValues(a []any, key func(any) string) {
	sort.SliceStable(a, func(i, j int) bool { return key(a[i]) < key(a[j]) })
}

// SortByStringField sorts generic objects by one string field (e.g. rowKey).
func SortByStringField(a []any, field string) error {
	for _, v := range a {
		m, ok := v.(map[string]any)
		if !ok {
			return ErrMalformed
		}
		if _, ok := m[field].(string); !ok {
			return ErrMalformed
		}
	}
	SortValues(a, func(v any) string { return v.(map[string]any)[field].(string) })
	return nil
}

// DigestHex is the lowercase SHA-256 hex of canonical bytes.
func DigestHex(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }
