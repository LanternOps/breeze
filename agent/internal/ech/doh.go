// Package ech fetches and uses Encrypted Client Hello configs for the
// agent's control-plane connection.
package ech

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ErrNoECHConfig means the HTTPS record carried no usable ech= SvcParam.
var ErrNoECHConfig = errors.New("ech: no ech= parameter in HTTPS record")

// DefaultEndpoints are the DoH JSON endpoints tried in order.
var DefaultEndpoints = []string{
	"https://cloudflare-dns.com/dns-query",
	"https://dns.google/resolve",
}

const (
	dnsTypeHTTPS = 65
	minTTL       = 5 * time.Minute
	maxTTL       = 24 * time.Hour
	maxBody      = 64 << 10
)

// ECHConfig is an ECHConfigList and how long it may be cached.
type ECHConfig struct {
	ConfigList []byte
	TTL        time.Duration
}

// Resolver looks up ECH configs via DNS-over-HTTPS (JSON API).
type Resolver struct {
	endpoints []string
	client    *http.Client
	now       func() time.Time
}

// NewResolver builds a Resolver. A nil client gets a 3 s timeout; no
// endpoints selects DefaultEndpoints.
func NewResolver(client *http.Client, endpoints ...string) *Resolver {
	if client == nil {
		client = &http.Client{Timeout: 3 * time.Second}
	}
	if len(endpoints) == 0 {
		endpoints = DefaultEndpoints
	}
	return &Resolver{endpoints: endpoints, client: client, now: time.Now}
}

type dohResponse struct {
	Status int `json:"Status"`
	Answer []struct {
		Type int    `json:"type"`
		TTL  int    `json:"TTL"`
		Data string `json:"data"`
	} `json:"Answer"`
}

// Lookup returns the ECH config for host, trying each endpoint in order and
// returning the last error if all fail.
func (r *Resolver) Lookup(ctx context.Context, host string) (ECHConfig, error) {
	var lastErr error
	for _, ep := range r.endpoints {
		cfg, err := r.lookupOne(ctx, ep, host)
		if err == nil {
			return cfg, nil
		}
		lastErr = fmt.Errorf("doh %s: %w", ep, err)
		if ctx.Err() != nil {
			break
		}
	}
	return ECHConfig{}, lastErr
}

func (r *Resolver) lookupOne(ctx context.Context, endpoint, host string) (ECHConfig, error) {
	q := url.Values{"name": {host}, "type": {"HTTPS"}}
	u := endpoint + "?" + q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return ECHConfig{}, err
	}
	req.Header.Set("Accept", "application/dns-json")
	resp, err := r.client.Do(req)
	if err != nil {
		return ECHConfig{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return ECHConfig{}, fmt.Errorf("unexpected status %d", resp.StatusCode)
	}
	var dr dohResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxBody)).Decode(&dr); err != nil {
		return ECHConfig{}, fmt.Errorf("decode response: %w", err)
	}
	for _, a := range dr.Answer {
		if a.Type != dnsTypeHTTPS {
			continue
		}
		list, err := parseECHParam(a.Data)
		if err != nil {
			if errors.Is(err, ErrNoECHConfig) {
				continue
			}
			return ECHConfig{}, err
		}
		ttl := time.Duration(a.TTL) * time.Second
		if ttl < minTTL {
			ttl = minTTL
		} else if ttl > maxTTL {
			ttl = maxTTL
		}
		return ECHConfig{ConfigList: list, TTL: ttl}, nil
	}
	return ECHConfig{}, ErrNoECHConfig
}

// parseECHParam extracts and base64-decodes the ech= SvcParam from a
// presentation-format HTTPS record ("1 . alpn=h2 ech=BASE64 ...").
func parseECHParam(data string) ([]byte, error) {
	for _, tok := range strings.Fields(data) {
		v, ok := strings.CutPrefix(tok, "ech=")
		if !ok {
			continue
		}
		v = strings.Trim(v, `"`)
		b, err := base64.StdEncoding.DecodeString(v)
		if err != nil {
			return nil, fmt.Errorf("ech: decode ech= value: %w", err)
		}
		return b, nil
	}
	return nil, ErrNoECHConfig
}
