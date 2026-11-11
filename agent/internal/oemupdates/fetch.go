package oemupdates

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var (
	// ErrHostNotAllowed is a URL, or a redirect hop, off the lane's host list.
	ErrHostNotAllowed = errors.New("download host is not on the lane allowlist")
	// ErrDigestMismatch is a download whose SHA-256 is not the pinned one.
	ErrDigestMismatch = errors.New("download sha256 does not match")
	// ErrTooLarge is a download over the size cap.
	ErrTooLarge = errors.New("download exceeds the size cap")
)

// maxDownloadBytes caps any vendor download. DCU and the .NET runtime are well
// under 200 MB; a variable so a test can lower it.
var maxDownloadBytes int64 = 512 << 20

const (
	maxRedirects    = 5
	downloadTimeout = 30 * time.Minute
)

// checkFetchURL accepts only an absolute https URL with no userinfo whose host
// is on allow.Hosts. An entry without a port matches only the default port; an
// entry with one (used by tests) matches host:port exactly.
func checkFetchURL(raw string, allow LaneAllowlist) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("parse url: %w", err)
	}
	if u.Scheme != "https" {
		return fmt.Errorf("refusing %q: only https downloads are allowed", u.Scheme)
	}
	if u.User != nil {
		return fmt.Errorf("%w: url carries userinfo", ErrHostNotAllowed)
	}
	host := strings.ToLower(u.Hostname())
	port := u.Port()
	for _, entry := range allow.Hosts {
		entry = strings.ToLower(entry)
		if strings.Contains(entry, ":") {
			if strings.ToLower(u.Host) == entry {
				return nil
			}
			continue
		}
		if host == entry && (port == "" || port == "443") {
			return nil
		}
	}
	return fmt.Errorf("%w: %s", ErrHostNotAllowed, u.Host)
}

// Fetch downloads rawURL to dest. The URL and every redirect hop must be https
// on an allowlisted host; the body is capped, hashed as it streams, and only a
// file whose SHA-256 equals want is published at dest. Anything else leaves no
// file behind.
func Fetch(ctx context.Context, client *http.Client, rawURL, want string, allow LaneAllowlist, dest string) error {
	if !sha256Pattern.MatchString(want) {
		return errors.New("pinned sha256 must be 64 lowercase hex characters")
	}
	if err := checkFetchURL(rawURL, allow); err != nil {
		return err
	}
	if client == nil {
		client = &http.Client{}
	}
	c := *client
	c.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= maxRedirects {
			return errors.New("too many redirects")
		}
		return checkFetchURL(req.URL.String(), allow)
	}
	ctx, cancel := context.WithTimeout(ctx, downloadTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	resp, err := c.Do(req)
	if err != nil {
		return fmt.Errorf("download: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download: http %d", resp.StatusCode)
	}
	if resp.ContentLength > maxDownloadBytes {
		return fmt.Errorf("%w: %d bytes declared", ErrTooLarge, resp.ContentLength)
	}

	tmp, err := os.CreateTemp(filepath.Dir(dest), "."+filepath.Base(dest)+".part-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	published := false
	defer func() {
		if !published {
			_ = os.Remove(tmpPath)
		}
	}()
	h := sha256.New()
	n, copyErr := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(resp.Body, maxDownloadBytes+1))
	if copyErr == nil {
		copyErr = tmp.Sync()
	}
	if closeErr := tmp.Close(); copyErr == nil {
		copyErr = closeErr
	}
	if copyErr != nil {
		return fmt.Errorf("download: %w", copyErr)
	}
	if n > maxDownloadBytes {
		return fmt.Errorf("%w: more than %d bytes", ErrTooLarge, maxDownloadBytes)
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		return fmt.Errorf("%w: got %s", ErrDigestMismatch, got)
	}
	if err := os.Rename(tmpPath, dest); err != nil {
		return err
	}
	published = true
	return nil
}

// httpFetcher is the production Fetcher.
type httpFetcher struct{ client *http.Client }

func (f httpFetcher) Fetch(ctx context.Context, url, sha string, allow LaneAllowlist, dest string) error {
	return Fetch(ctx, f.client, url, sha, allow, dest)
}
