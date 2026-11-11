package providers

import (
	"encoding/json"
	"encoding/xml"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
)

// keyPrefixVectors is testdata/key-prefix-vectors.json, which the TypeScript
// side (normalizeBackupDestinationPrefix, physicalKeyFor/logicalKeyFrom) reads
// too, so the two implementations cannot drift apart.
type keyPrefixVectors struct {
	Normalize []struct {
		Raw    *string `json:"raw"`
		OK     bool    `json:"ok"`
		Prefix *string `json:"prefix"`
		Reason string  `json:"reason"`
		Note   string  `json:"note"`
	} `json:"normalize"`
	Map []struct {
		Prefix   *string `json:"prefix"`
		Logical  string  `json:"logical"`
		Physical string  `json:"physical"`
	} `json:"map"`
	Unmap []struct {
		Prefix   *string `json:"prefix"`
		Physical string  `json:"physical"`
		Logical  *string `json:"logical"`
	} `json:"unmap"`
}

func loadKeyPrefixVectors(t *testing.T) keyPrefixVectors {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "key-prefix-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v keyPrefixVectors
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Normalize) == 0 || len(v.Map) == 0 || len(v.Unmap) == 0 {
		t.Fatal("key-prefix vectors are empty")
	}
	return v
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func TestNormalizeKeyPrefix_SharedVectors(t *testing.T) {
	for _, v := range loadKeyPrefixVectors(t).Normalize {
		raw := deref(v.Raw)
		got, err := NormalizeKeyPrefix(raw)
		if v.OK {
			if err != nil {
				t.Errorf("NormalizeKeyPrefix(%q) error = %v, want prefix %q (%s)", raw, err, deref(v.Prefix), v.Note)
				continue
			}
			if got != deref(v.Prefix) {
				t.Errorf("NormalizeKeyPrefix(%q) = %q, want %q (%s)", raw, got, deref(v.Prefix), v.Note)
			}
			continue
		}
		var kpe *KeyPrefixError
		if !errors.As(err, &kpe) {
			t.Errorf("NormalizeKeyPrefix(%q) = %q, %v; want a KeyPrefixError %q (%s)", raw, got, err, v.Reason, v.Note)
			continue
		}
		if kpe.Reason != v.Reason {
			t.Errorf("NormalizeKeyPrefix(%q) reason = %q, want %q (%s)", raw, kpe.Reason, v.Reason, v.Note)
		}
		if got != "" {
			t.Errorf("NormalizeKeyPrefix(%q) returned prefix %q alongside an error", raw, got)
		}
	}
}

func prefixedProvider(t *testing.T, endpoint string, prefix *string) *S3Provider {
	t.Helper()
	p := NewS3ProviderWithEndpoint("bucket", "us-east-1", endpoint, "key", "secret", "")
	if err := p.SetKeyPrefix(deref(prefix)); err != nil {
		t.Fatalf("SetKeyPrefix(%q): %v", deref(prefix), err)
	}
	return p
}

func TestS3Provider_KeyMapping_SharedVectors(t *testing.T) {
	v := loadKeyPrefixVectors(t)
	for _, m := range v.Map {
		p := prefixedProvider(t, "", m.Prefix)
		if got := p.physicalKey(m.Logical); got != m.Physical {
			t.Errorf("prefix %q: physicalKey(%q) = %q, want %q", deref(m.Prefix), m.Logical, got, m.Physical)
		}
	}
	for _, u := range v.Unmap {
		p := prefixedProvider(t, "", u.Prefix)
		got, ok := p.logicalKey(u.Physical)
		if u.Logical == nil {
			if ok {
				t.Errorf("prefix %q: logicalKey(%q) = %q, want refused", deref(u.Prefix), u.Physical, got)
			}
			continue
		}
		if !ok || got != *u.Logical {
			t.Errorf("prefix %q: logicalKey(%q) = %q, %v; want %q", deref(u.Prefix), u.Physical, got, ok, *u.Logical)
		}
	}
}

func TestS3Provider_SetKeyPrefix_InvalidLeavesProviderUnchanged(t *testing.T) {
	p := NewS3Provider("bucket", "us-east-1", "key", "secret", "")
	if err := p.SetKeyPrefix("msp/acme"); err != nil {
		t.Fatal(err)
	}
	err := p.SetKeyPrefix("a//b")
	var kpe *KeyPrefixError
	if !errors.As(err, &kpe) || kpe.Reason != "empty_or_dot_segment" {
		t.Fatalf("SetKeyPrefix(a//b) = %v, want empty_or_dot_segment", err)
	}
	if p.KeyPrefix() != "msp/acme" {
		t.Fatalf("KeyPrefix() = %q after a refused change, want msp/acme", p.KeyPrefix())
	}
	if err := p.SetKeyPrefix("  /  "); err != nil {
		t.Fatal(err)
	}
	if p.KeyPrefix() != "" {
		t.Fatalf("KeyPrefix() = %q, want none", p.KeyPrefix())
	}
}

// A prefixed destination is a different destination for the checkpoint
// journal and for incremental-base matching: a journal written at the bucket
// root must never be resumed under a prefix, where its objects do not exist.
// An unprefixed provider keeps the identity the API delivers for brokered
// writes (helperStorageIdentity), byte for byte.
func TestS3Provider_BackupIdentity_KeyPrefix(t *testing.T) {
	plain := NewS3ProviderWithEndpoint("bucket", "us-east-1", "https://minio", "key", "secret", "")
	if got, want := plain.BackupIdentity(), "s3|https://minio|us-east-1|bucket"; got != want {
		t.Fatalf("unprefixed identity = %q, want %q", got, want)
	}
	a := NewS3ProviderWithEndpoint("bucket", "us-east-1", "https://minio", "key", "secret", "")
	b := NewS3ProviderWithEndpoint("bucket", "us-east-1", "https://minio", "key", "secret", "")
	if err := a.SetKeyPrefix("orgA"); err != nil {
		t.Fatal(err)
	}
	if err := b.SetKeyPrefix("orgB"); err != nil {
		t.Fatal(err)
	}
	if a.BackupIdentity() == plain.BackupIdentity() || a.BackupIdentity() == b.BackupIdentity() {
		t.Fatalf("identities must differ: plain=%q a=%q b=%q", plain.BackupIdentity(), a.BackupIdentity(), b.BackupIdentity())
	}
}

// listingFakeS3 is a minimal in-memory, path-style S3 endpoint: PUT/GET/DELETE of
// an object and ListObjectsV2. It records every object key it was asked for.
type listingFakeS3 struct {
	mu      sync.Mutex
	objects map[string][]byte
	seen    []string
}

func newListingFakeS3() *listingFakeS3 { return &listingFakeS3{objects: map[string][]byte{}} }

func (f *listingFakeS3) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	path := strings.TrimPrefix(r.URL.EscapedPath(), "/")
	path = strings.TrimPrefix(path, "bucket")
	path = strings.TrimPrefix(path, "/")
	key, err := url.PathUnescape(path)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if key == "" && r.Method == http.MethodGet && r.URL.Query().Get("list-type") == "2" {
		prefix := r.URL.Query().Get("prefix")
		f.seen = append(f.seen, "LIST "+prefix)
		type content struct {
			Key  string `xml:"Key"`
			Size int    `xml:"Size"`
		}
		res := struct {
			XMLName     xml.Name  `xml:"ListBucketResult"`
			Name        string    `xml:"Name"`
			Prefix      string    `xml:"Prefix"`
			KeyCount    int       `xml:"KeyCount"`
			IsTruncated bool      `xml:"IsTruncated"`
			Contents    []content `xml:"Contents"`
		}{Name: "bucket", Prefix: prefix}
		keys := make([]string, 0, len(f.objects))
		for k := range f.objects {
			if strings.HasPrefix(k, prefix) {
				keys = append(keys, k)
			}
		}
		sort.Strings(keys)
		for _, k := range keys {
			res.Contents = append(res.Contents, content{Key: k, Size: len(f.objects[k])})
		}
		res.KeyCount = len(res.Contents)
		w.Header().Set("Content-Type", "application/xml")
		_ = xml.NewEncoder(w).Encode(res)
		return
	}
	f.seen = append(f.seen, r.Method+" "+key)
	switch r.Method {
	case http.MethodPut:
		body, _ := io.ReadAll(r.Body)
		f.objects[key] = body
		w.Header().Set("ETag", `"etag"`)
	case http.MethodGet:
		body, ok := f.objects[key]
		if !ok {
			w.Header().Set("Content-Type", "application/xml")
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>`))
			return
		}
		_, _ = w.Write(body)
	case http.MethodDelete:
		delete(f.objects, key)
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "unsupported", http.StatusMethodNotAllowed)
	}
}

func (f *listingFakeS3) keys() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(f.objects))
	for k := range f.objects {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func (f *listingFakeS3) put(key, body string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.objects[key] = []byte(body)
}

// #9441: an S3 provider given a key prefix reads and writes the snapshot's
// physical keys (<prefix>/snapshots/...) while every caller keeps using the
// logical keys (snapshots/...) manifests embed — on every operation.
func TestS3Provider_KeyPrefix_RoundTripsThroughPhysicalKeys(t *testing.T) {
	fake := newListingFakeS3()
	server := httptest.NewServer(fake)
	defer server.Close()

	// A legacy object at the bucket root must stay invisible to the prefixed view.
	fake.put("snapshots/old/manifest.json", "legacy")

	p := NewS3ProviderWithEndpoint("bucket", "us-east-1", server.URL, "key", "secret", "")
	if err := p.SetKeyPrefix("/msp/acme/"); err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	src := filepath.Join(dir, "src.json")
	if err := os.WriteFile(src, []byte(`{"id":"s1"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := p.Upload(src, "snapshots/s1/manifest.json"); err != nil {
		t.Fatalf("Upload: %v", err)
	}
	if _, err := p.UploadWithDigest(t.Context(), src, "snapshots/s1/files/a.gz"); err != nil {
		t.Fatalf("UploadWithDigest: %v", err)
	}
	if got, want := fake.keys(), []string{"msp/acme/snapshots/s1/files/a.gz", "msp/acme/snapshots/s1/manifest.json", "snapshots/old/manifest.json"}; strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("stored keys = %v, want %v", got, want)
	}

	listed, err := p.List("snapshots/")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if got, want := strings.Join(listed, ","), "snapshots/s1/files/a.gz,snapshots/s1/manifest.json"; got != want {
		t.Fatalf("List(snapshots/) = %s, want %s", got, want)
	}

	dst := filepath.Join(dir, "dst.json")
	if err := p.Download("snapshots/s1/manifest.json", dst); err != nil {
		t.Fatalf("Download: %v", err)
	}
	if b, _ := os.ReadFile(dst); string(b) != `{"id":"s1"}` {
		t.Fatalf("downloaded %q", b)
	}
	if err := p.DownloadContext(t.Context(), "snapshots/old/manifest.json", dst); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("Download of a bucket-root key through the prefixed view = %v, want ErrObjectNotFound", err)
	}

	if err := p.Delete("snapshots/s1/files/a.gz"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if got, want := strings.Join(fake.keys(), ","), "msp/acme/snapshots/s1/manifest.json,snapshots/old/manifest.json"; got != want {
		t.Fatalf("keys after Delete = %s, want %s", got, want)
	}

	// Without a prefix nothing changes: the legacy object is right there.
	plain := NewS3ProviderWithEndpoint("bucket", "us-east-1", server.URL, "key", "secret", "")
	listed, err = plain.List("snapshots/")
	if err != nil {
		t.Fatal(err)
	}
	if got, want := strings.Join(listed, ","), "snapshots/old/manifest.json"; got != want {
		t.Fatalf("unprefixed List(snapshots/) = %s, want %s", got, want)
	}
}

// A listing answer naming a key outside the prefix root (a misbehaving
// S3-compatible backend) is refused rather than passed on with the prefix
// left on or silently dropped.
func TestS3Provider_KeyPrefix_ListRefusesKeyOutsideRoot(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/xml")
		_, _ = w.Write([]byte(`<ListBucketResult><Name>bucket</Name><KeyCount>1</KeyCount><IsTruncated>false</IsTruncated><Contents><Key>snapshots/s1/manifest.json</Key><Size>1</Size></Contents></ListBucketResult>`))
	}))
	defer server.Close()
	p := NewS3ProviderWithEndpoint("bucket", "us-east-1", server.URL, "key", "secret", "")
	if err := p.SetKeyPrefix("msp"); err != nil {
		t.Fatal(err)
	}
	if keys, err := p.List("snapshots/"); err == nil {
		t.Fatalf("List = %v, want an error for a key outside msp/", keys)
	}
}
