#!/usr/bin/env python3
"""CONNECT-only egress proxy for the scheduled QA sweep agent.

The agent's process tree runs under a Seatbelt profile (qa-sandbox.sb) that
allows outbound connections to three loopback ports only. Its model calls go
to the runner's model forwarder (model-forwarder.py), which adds the
credential and is this proxy's one client, so this proxy is the only route off
the machine for the agent's traffic. It is deliberately narrow:

  - the request line must be exactly `CONNECT <name>:443 HTTP/1.x`, matched on
    the raw bytes, where <name> is a plain DNS hostname: letters, digits, dots
    and hyphens, LDH labels, no trailing dot, not numeric. A NUL, a control
    character, a percent sign, an IP literal or any other port never gets past
    this line, so nothing a client sends is reinterpreted by a later parser;
  - the hostname must EQUAL an allowlist entry (lowercase). There is no suffix
    or wildcard matching, and the allowlist itself is validated with the same
    hostname rule at startup;
  - the proxy resolves that exact validated name itself and dials only the
    public (globally routable) addresses it resolved to, never loopback,
    private, link-local or other special-use space.

Everything else gets 403. Each decision is logged one per line to a file the
agent cannot read or write.

  egress-proxy.py --allow api.anthropic.com --port-file F --log L

Python 3.9 stdlib only (the QA Mac's /usr/bin/python3).
"""
import argparse
import ipaddress
import os
import re
import select
import socket
import socketserver
import sys
import time

MAX_HEADER = 16384
PORT = 443

# One LDH label (RFC 1123), lowercase. Hostnames are compared after lowercasing.
LABEL_RE = re.compile(r"\A[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")
# The whole request line, byte for byte. Case is normalised after the match.
REQUEST_RE = re.compile(rb"\ACONNECT ([A-Za-z0-9.-]{1,253}):443 HTTP/1\.[01]\Z")


def valid_hostname(name):
    """True for a plain DNS name: >= 2 LDH labels, alphabetic TLD, no IP literal."""
    if not isinstance(name, str) or not name or len(name) > 253 or name != name.lower():
        return False
    labels = name.split(".")
    if len(labels) < 2 or not all(LABEL_RE.match(label) for label in labels):
        return False
    if labels[-1].isdigit():
        return False  # dotted-numeric forms (1.2.3.4, 0x7f.1, ...) are addresses, not names
    try:
        ipaddress.ip_address(name)
        return False
    except ValueError:
        return True


def parse_allowlist(spec):
    """Comma-separated exact hostnames -> frozenset; raises ValueError on any bad entry."""
    allow = [h.strip().lower() for h in spec.split(",") if h.strip()]
    if not allow:
        raise ValueError("empty allowlist")
    for h in allow:
        if not valid_hostname(h):
            raise ValueError("allowlist entries are exact hostnames (no '.suffix', wildcard or IP): %r" % h)
    return frozenset(allow)


def connect_target(line, allow):
    """The allowlisted hostname a CONNECT request line names, else None."""
    m = REQUEST_RE.match(line)
    if not m:
        return None
    host = m.group(1).decode("ascii").lower()
    if not valid_hostname(host) or host not in allow:
        return None
    return host


def public_addrs(infos):
    """(family, sockaddr) for the globally routable entries of a getaddrinfo() result."""
    out = []
    for family, _, _, _, sockaddr in infos:
        if family not in (socket.AF_INET, socket.AF_INET6):
            continue
        try:
            ip = ipaddress.ip_address(sockaddr[0])
        except ValueError:
            continue
        if ip.is_global and not ip.is_multicast:
            out.append((family, sockaddr))
    return out


def dial(host, resolver=socket.getaddrinfo, timeout=15):
    """Connect to port 443 of a validated hostname via its public addresses only."""
    if not valid_hostname(host):
        raise OSError("not a plain hostname")
    addrs = public_addrs(resolver(host, PORT, 0, socket.SOCK_STREAM))
    if not addrs:
        raise OSError("no public address for %s" % host)
    last = None
    for family, sockaddr in addrs:
        s = socket.socket(family, socket.SOCK_STREAM)
        s.settimeout(timeout)
        try:
            s.connect(sockaddr)
            return s
        except OSError as e:
            last = e
            s.close()
    raise last or OSError("connect failed")


def printable(b):
    """Client-supplied bytes as one printable line, so they cannot forge a log entry."""
    return "".join(chr(c) if 0x20 <= c <= 0x7E else "?" for c in b[:200])


class Handler(socketserver.BaseRequestHandler):
    def log(self, verdict, target):
        try:
            with open(self.server.log_path, "a") as f:
                f.write("%s %s %s\n" % (time.strftime("%H:%M:%SZ", time.gmtime()), verdict, target))
        except OSError:
            pass

    def refuse(self, target):
        self.log("DENY", target)
        try:
            self.request.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        except OSError:
            pass

    def handle(self):
        conn = self.request
        conn.settimeout(15)
        head = b""
        try:
            while b"\r\n\r\n" not in head:
                chunk = conn.recv(4096)
                if not chunk:
                    return
                head += chunk
                if len(head) > MAX_HEADER:
                    return self.refuse("<oversized request>")
        except OSError:
            return
        line = head.split(b"\r\n", 1)[0]
        host = connect_target(line, self.server.allow)
        if host is None:
            return self.refuse(printable(line))
        target = "%s:%d" % (host, PORT)
        try:
            upstream = dial(host)
        except OSError:
            self.log("FAIL", target)
            try:
                conn.sendall(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
            except OSError:
                pass
            return
        self.log("ALLOW", target)
        rest = head.split(b"\r\n\r\n", 1)[1]
        try:
            conn.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            if rest:
                upstream.sendall(rest)
            conn.settimeout(None)
            upstream.settimeout(None)
            socks = [conn, upstream]
            while True:
                readable, _, _ = select.select(socks, [], [], 600)
                if not readable:
                    break
                for s in readable:
                    data = s.recv(65536)
                    if not data:
                        return
                    (upstream if s is conn else conn).sendall(data)
        except OSError:
            pass
        finally:
            upstream.close()


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--allow", required=True, help="comma-separated exact hostnames")
    ap.add_argument("--port-file", required=True)
    ap.add_argument("--log", required=True)
    args = ap.parse_args()
    try:
        allow = parse_allowlist(args.allow)
    except ValueError as e:
        sys.exit("egress-proxy: %s" % e)
    srv = Server(("127.0.0.1", 0), Handler)
    srv.allow = allow
    srv.log_path = args.log
    tmp = args.port_file + ".tmp"
    with open(tmp, "w") as f:
        f.write("%d\n" % srv.server_address[1])
    os.replace(tmp, args.port_file)
    srv.serve_forever()


if __name__ == "__main__":
    main()
