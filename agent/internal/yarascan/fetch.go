package yarascan

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// BundleContentType is the media type the W03 fetch route serves (C2).
const BundleContentType = "application/vnd.breeze.yara-bundle+json"

// bundleFetchTimeout replaces the shared heartbeat client's short overall
// timeout for this request: a bundle can be up to 16 MiB, and the caller's
// context (the rule-set load deadline) still bounds the whole load.
const bundleFetchTimeout = 2 * time.Minute

// Fetcher retrieves and verifies one rule-set bundle. Every failure is a
// per-set *RuleSetError, never a scan failure.
type Fetcher interface {
	Fetch(ctx context.Context, ref RuleSetRef) (*Bundle, *RuleSetError)
}

// HTTPFetcher fetches bundles from the agent's own server with the agent's
// bearer token. BaseURL is the configured server URL; ref.URL is a validated
// server-relative path (ParseRuleSetRefs), so the request can only ever go to
// BaseURL's host. Redirects are refused outright.
type HTTPFetcher struct {
	BaseURL    string
	Client     *http.Client
	AuthHeader func() string
}

func refErr(ref RuleSetRef, code, detail string) *RuleSetError {
	return &RuleSetError{ID: ref.ID, Version: ref.Version, Code: code, Detail: truncate(detail, maxDetailLen)}
}

func (f *HTTPFetcher) target(ref RuleSetRef) (string, error) {
	base, err := url.Parse(strings.TrimRight(f.BaseURL, "/"))
	if err != nil || base.Host == "" || (base.Scheme != "https" && base.Scheme != "http") {
		return "", errors.New("agent server URL invalid")
	}
	if !validRefURL(ref.URL) {
		// Defence in depth: ParseRuleSetRefs already rejected this.
		return "", errors.New("rule set url is not a server-relative agent path")
	}
	t := url.URL{Scheme: base.Scheme, Host: base.Host, Path: strings.TrimRight(base.Path, "/") + ref.URL}
	return t.String(), nil
}

// Fetch GETs ref.URL, caps the body at MaxBundleBytes, verifies the sha256 pin
// over the exact bytes, and checks the bundle is the set + version the
// payload asked for.
func (f *HTTPFetcher) Fetch(ctx context.Context, ref RuleSetRef) (*Bundle, *RuleSetError) {
	if f.Client == nil || f.AuthHeader == nil {
		return nil, refErr(ref, CodeFetch, "fetcher not configured")
	}
	target, err := f.target(ref)
	if err != nil {
		return nil, refErr(ref, CodeFetch, err.Error())
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, refErr(ref, CodeFetch, err.Error())
	}
	req.Header.Set("Authorization", f.AuthHeader())
	req.Header.Set("Accept", BundleContentType)

	client := *f.Client // copy: never mutate the shared heartbeat client
	client.Timeout = bundleFetchTimeout
	client.CheckRedirect = func(*http.Request, []*http.Request) error {
		return errors.New("redirects are not followed for rule bundles")
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, refErr(ref, CodeFetch, err.Error())
	}
	defer func() { _ = resp.Body.Close() }()

	switch {
	case resp.StatusCode == http.StatusNotFound:
		return nil, refErr(ref, CodeHTTP404, "rule set not found or not visible to this device")
	case resp.StatusCode == http.StatusConflict:
		return nil, refErr(ref, CodeHTTP409, "rule set version is no longer current")
	case resp.StatusCode != http.StatusOK:
		return nil, refErr(ref, CodeFetch, fmt.Sprintf("HTTP %d", resp.StatusCode))
	}
	// Read one byte past the cap so an oversized body is detected, not
	// silently truncated into a sha256 mismatch.
	body, err := io.ReadAll(io.LimitReader(resp.Body, MaxBundleBytes+1))
	if err != nil {
		return nil, refErr(ref, CodeFetch, err.Error())
	}
	if len(body) > MaxBundleBytes {
		return nil, refErr(ref, CodeBundleInvalid, fmt.Sprintf("bundle exceeds the %d-byte cap", MaxBundleBytes))
	}
	b, err := ParseBundle(body, ref.SHA256)
	switch {
	case errors.Is(err, ErrSHA256Mismatch):
		return nil, refErr(ref, CodeSHA256Mismatch, err.Error())
	case err != nil:
		return nil, refErr(ref, CodeBundleInvalid, err.Error())
	}
	if b.RuleSetID != ref.ID || b.Version != ref.Version {
		return nil, refErr(ref, CodeBundleInvalid, "bundle id/version does not match the payload ref")
	}
	return b, nil
}
