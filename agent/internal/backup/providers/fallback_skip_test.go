package providers

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// contentProvider serves fixed bytes per key and records every download.
type contentProvider struct {
	objects   map[string]string
	downloads []string
}

func (c *contentProvider) Upload(string, string) error   { return nil }
func (c *contentProvider) List(string) ([]string, error) { return nil, nil }
func (c *contentProvider) Delete(string) error           { return nil }
func (c *contentProvider) Download(remote, local string) error {
	c.downloads = append(c.downloads, remote)
	body, ok := c.objects[remote]
	if !ok {
		return ErrObjectNotFound
	}
	return os.WriteFile(local, []byte(body), 0o600)
}

func TestFallbackDownloadSkippingPassesOverLeadingSources(t *testing.T) {
	vault := &contentProvider{objects: map[string]string{"k": "vault bytes"}}
	primary := &contentProvider{objects: map[string]string{"k": "primary bytes"}}
	f := NewFallbackProvider(vault, primary)
	var _ SourceSkipper = f

	cases := []struct {
		name    string
		skip    int
		want    string
		wantErr bool
	}{
		{name: "skip none reads the vault", skip: 0, want: "vault bytes"},
		{name: "skip one reads the primary", skip: 1, want: "primary bytes"},
		{name: "skip every source fails", skip: 2, wantErr: true},
		{name: "negative skip is refused", skip: -1, wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dest := filepath.Join(t.TempDir(), "out")
			err := f.DownloadSkipping(context.Background(), "k", dest, tc.skip)
			if tc.wantErr {
				if err == nil {
					t.Fatal("expected an error")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			got, _ := os.ReadFile(dest)
			if string(got) != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestFallbackSourceCount(t *testing.T) {
	f := NewFallbackProvider(&contentProvider{}, &contentProvider{})
	if f.SourceCount() != 2 {
		t.Fatalf("SourceCount = %d", f.SourceCount())
	}
}

func TestFallbackDownloadOnlyReadsOneSource(t *testing.T) {
	vault := &contentProvider{objects: map[string]string{}}
	primary := &contentProvider{objects: map[string]string{"k": "primary bytes"}}
	f := NewFallbackProvider(vault, primary)
	dest := filepath.Join(t.TempDir(), "out")
	if err := f.DownloadOnly(context.Background(), "k", dest, 0); err == nil {
		t.Fatal("source 0 lacks the object; DownloadOnly must not fall through")
	}
	if len(primary.downloads) != 0 {
		t.Fatal("primary was read")
	}
	if err := f.DownloadOnly(context.Background(), "k", dest, 1); err != nil {
		t.Fatal(err)
	}
	if err := f.DownloadOnly(context.Background(), "k", dest, 2); err == nil {
		t.Fatal("out-of-range source must fail")
	}
}
