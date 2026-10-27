package promptidentity

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

var fixtureDir = filepath.Join("..", "..", "..", "packages", "shared", "src", "fixtures", "prompt-catalog")

const (
	scopeA = "bad7313391508e4129c338752b2cc809"
	scopeB = "0f1e2d3c4b5a69788796a5b4c3d2e1f0"
)

// fixturePNG is the 1x1 PNG in fixtures/prompt-host/branding_sync.set.json
// (sha256 c962…ba99, 69 bytes).
func fixturePNG(t *testing.T) []byte {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQj18LAAHMASx1OSTTAAAAAElFTkSuQmCC")
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func shaHex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

type fakeFetcher struct {
	mu    sync.Mutex
	data  map[string][]byte
	err   error
	calls int
}

func (f *fakeFetcher) fetch(_ context.Context, sha string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	return f.data[sha], nil
}

func openTest(t *testing.T, dir string, f *fakeFetcher, onScope func(string)) *Store {
	t.Helper()
	opts := Options{OnScopeChange: onScope}
	if f != nil {
		opts.Fetch = f.fetch
	}
	return Open(dir, opts)
}

func setBlock(scope, name string) *HeartbeatBlock {
	return &HeartbeatBlock{State: StateSet, ScopeID: scope, PartnerName: name}
}

func TestDecodeHeartbeatIdentityFixtures(t *testing.T) {
	cases := map[string]func(t *testing.T, b *HeartbeatBlock){
		"heartbeat-identity.set.json": func(t *testing.T, b *HeartbeatBlock) {
			if b.State != StateSet || b.ScopeID != scopeA || b.PartnerName != "Example IT Services" || b.PrimaryColor != "#1F5FAD" {
				t.Fatalf("set = %+v", b)
			}
			if b.Logo == nil || b.Logo.Sha256 != "c96253573225f1fa2044af43896a96056903b359eed7af9fad90bd626127ba99" || b.Logo.Mime != "image/png" || b.Logo.Bytes != 69 {
				t.Fatalf("logo = %+v", b.Logo)
			}
		},
		"heartbeat-identity.minimal.json": func(t *testing.T, b *HeartbeatBlock) {
			if b.State != StateSet || b.ScopeID != scopeB || b.PartnerName != "" || b.Logo != nil || b.PrimaryColor != "" {
				t.Fatalf("minimal = %+v", b)
			}
		},
		"heartbeat-identity.cleared.json": func(t *testing.T, b *HeartbeatBlock) {
			if b.State != StateCleared {
				t.Fatalf("cleared = %+v", b)
			}
		},
	}
	for name, check := range cases {
		raw, err := os.ReadFile(filepath.Join(fixtureDir, name))
		if err != nil {
			t.Fatal(err)
		}
		b, err := DecodeBlock(raw)
		if err != nil || b == nil {
			t.Fatalf("%s: decode = %v, %v", name, b, err)
		}
		if err := b.validate(); err != nil {
			t.Fatalf("%s: fixture rejected: %v", name, err)
		}
		check(t, b)
		// Each fixture applies cleanly to a fresh store.
		s := openTest(t, t.TempDir(), nil, nil)
		if _, _, err := s.Apply(b); err != nil {
			t.Fatalf("%s: apply: %v", name, err)
		}
	}
}

func TestDecodeBlockAbsentNullAndMalformed(t *testing.T) {
	for _, raw := range []string{"", "null", "  null "} {
		b, err := DecodeBlock([]byte(raw))
		if b != nil || err != nil {
			t.Fatalf("%q = %v, %v; want absent", raw, b, err)
		}
	}
	for _, raw := range []string{`"set"`, `{"state":5}`, `[1]`, `{`} {
		if _, err := DecodeBlock([]byte(raw)); err == nil {
			t.Fatalf("%q decoded; want an error", raw)
		}
	}
	// Unknown keys are ignored (W02 decoder rule).
	b, err := DecodeBlock([]byte(`{"state":"set","scopeId":"` + scopeA + `","future":true}`))
	if err != nil || b == nil || b.ScopeID != scopeA {
		t.Fatalf("unknown key: %v, %v", b, err)
	}
}

func TestApplySetClearedAbsent(t *testing.T) {
	dir := t.TempDir()
	s := openTest(t, dir, nil, nil)
	if _, ok := s.Current(); ok {
		t.Fatal("fresh store has an identity")
	}

	// set stores.
	changed, scopeChanged, err := s.Apply(&HeartbeatBlock{State: StateSet, ScopeID: scopeA, PartnerName: "Example IT", PrimaryColor: "#1F5FAD"})
	if err != nil || !changed || scopeChanged {
		t.Fatalf("first set = %v %v %v", changed, scopeChanged, err)
	}
	id, ok := s.Current()
	if !ok || id.ScopeID != scopeA || id.PartnerName != "Example IT" || id.PrimaryColor != "#1F5FAD" {
		t.Fatalf("current = %+v %v", id, ok)
	}
	// The same block again changes nothing.
	if changed, _, _ := s.Apply(&HeartbeatBlock{State: StateSet, ScopeID: scopeA, PartnerName: "Example IT", PrimaryColor: "#1F5FAD"}); changed {
		t.Fatal("identical set reported a change")
	}

	// absent (nil) keeps.
	if changed, scopeChanged, err := s.Apply(nil); changed || scopeChanged || err != nil {
		t.Fatalf("absent = %v %v %v", changed, scopeChanged, err)
	}
	if id, ok := s.Current(); !ok || id.ScopeID != scopeA {
		t.Fatal("absent block dropped the identity")
	}

	// It survives a restart (offline).
	s2 := openTest(t, dir, nil, nil)
	if id, ok := s2.Current(); !ok || id.PartnerName != "Example IT" || id.ScopeID != scopeA {
		t.Fatalf("after reopen = %+v %v", id, ok)
	}

	// cleared deletes, on disk too.
	changed, scopeChanged, err = s2.Apply(&HeartbeatBlock{State: StateCleared})
	if err != nil || !changed || scopeChanged {
		t.Fatalf("cleared = %v %v %v", changed, scopeChanged, err)
	}
	if _, ok := s2.Current(); ok {
		t.Fatal("cleared kept the identity")
	}
	if _, ok := openTest(t, dir, nil, nil).Current(); ok {
		t.Fatal("cleared identity came back after reopen")
	}
	// A second cleared is a no-op.
	if changed, _, _ := s2.Apply(&HeartbeatBlock{State: StateCleared}); changed {
		t.Fatal("repeated cleared reported a change")
	}
}

func TestApplyResanitizesPartnerName(t *testing.T) {
	s := openTest(t, t.TempDir(), nil, nil)
	// Bidi override + zero-width + newline collapse; an all-invisible name is generic.
	if _, _, err := s.Apply(setBlock(scopeA, "  Example\u202e IT\u200b\n\nServices ")); err != nil {
		t.Fatal(err)
	}
	id, _ := s.Current()
	if id.PartnerName != "Example IT Services" {
		t.Fatalf("name = %q", id.PartnerName)
	}
	if _, _, err := s.Apply(setBlock(scopeA, "\u200b\u202e\u2066")); err != nil {
		t.Fatal(err)
	}
	id, _ = s.Current()
	if id.PartnerName != "" {
		t.Fatalf("invisible name = %q, want generic (empty)", id.PartnerName)
	}
	long := strings.Repeat("ab", 300)
	if _, _, err := s.Apply(setBlock(scopeA, long)); err != nil {
		t.Fatal(err)
	}
	id, _ = s.Current()
	if n := len([]rune(id.PartnerName)); n != 120 {
		t.Fatalf("long name kept %d code points, want 120", n)
	}
}

func TestApplyRejectsBadBlockWithoutClobbering(t *testing.T) {
	dir := t.TempDir()
	s := openTest(t, dir, nil, nil)
	if _, _, err := s.Apply(&HeartbeatBlock{State: StateSet, ScopeID: scopeA, PartnerName: "Example IT", PrimaryColor: "#1F5FAD"}); err != nil {
		t.Fatal(err)
	}
	bad := []*HeartbeatBlock{
		{State: "maybe"},
		{State: StateSet},
		{State: StateSet, ScopeID: strings.ToUpper(scopeB)},
		{State: StateSet, ScopeID: scopeB[:31]},
		{State: StateSet, ScopeID: scopeB + "0"},
		{State: StateSet, ScopeID: scopeB, PrimaryColor: "red"},
		{State: StateSet, ScopeID: scopeB, PrimaryColor: "#12345"},
		{State: StateSet, ScopeID: scopeB, PrimaryColor: "#1234567"},
		{State: StateSet, ScopeID: scopeB, Logo: &LogoMeta{Sha256: "zz", Mime: "image/png", Bytes: 10}},
		{State: StateSet, ScopeID: scopeB, Logo: &LogoMeta{Sha256: shaHex([]byte("x")), Mime: "image/svg+xml", Bytes: 10}},
		{State: StateSet, ScopeID: scopeB, Logo: &LogoMeta{Sha256: shaHex([]byte("x")), Mime: "image/png", Bytes: MaxLogoBytes + 1}},
		{State: StateSet, ScopeID: scopeB, Logo: &LogoMeta{Sha256: shaHex([]byte("x")), Mime: "image/png", Bytes: 0}},
	}
	purged := 0
	s.opts.OnScopeChange = func(string) { purged++ }
	for i, b := range bad {
		changed, scopeChanged, err := s.Apply(b)
		if err == nil || changed || scopeChanged {
			t.Fatalf("bad[%d] %+v accepted: %v %v %v", i, b, changed, scopeChanged, err)
		}
	}
	if purged != 0 {
		t.Fatal("a rejected block purged a scope")
	}
	for _, st := range []*Store{s, openTest(t, dir, nil, nil)} {
		id, ok := st.Current()
		if !ok || id.ScopeID != scopeA || id.PartnerName != "Example IT" || id.PrimaryColor != "#1F5FAD" {
			t.Fatalf("stored identity clobbered: %+v %v", id, ok)
		}
	}
}

func TestScopeChangeCallsPurgeBeforeStoring(t *testing.T) {
	dir := t.TempDir()
	var seen []string
	s := openTest(t, dir, nil, func(old string) {
		// At purge time the new identity is not yet stored (the callback
		// must not call into the store, so read the file).
		raw, err := os.ReadFile(filepath.Join(dir, DirName, IdentityFile))
		if err == nil && !strings.Contains(string(raw), old) {
			t.Errorf("purge of %s ran after the new identity was stored: %s", old, raw)
		}
		seen = append(seen, old)
	})
	if _, _, err := s.Apply(setBlock(scopeA, "A")); err != nil {
		t.Fatal(err)
	}
	changed, scopeChanged, err := s.Apply(setBlock(scopeB, "B"))
	if err != nil || !changed || !scopeChanged {
		t.Fatalf("scope change = %v %v %v", changed, scopeChanged, err)
	}
	if len(seen) != 1 || seen[0] != scopeA {
		t.Fatalf("purged %v, want [%s]", seen, scopeA)
	}
	// cleared then a set under another scope still purges the old one.
	if _, _, err := s.Apply(&HeartbeatBlock{State: StateCleared}); err != nil {
		t.Fatal(err)
	}
	if _, scopeChanged, _ := s.Apply(setBlock(scopeA, "A")); !scopeChanged {
		t.Fatal("cleared then a new scope was not a scope change")
	}
	if len(seen) != 2 || seen[1] != scopeB {
		t.Fatalf("purged %v, want [%s %s]", seen, scopeA, scopeB)
	}
	// cleared then the same scope again is not.
	if _, _, err := s.Apply(&HeartbeatBlock{State: StateCleared}); err != nil {
		t.Fatal(err)
	}
	if _, scopeChanged, _ := s.Apply(setBlock(scopeA, "A")); scopeChanged {
		t.Fatal("cleared then the same scope was reported as a scope change")
	}
}

func TestReenrolClearsIdentity(t *testing.T) {
	dir := t.TempDir()
	f := &fakeFetcher{data: map[string][]byte{}}
	png := fixturePNG(t)
	f.data[shaHex(png)] = png
	s := openTest(t, dir, f, nil)
	if _, _, err := s.Apply(&HeartbeatBlock{State: StateSet, ScopeID: scopeA, PartnerName: "A", Logo: &LogoMeta{Sha256: shaHex(png), Mime: "image/png", Bytes: len(png)}}); err != nil {
		t.Fatal(err)
	}
	if err := s.FetchLogo(context.Background(), shaHex(png)); err != nil {
		t.Fatal(err)
	}

	// The enrol command runs in its own process: it opens the store and clears it.
	if err := Open(dir, Options{}).Clear(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, DirName, LogoFile)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("logo.bin survived re-enrolment: %v", err)
	}
	var purged []string
	s2 := openTest(t, dir, nil, func(old string) { purged = append(purged, old) })
	if _, ok := s2.Current(); ok {
		t.Fatal("identity survived re-enrolment")
	}
	// The service's next heartbeat under the new enrolment purges the old scope.
	if _, scopeChanged, err := s2.Apply(setBlock(scopeB, "B")); err != nil || !scopeChanged {
		t.Fatalf("first set after re-enrol: scopeChanged=%v err=%v", scopeChanged, err)
	}
	if len(purged) != 1 || purged[0] != scopeA {
		t.Fatalf("purged %v, want [%s]", purged, scopeA)
	}

	// Clear on a store that never held anything writes nothing.
	empty := t.TempDir()
	if err := Open(empty, Options{}).Clear(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(empty, DirName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Clear on an empty store created %s: %v", DirName, err)
	}
}

func logoBlock(scope string, logo []byte) *HeartbeatBlock {
	return &HeartbeatBlock{State: StateSet, ScopeID: scope, PartnerName: "Example IT", Logo: &LogoMeta{Sha256: shaHex(logo), Mime: "image/png", Bytes: len(logo)}}
}

func TestFetchLogoStoresVerifiedBytes(t *testing.T) {
	dir := t.TempDir()
	png := fixturePNG(t)
	f := &fakeFetcher{data: map[string][]byte{shaHex(png): png}}
	s := openTest(t, dir, f, nil)
	if _, _, err := s.Apply(logoBlock(scopeA, png)); err != nil {
		t.Fatal(err)
	}
	if sha, need := s.NeedsLogo(); !need || sha != shaHex(png) {
		t.Fatalf("NeedsLogo = %s %v", sha, need)
	}
	if id, _ := s.Current(); id.Logo != nil {
		t.Fatal("logo present before it was fetched")
	}
	if err := s.FetchLogo(context.Background(), shaHex(png)); err != nil {
		t.Fatal(err)
	}
	if _, need := s.NeedsLogo(); need {
		t.Fatal("still needs the logo after a good fetch")
	}
	for _, st := range []*Store{s, openTest(t, dir, nil, nil)} {
		id, _ := st.Current()
		if id.Logo == nil || id.Logo.Sha256 != shaHex(png) || id.Logo.Mime != "image/png" || string(id.Logo.Data) != string(png) {
			t.Fatalf("logo = %+v", id.Logo)
		}
	}
	// A stale sha (not the identity's current logo) is refused without a fetch.
	calls := f.calls
	if err := s.FetchLogo(context.Background(), shaHex([]byte("other"))); err == nil {
		t.Fatal("stale sha fetched")
	}
	if f.calls != calls {
		t.Fatal("a stale sha reached the network")
	}
}

func TestLogoShaMismatchKeepsLastKnown(t *testing.T) {
	dir := t.TempDir()
	png := fixturePNG(t)
	f := &fakeFetcher{data: map[string][]byte{shaHex(png): png}}
	s := openTest(t, dir, f, nil)
	if _, _, err := s.Apply(logoBlock(scopeA, png)); err != nil {
		t.Fatal(err)
	}
	if err := s.FetchLogo(context.Background(), shaHex(png)); err != nil {
		t.Fatal(err)
	}

	// The server announces a new logo; the bytes it returns do not hash to it.
	newer := append(append([]byte{}, png...), 0x00)
	if _, _, err := s.Apply(logoBlock(scopeA, newer)); err != nil {
		t.Fatal(err)
	}
	f.data[shaHex(newer)] = png // wrong bytes for that sha
	if err := s.FetchLogo(context.Background(), shaHex(newer)); !errors.Is(err, ErrLogoMismatch) {
		t.Fatalf("mismatch err = %v", err)
	}
	checkLastKnown := func(st *Store) {
		t.Helper()
		id, _ := st.Current()
		if id.Logo == nil || id.Logo.Sha256 != shaHex(png) || string(id.Logo.Data) != string(png) {
			t.Fatalf("last-known logo lost: %+v", id.Logo)
		}
	}
	checkLastKnown(s)
	checkLastKnown(openTest(t, dir, nil, nil))

	// Oversized, empty, wrong-type and failed fetches also keep it.
	big := make([]byte, MaxLogoBytes+1)
	copy(big, png)
	for name, tc := range map[string]struct {
		data []byte
		err  error
	}{
		"oversize":  {data: big},
		"empty":     {data: []byte{}},
		"transport": {err: errors.New("boom")},
	} {
		f.mu.Lock()
		f.err = tc.err
		f.data[shaHex(newer)] = tc.data
		f.mu.Unlock()
		if err := s.FetchLogo(context.Background(), shaHex(newer)); err == nil {
			t.Fatalf("%s: fetch succeeded", name)
		}
		checkLastKnown(s)
	}
	f.err = nil

	// Bytes that hash right but are not the announced type are refused.
	gif := []byte("GIF89a\x01\x00\x01\x00")
	if _, _, err := s.Apply(logoBlock(scopeA, gif)); err != nil {
		t.Fatal(err)
	}
	f.data[shaHex(gif)] = gif
	if err := s.FetchLogo(context.Background(), shaHex(gif)); err == nil {
		t.Fatal("a GIF passed as image/png")
	}
	checkLastKnown(s)

	// A tampered logo.bin is not served after a restart.
	if err := os.WriteFile(filepath.Join(dir, DirName, LogoFile), []byte("tampered"), 0o644); err != nil {
		t.Fatal(err)
	}
	if id, _ := openTest(t, dir, nil, nil).Current(); id.Logo != nil {
		t.Fatal("tampered logo.bin served")
	}
}

func TestLogoDroppedOnScopeChangeAndNoLogo(t *testing.T) {
	dir := t.TempDir()
	png := fixturePNG(t)
	f := &fakeFetcher{data: map[string][]byte{shaHex(png): png}}
	s := openTest(t, dir, f, nil)
	if _, _, err := s.Apply(logoBlock(scopeA, png)); err != nil {
		t.Fatal(err)
	}
	if err := s.FetchLogo(context.Background(), shaHex(png)); err != nil {
		t.Fatal(err)
	}
	// Another MSP's identity never shows the old MSP's logo.
	if _, _, err := s.Apply(logoBlock(scopeB, append(append([]byte{}, png...), 1))); err != nil {
		t.Fatal(err)
	}
	if id, _ := s.Current(); id.Logo != nil {
		t.Fatal("old scope's logo shown under the new scope")
	}
	// Same scope, server says no logo: dropped.
	if _, _, err := s.Apply(logoBlock(scopeB, png)); err != nil {
		t.Fatal(err)
	}
	if err := s.FetchLogo(context.Background(), shaHex(png)); err != nil {
		t.Fatal(err)
	}
	changed, _, err := s.Apply(setBlock(scopeB, "Example IT"))
	if err != nil || !changed {
		t.Fatalf("no-logo set = %v %v", changed, err)
	}
	if id, _ := s.Current(); id.Logo != nil {
		t.Fatal("logo kept after the server removed it")
	}
}

func TestPersistedFileIsJSONAndUserReadable(t *testing.T) {
	dir := t.TempDir()
	s := openTest(t, dir, nil, nil)
	if _, _, err := s.Apply(setBlock(scopeA, "Example IT")); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, DirName, IdentityFile))
	if err != nil {
		t.Fatal(err)
	}
	var v map[string]any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("identity.json is not JSON: %v", err)
	}
	// A corrupt file yields an empty store, not a crash.
	if err := os.WriteFile(filepath.Join(dir, DirName, IdentityFile), []byte("{"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, ok := openTest(t, dir, nil, nil).Current(); ok {
		t.Fatal("corrupt identity.json loaded")
	}
}
