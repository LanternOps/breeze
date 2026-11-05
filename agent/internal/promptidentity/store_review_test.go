package promptidentity

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// syncBuf is a goroutine-safe log sink.
type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func testLogger() (*slog.Logger, *syncBuf) {
	buf := &syncBuf{}
	return slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug})), buf
}

func writeIdentityFile(t *testing.T, dir, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, DirName), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, DirName, IdentityFile), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLoadRefusesCorruptOrInvalidIdentityWithWarn(t *testing.T) {
	cases := map[string]string{
		"not json":      `{"version":1,"identity":{"scopeId":"` + scopeA,
		"bad scope":     `{"version":1,"identity":{"scopeId":"NOT-A-SCOPE","partnerName":"Example IT"}}`,
		"uppercase hex": `{"version":1,"identity":{"scopeId":"` + strings.ToUpper(scopeA) + `","partnerName":"Example IT"}}`,
		"short scope":   `{"version":1,"identity":{"scopeId":"` + scopeA[:31] + `"}}`,
	}
	for name, content := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			writeIdentityFile(t, dir, content)
			lg, buf := testLogger()
			s := Open(dir, Options{Log: lg})
			if id, ok := s.Current(); ok {
				t.Fatalf("refused file loaded an identity: %+v", id)
			}
			if out := buf.String(); !strings.Contains(out, "level=WARN") {
				t.Fatalf("no Warn logged for a refused identity.json; log = %q", out)
			}
		})
	}
}

// A re-enrolment over a corrupt identity.json still purges the scope that
// file held, at the next identity under another scope.
func TestCorruptIdentityKeepsScopeRecoverable(t *testing.T) {
	for name, content := range map[string]string{
		"truncated identity": `{"version":1,"identity":{"scopeId":"` + scopeA + `","partnerName":"Exa`,
		"truncated previous": `{"version":1,"previousScopeId":"` + scopeA + `","identity":{`,
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			writeIdentityFile(t, dir, content)
			lg, buf := testLogger()
			if err := Open(dir, Options{Log: lg}).Clear(); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(buf.String(), scopeA) {
				t.Fatalf("the recovered scope is not in the log: %q", buf.String())
			}
			var purged []string
			s := Open(dir, Options{OnScopeChange: func(old string) { purged = append(purged, old) }})
			if _, scopeChanged, err := s.Apply(setBlock(scopeB, "B")); err != nil || !scopeChanged {
				t.Fatalf("scopeChanged=%v err=%v", scopeChanged, err)
			}
			if len(purged) != 1 || purged[0] != scopeA {
				t.Fatalf("purged %v, want [%s]", purged, scopeA)
			}
		})
	}
}

func TestApplyClearedDeletesLogoFile(t *testing.T) {
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
	logoPath := filepath.Join(dir, DirName, LogoFile)
	if _, err := os.Stat(logoPath); err != nil {
		t.Fatalf("logo.bin not written: %v", err)
	}
	if changed, _, err := s.Apply(&HeartbeatBlock{State: StateCleared}); err != nil || !changed {
		t.Fatalf("cleared = %v %v", changed, err)
	}
	if _, err := os.Stat(logoPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("logo.bin survived a cleared identity: %v", err)
	}
	if _, ok := openTest(t, dir, nil, nil).Current(); ok {
		t.Fatal("a fresh Open has an identity after cleared")
	}
}

func TestFetchLogoRefusesOversizeWithMatchingSha(t *testing.T) {
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

	big := make([]byte, MaxLogoBytes+1)
	copy(big, png) // PNG magic, so only the size is wrong
	bigSha := shaHex(big)
	f.data[bigSha] = big
	// The block announces a size within the cap; the bytes hash right.
	if _, _, err := s.Apply(&HeartbeatBlock{State: StateSet, ScopeID: scopeA, PartnerName: "Example IT", Logo: &LogoMeta{Sha256: bigSha, Mime: "image/png", Bytes: 1000}}); err != nil {
		t.Fatal(err)
	}
	if err := s.FetchLogo(context.Background(), bigSha); !errors.Is(err, ErrLogoMismatch) {
		t.Fatalf("oversize logo with a matching sha: err = %v, want ErrLogoMismatch", err)
	}
	id, _ := s.Current()
	if id.Logo == nil || id.Logo.Sha256 != shaHex(png) {
		t.Fatalf("last-known logo lost: %+v", id.Logo)
	}
}

func TestApplyRetriesAFailedPersist(t *testing.T) {
	dir := t.TempDir()
	var fail sync.Once
	writes := 0
	s := Open(dir, Options{writeFile: func(path string, data []byte) error {
		writes++
		failed := false
		fail.Do(func() { failed = true })
		if failed {
			return errors.New("disk full")
		}
		return os.WriteFile(path, data, 0o644)
	}})
	block := setBlock(scopeA, "Example IT")
	changed, _, err := s.Apply(block)
	if err == nil || !changed {
		t.Fatalf("first apply = %v %v; want the write error", changed, err)
	}
	if _, ok := Open(dir, Options{}).Current(); ok {
		t.Fatal("precondition: nothing on disk after the failed write")
	}
	// The same block on the next heartbeat retries the write.
	if _, _, err := s.Apply(block); err != nil {
		t.Fatalf("retry apply: %v", err)
	}
	id, ok := Open(dir, Options{}).Current()
	if !ok || id.ScopeID != scopeA || id.PartnerName != "Example IT" {
		t.Fatalf("identity not persisted on retry: %+v %v (writes=%d)", id, ok, writes)
	}
	// Once persisted, an identical block writes nothing.
	before := writes
	if _, _, err := s.Apply(block); err != nil {
		t.Fatal(err)
	}
	if writes != before {
		t.Fatalf("clean store rewrote identity.json (%d writes)", writes-before)
	}
}

func TestLoadWarnsOnUnreadableOrBadStoredLogo(t *testing.T) {
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
	logoPath := filepath.Join(dir, DirName, LogoFile)

	for name, mutate := range map[string]func(){
		"tampered": func() { _ = os.WriteFile(logoPath, []byte("tampered"), 0o644) },
		"missing":  func() { _ = os.Remove(logoPath) },
	} {
		mutate()
		lg, buf := testLogger()
		id, ok := Open(dir, Options{Log: lg}).Current()
		if !ok || id.Logo != nil {
			t.Fatalf("%s: identity=%v logo=%+v; want the identity without the logo", name, ok, id.Logo)
		}
		if !strings.Contains(buf.String(), "level=WARN") {
			t.Fatalf("%s: no Warn for a stored logo that failed to load: %q", name, buf.String())
		}
	}
}
