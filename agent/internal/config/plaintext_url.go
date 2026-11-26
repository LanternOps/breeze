package config

import (
	"net"
	"net/url"
	"strings"
)

// PlaintextRemoteHost reports whether raw is an unencrypted (http:// or ws://)
// URL whose host is not this machine, and returns that host when it is.
//
// The rule (#12729):
//   - https:// and wss:// never count, nor does any other scheme.
//   - A loopback host never counts (see IsLoopbackHost): traffic to it does
//     not leave the machine, which is how a local development server runs.
//   - Every other host counts, including private LAN addresses and .local
//     names. Traffic on a LAN can still be read and changed by anything else
//     on that network, so "it is internal" is not an exemption.
//
// A URL that does not parse, or has no host, returns false: the dial fails
// on its own and there is nothing meaningful to warn about.
func PlaintextRemoteHost(raw string) (string, bool) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", false
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "ws":
	default:
		return "", false
	}
	host := u.Hostname()
	if host == "" || IsLoopbackHost(host) {
		return "", false
	}
	return host, true
}

// IsLoopbackHost reports whether host names this machine: the name
// "localhost" (any case, with or without a trailing dot), or an IP literal in
// 127.0.0.0/8 or ::1 (including the IPv4-mapped form). The unspecified
// addresses (0.0.0.0, ::) are not loopback. No other name is resolved or
// trusted, including names under ".localhost": the Go resolver does not pin
// those to loopback, so DNS or a hosts file could send one anywhere.
func IsLoopbackHost(host string) bool {
	if strings.TrimSuffix(strings.ToLower(host), ".") == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
