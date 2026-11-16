package ech

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// BlockKind classifies what stood between the agent and its control plane
// (#8868). The strings are a closed wire enum shared with the API.
type BlockKind string

const (
	// BlockWebFilter: something answered the ClientHello with a parseable
	// plaintext HTTP reply other than 511 (an ISP gateway security feature,
	// a firewall web filter, a block page).
	BlockWebFilter BlockKind = "web_filter"
	// BlockCaptivePortal: a plaintext 511 Network Authentication Required.
	BlockCaptivePortal BlockKind = "captive_portal"
	// BlockPlaintextUnknown: the plaintext filter signature with no parseable
	// reply (fragmented, drain failed, or seen only through a proxy).
	BlockPlaintextUnknown BlockKind = "plaintext_unknown"
	// BlockUntrustedCertificate: the server certificate chains to an
	// authority this device does not trust (TLS inspection, private PKI, or a
	// broken self-hosted chain). Never bypassed and never engages ECH.
	BlockUntrustedCertificate BlockKind = "untrusted_certificate"
)

// PlaintextSignature reports whether k is one of the plaintext-HTTP filter
// kinds: the positive signature that ECH and alternate-host discovery key on.
func (k BlockKind) PlaintextSignature() bool {
	switch k {
	case BlockWebFilter, BlockCaptivePortal, BlockPlaintextUnknown:
		return true
	}
	return false
}

// BlockEvidence is what one failed dial learned about the interceptor. It
// holds sanitized values only: never captured bytes, a Location path, query,
// fragment or userinfo, or certificate bytes.
type BlockEvidence struct {
	Kind BlockKind
	// HTTPStatus is the plaintext reply's status (100-599), 0 when unknown.
	HTTPStatus int
	// LocationHost is the lowercased host of an absolute Location header,
	// or "".
	LocationHost string
	// CertIssuer is the untrusted leaf's issuer Organization (else
	// CommonName), printable ASCII, at most 64 characters, or "".
	CertIssuer string
	SeenAt     time.Time
}

// IsZero reports whether e carries no evidence.
func (e BlockEvidence) IsZero() bool { return e.Kind == "" }

// hostPattern is the wire contract for host and locationHost (D3).
var hostPattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$`)

const maxIssuerLen = 64

// SanitizeHost lowercases raw, strips a port and a trailing dot, and returns
// it only if it matches the wire host pattern; otherwise "". IPv6 literals
// are dropped.
func SanitizeHost(raw string) string {
	h := strings.ToLower(strings.TrimSpace(raw))
	if host, _, err := net.SplitHostPort(h); err == nil {
		h = host
	}
	h = strings.TrimSuffix(h, ".")
	if !hostPattern.MatchString(h) {
		return ""
	}
	return h
}

// SanitizeIssuer keeps printable ASCII (0x20-0x7E) only, trims spaces and
// caps the result at 64 characters: the wire contract for certIssuer.
func SanitizeIssuer(raw string) string {
	var b strings.Builder
	for i := 0; i < len(raw); i++ {
		if c := raw[i]; c >= 0x20 && c <= 0x7e {
			b.WriteByte(c)
		}
	}
	s := strings.TrimSpace(b.String())
	if len(s) > maxIssuerLen {
		s = strings.TrimSpace(s[:maxIssuerLen])
	}
	return s
}

// plaintextEvidence classifies a filter's captured reply. A 511 is a captive
// portal, any other valid status a web filter, and anything unparseable
// (including a reply whose header block never ended) plaintext_unknown.
func plaintextEvidence(captured []byte, now time.Time) BlockEvidence {
	ev := BlockEvidence{Kind: BlockPlaintextUnknown, SeenAt: now}
	resp, err := http.ReadResponse(bufio.NewReader(bytes.NewReader(captured)), nil)
	if err != nil {
		return ev
	}
	_ = resp.Body.Close()
	if resp.StatusCode < 100 || resp.StatusCode > 599 {
		return ev
	}
	ev.HTTPStatus = resp.StatusCode
	if resp.StatusCode == http.StatusNetworkAuthenticationRequired {
		ev.Kind = BlockCaptivePortal
	} else {
		ev.Kind = BlockWebFilter
	}
	if loc := resp.Header.Get("Location"); loc != "" {
		if u, perr := url.Parse(loc); perr == nil && u.IsAbs() {
			ev.LocationHost = SanitizeHost(u.Hostname())
		}
	}
	return ev
}

// certEvidence reports an untrusted-authority certificate failure. Hostname
// mismatches, expiry and TLS alerts are not evidence of an interceptor.
func certEvidence(err error, now time.Time) (BlockEvidence, bool) {
	if err == nil {
		return BlockEvidence{}, false
	}
	var uae x509.UnknownAuthorityError
	if !errors.As(err, &uae) {
		return BlockEvidence{}, false
	}
	leaf := uae.Cert
	var cve *tls.CertificateVerificationError
	if errors.As(err, &cve) && len(cve.UnverifiedCertificates) > 0 {
		leaf = cve.UnverifiedCertificates[0]
	}
	ev := BlockEvidence{Kind: BlockUntrustedCertificate, SeenAt: now}
	if leaf != nil {
		issuer := leaf.Issuer.CommonName
		if len(leaf.Issuer.Organization) > 0 && strings.TrimSpace(leaf.Issuer.Organization[0]) != "" {
			issuer = leaf.Issuer.Organization[0]
		}
		ev.CertIssuer = SanitizeIssuer(issuer)
	}
	return ev, true
}

// ErrorEvidence classifies a request error seen without the dialer's capture
// (for example through an HTTPS proxy, where the dialer is bypassed): the
// plaintext filter signature is plaintext_unknown, an untrusted authority is
// untrusted_certificate, and anything else is not evidence.
func ErrorEvidence(err error, now time.Time) (BlockEvidence, bool) {
	if IsFilterSignature(err) {
		return BlockEvidence{Kind: BlockPlaintextUnknown, SeenAt: now}, true
	}
	return certEvidence(err, now)
}
