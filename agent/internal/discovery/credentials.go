package discovery

import (
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/snmppoll"
	"github.com/gosnmp/gosnmp"
)

// SNMPCredential is one way the discovery probe may authenticate to a target.
// It is the agent-side shape of the profile's `snmpCredentials` object
// (v3 user + protocols + passphrases) and of each `snmpCommunities` entry
// (v2c community). Issue #6234: before this type existed the probe only knew
// community strings, so a v3 profile silently went on the wire as v2c/"public".
type SNMPCredential struct {
	Version        string // "v1", "v2c" or "v3"
	Community      string // v1/v2c only
	Username       string // v3 only
	AuthProtocol   string // v3: MD5, SHA, SHA224, SHA256, SHA384, SHA512
	AuthPassphrase string
	PrivProtocol   string // v3: DES, AES, AES192, AES256, AES192C, AES256C
	PrivPassphrase string
	Port           int           // 0 → 161
	Timeout        time.Duration // 0 → the scan-level timeout
	Retries        int           // 0 → 1
}

// IsV3 reports whether this credential drives an SNMPv3/USM exchange.
func (c SNMPCredential) IsV3() bool {
	return normalizeSNMPVersion(c.Version) == "v3"
}

// usable reports whether the credential carries enough to put a request on
// the wire at all: a v3 user name, or a v1/v2c community.
func (c SNMPCredential) usable() bool {
	if c.IsV3() {
		return strings.TrimSpace(c.Username) != ""
	}
	return strings.TrimSpace(c.Community) != ""
}

// securityLevel mirrors snmppoll's inference so logs say what actually went
// on the wire.
func (c SNMPCredential) securityLevel() string {
	if strings.TrimSpace(c.PrivPassphrase) != "" || snmppoll.ParsePrivProtocol(c.PrivProtocol) != gosnmp.NoPriv {
		return "authPriv"
	}
	if strings.TrimSpace(c.AuthPassphrase) != "" || snmppoll.ParseAuthProtocol(c.AuthProtocol) != gosnmp.NoAuth {
		return "authNoPriv"
	}
	return "noAuthNoPriv"
}

// Describe returns a log-safe summary. It never includes a passphrase or a
// community string — both are secrets the operator stored encrypted.
func (c SNMPCredential) Describe() string {
	if c.IsV3() {
		return fmt.Sprintf("v3 user=%s auth=%s priv=%s level=%s",
			c.Username,
			strings.ToUpper(defaultString(c.AuthProtocol, "none")),
			strings.ToUpper(defaultString(c.PrivProtocol, "none")),
			c.securityLevel())
	}
	return fmt.Sprintf("%s community=<redacted len=%d>", normalizeSNMPVersion(c.Version), len(c.Community))
}

func defaultString(s, def string) string {
	if strings.TrimSpace(s) == "" {
		return def
	}
	return s
}

// clientConfig turns the credential into an snmppoll client config for one
// target. fallbackTimeout is the scan-level timeout used when the credential
// does not carry its own.
func (c SNMPCredential) clientConfig(target string, fallbackTimeout time.Duration) snmppoll.SNMPClientConfig {
	cfg := snmppoll.SNMPClientConfig{
		Target:  target,
		Port:    161,
		Timeout: fallbackTimeout,
		Retries: 1,
	}
	if c.Port > 0 && c.Port <= 65535 {
		cfg.Port = uint16(c.Port)
	}
	if c.Timeout > 0 {
		cfg.Timeout = c.Timeout
	}
	if c.Retries > 0 {
		cfg.Retries = c.Retries
	}
	switch normalizeSNMPVersion(c.Version) {
	case "v3":
		cfg.Version = snmppoll.Version3
		cfg.Auth = snmppoll.SNMPAuth{
			Username:       strings.TrimSpace(c.Username),
			AuthProtocol:   snmppoll.ParseAuthProtocol(c.AuthProtocol),
			AuthPassphrase: c.AuthPassphrase,
			PrivProtocol:   snmppoll.ParsePrivProtocol(c.PrivProtocol),
			PrivPassphrase: c.PrivPassphrase,
		}
	case "v1":
		cfg.Version = snmppoll.Version1
		cfg.Auth = snmppoll.SNMPAuth{Community: c.Community}
	default:
		cfg.Version = snmppoll.Version2c
		cfg.Auth = snmppoll.SNMPAuth{Community: c.Community}
	}
	return cfg
}

func normalizeSNMPVersion(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "v3", "3":
		return "v3"
	case "v1", "1":
		return "v1"
	default:
		return "v2c"
	}
}

// credentialFromCommunity maps one legacy `snmpCommunities` entry. The
// historical "v3:<user>" prefix (noAuthNoPriv) is still honored.
func credentialFromCommunity(raw string) (SNMPCredential, bool) {
	community := strings.TrimSpace(raw)
	if community == "" {
		return SNMPCredential{}, false
	}
	if strings.HasPrefix(strings.ToLower(community), "v3:") {
		user := strings.TrimSpace(community[len("v3:"):])
		if user == "" {
			return SNMPCredential{}, false
		}
		return SNMPCredential{Version: "v3", Username: user}, true
	}
	return SNMPCredential{Version: "v2c", Community: community}, true
}

// ResolveSNMPCredentials builds the ordered list the probe will try:
// structured credentials first (a configured v3 user must be tried before any
// community), then the profile's explicit communities.
//
// The implicit "public" default applies ONLY when the operator configured
// nothing at all. If anything was configured — even something unusable, such
// as a v3 entry with no user name — the result is what could be salvaged and
// possibly empty, never "public": probing v2c/public against a device the
// operator believes is polled authPriv is the defect of issue #6234.
func ResolveSNMPCredentials(creds []SNMPCredential, communities []string) []SNMPCredential {
	configured := false
	out := make([]SNMPCredential, 0, len(creds)+len(communities))
	for _, c := range creds {
		configured = true
		if !c.usable() {
			slog.Warn("SNMP credential skipped: unusable", "credential", c.Describe(),
				"reason", "v3 needs a username; v1/v2c need a community")
			continue
		}
		c.Version = normalizeSNMPVersion(c.Version)
		out = append(out, c)
	}
	for _, raw := range communities {
		// Any entry — even a blank one — means the operator touched the list;
		// this matches the pre-#6234 rule that only an EMPTY list defaulted.
		configured = true
		if c, ok := credentialFromCommunity(raw); ok {
			out = append(out, c)
		}
	}
	if !configured {
		return []SNMPCredential{{Version: "v2c", Community: "public"}}
	}
	if len(out) == 0 {
		slog.Warn("SNMP configured but no usable credential resolved; SNMP discovery will collect nothing")
	}
	return out
}

// classifySNMPProbeError buckets a probe failure so the scan summary can say
// why SNMP yielded nothing without dumping per-host noise.
func classifySNMPProbeError(err error) string {
	if err == nil {
		return "ok"
	}
	switch {
	case errors.Is(err, gosnmp.ErrUnknownUsername),
		errors.Is(err, gosnmp.ErrWrongDigest),
		errors.Is(err, gosnmp.ErrDecryption),
		errors.Is(err, gosnmp.ErrUnknownSecurityLevel):
		return "credentials_rejected"
	}
	if strings.Contains(strings.ToLower(err.Error()), "timeout") {
		return "no_response"
	}
	return "error"
}
