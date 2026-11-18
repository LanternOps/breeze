#!/usr/bin/env python3
"""CONNECT-only egress proxy for the scheduled QA sweep agent.

The agent's process tree runs under a Seatbelt profile (qa-sandbox.sb) that
allows outbound connections to loopback only, so this proxy is its only route
off the machine. It tunnels CONNECT requests to port 443 of hosts on a fixed
allowlist (set by the runner before the agent starts) and refuses everything
else: other methods, other ports, IP literals, and unlisted hosts. Denials are
logged one per line so a run's egress attempts can be audited.

  egress-proxy.py --allow api.anthropic.com,.claude.ai --port-file F --log L

An entry starting with "." matches that domain and its subdomains. Python 3.9
stdlib only (the QA Mac's /usr/bin/python3).
"""
import argparse
import ipaddress
import os
import select
import socket
import socketserver
import sys
import time

MAX_HEADER = 16384


def host_allowed(host, allow):
    host = host.lower().rstrip(".")
    if not host:
        return False
    try:
        ipaddress.ip_address(host.strip("[]"))
        return False  # IP literals bypass the name allowlist
    except ValueError:
        pass
    for entry in allow:
        if entry.startswith("."):
            if host == entry[1:] or host.endswith(entry):
                return True
        elif host == entry:
            return True
    return False


def parse_connect(head):
    """Return (host, port) for a CONNECT request line, else None."""
    try:
        line = head.split(b"\r\n", 1)[0].decode("ascii")
    except UnicodeDecodeError:
        return None
    parts = line.split(" ")
    if len(parts) != 3 or parts[0] != "CONNECT" or not parts[2].startswith("HTTP/1."):
        return None
    target = parts[1]
    if target.startswith("["):
        return None  # IPv6 literal
    host, sep, port = target.rpartition(":")
    if not sep or not port.isdigit():
        return None
    return host, int(port)


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
        parsed = parse_connect(head)
        if parsed is None:
            first = head.split(b"\r\n", 1)[0][:120].decode("ascii", "replace")
            return self.refuse(repr(first))
        host, port = parsed
        target = "%s:%d" % (host, port)
        if port != 443 or not host_allowed(host, self.server.allow):
            return self.refuse(target)
        try:
            upstream = socket.create_connection((host, port), timeout=15)
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
    ap.add_argument("--allow", required=True, help="comma-separated hosts; leading '.' = domain + subdomains")
    ap.add_argument("--port-file", required=True)
    ap.add_argument("--log", required=True)
    args = ap.parse_args()
    allow = [h.strip().lower() for h in args.allow.split(",") if h.strip()]
    if not allow:
        sys.exit("empty allowlist")
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
