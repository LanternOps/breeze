#!/usr/bin/env python3
"""Loopback auth-injecting forwarder for the scheduled QA sweep agent's model calls.

The agent never holds a credential. It talks plain HTTP to this forwarder on
127.0.0.1 (ANTHROPIC_BASE_URL) with a placeholder token; the forwarder, which
runs as the runner OUTSIDE the agent's sandbox, replaces the request's
credentials with the agent's claude.ai token and forwards the request over TLS
to api.anthropic.com through the egress proxy (CONNECT), so every byte still
leaves via the one audited route. The token reaches this process on stdin --
never argv or the environment, which other local processes can read -- and is
held only here.

It forwards the model API and nothing else:

  - only `POST /v1/messages` and `POST /v1/messages/count_tokens`, with no
    query or exactly `?beta=true`. Every other method or path (OAuth, account,
    API-key, file and admin endpoints a subscription token could otherwise
    reach) gets 403 without leaving the machine;
  - request headers are an allow-list (anthropic-*, content-type, accept,
    user-agent, x-app, x-stainless-*, x-claude-*); Authorization, x-api-key,
    cookies, proxy and hop-by-hop headers from the client are dropped and the
    forwarder's own Authorization is set;
  - the request body is bounded, read in full before anything is sent
    upstream, and must be a JSON object that cannot make the API itself reach
    out: no `mcp_servers` (MCP connector), no `container`, and every tool a
    plain client tool (no `type`, or `custom`) -- server tools such as
    web_fetch, web_search and code execution are refused -- and every content
    `source` object anywhere in it is inline (base64, text or content): a
    `url` source would have the API fetch that URL, a `file` source reads the
    Files API. So the model API is not an egress route around the sandbox;
  - the Host header must name this listener (127.0.0.1 or localhost and its
    port), so a web page reaching loopback by DNS rebinding is refused.

Each decision is logged one per line to a file the agent cannot read or write.

  model-forwarder.py --egress-port P --port-file F --log L < token

Python 3.9 stdlib only (the QA Mac's /usr/bin/python3).
"""
import argparse
import http.client
import json
import http.server
import os
import re
import socket
import socketserver
import ssl
import sys
import time

UPSTREAM = "api.anthropic.com"
ALLOWED_PATHS = ("/v1/messages", "/v1/messages/count_tokens")
ALLOWED_QUERIES = ("", "beta=true")
MAX_BODY = 64 * 1024 * 1024
OAUTH_BETA = "oauth-2025-04-20"
INLINE_SOURCES = ("base64", "text", "content")
# A string that is (after leading whitespace) an http(s) URL.
URL_VALUE = re.compile(r"\A\s*https?://", re.I)
# Content-block keys that name something for the API to fetch or open.
FETCH_KEYS = ("url", "file_id")
TOKEN_RE = re.compile(r"\Ask-ant-oat[0-9]{2}-[A-Za-z0-9_-]{20,500}\Z")
# Client headers worth forwarding. Anything else -- Authorization, x-api-key,
# Cookie, Proxy-*, Host, hop-by-hop, Content-Length -- is dropped.
HEADER_ALLOW = re.compile(r"\A(anthropic-[a-z0-9-]+|content-type|accept|accept-encoding|user-agent|x-app|"
                          r"x-stainless-[a-z0-9-]+|x-claude-[a-z0-9-]+)\Z")
HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
       "transfer-encoding", "upgrade", "content-length"}


def route_ok(method, target):
    """True only for a model-API request: POST, an allowed path, no or the beta query."""
    if method != "POST" or not isinstance(target, str):
        return False
    path, _, query = target.partition("?")
    return path in ALLOWED_PATHS and query in ALLOWED_QUERIES


def upstream_headers(items, token):
    """The headers sent upstream: the client's allow-listed ones plus our credentials."""
    out = []
    beta = []
    for k, v in items:
        lk = k.lower()
        if not HEADER_ALLOW.match(lk) or "\r" in v or "\n" in v:
            continue
        if lk == "anthropic-beta":
            beta.extend(b.strip() for b in v.split(",") if b.strip())
            continue
        out.append((lk, v))
    if OAUTH_BETA not in beta:
        beta.append(OAUTH_BETA)
    out.append(("anthropic-beta", ",".join(beta)))
    out.append(("authorization", "Bearer " + token))
    return out


def body_refusal(body):
    """None for a request body the forwarder may send, else why it may not."""
    try:
        req = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return "body is not JSON"
    if not isinstance(req, dict):
        return "body is not a JSON object"
    for key in ("mcp_servers", "container"):
        if key in req:
            return "body names %s" % key
    tools = req.get("tools", [])
    if not isinstance(tools, list):
        return "tools is not a list"
    for t in tools:
        if not isinstance(t, dict):
            return "a tool is not an object"
        kind = t.get("type", "custom")
        if kind != "custom":
            return "server tool %s" % str(kind)[:60]
    # Content blocks nest (tool_result -> document, system -> image ...): walk
    # the whole body, iteratively, and refuse any source that is not inline.
    stack = [req]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            src = node.get("source")
            if isinstance(src, dict) and src.get("type") not in INLINE_SOURCES:
                return "%s source" % str(src.get("type"))[:40]
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)
    # And, wherever a block or source sits in the messages or the system
    # prompt (2026-11-19): no `url` or `file_id` field at all, and no source
    # (dict or string) holding an http(s) URL, whatever its type says. Text
    # that mentions a URL is fine. A tool_use block's `input` is skipped: it is
    # the model's own call to one of the agent's tools (browser_navigate takes
    # a `url`), which the API does not act on.
    stack = [req.get("messages"), req.get("system")]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            for key, val in node.items():
                if key == "input" and node.get("type") in ("tool_use", "server_tool_use"):
                    continue
                if key in FETCH_KEYS and isinstance(val, str):
                    return "content names a %s" % key
                if key == "source":
                    vals = val.values() if isinstance(val, dict) else [val]
                    if any(isinstance(v, str) and URL_VALUE.match(v) for v in vals):
                        return "a source holds an http(s) URL"
                stack.append(val)
        elif isinstance(node, list):
            stack.extend(node)
    return None


def body_ok(body):
    return body_refusal(body) is None


def host_ok(host, port):
    """True only when the Host header names this loopback listener."""
    return host in ("127.0.0.1:%d" % port, "localhost:%d" % port)


def read_token(stream):
    """The agent token from stdin: one setup-token line, else ValueError."""
    data = stream.read(1024)
    lines = [ln for ln in data.splitlines() if ln.strip()]
    if len(lines) != 1 or not TOKEN_RE.match(lines[0].strip()):
        raise ValueError("stdin must hold exactly one claude setup-token token")
    return lines[0].strip()


def tls_context():
    ctx = ssl.create_default_context()
    if os.path.exists("/etc/ssl/cert.pem"):
        ctx.load_verify_locations("/etc/ssl/cert.pem")
    return ctx


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "qa-model-forwarder"
    sys_version = ""

    def log_message(self, *args):  # no stderr chatter; decisions go to the audit log
        pass

    def audit(self, verdict, detail):
        try:
            with open(self.server.log_path, "a") as f:
                f.write("%s %s %s\n" % (time.strftime("%H:%M:%SZ", time.gmtime()), verdict,
                                        "".join(c if 0x20 <= ord(c) <= 0x7E else "?" for c in detail[:200])))
        except OSError:
            pass

    def refuse(self, code, why):
        self.audit("DENY", "%s %s (%s)" % (self.command, self.path, why))
        body = b'{"type":"error","error":{"type":"forbidden","message":"qa-model-forwarder: refused"}}'
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def do_POST(self):
        if not route_ok(self.command, self.path):
            return self.refuse(403, "not a model API route")
        if not host_ok(self.headers.get("Host", ""), self.server.server_address[1]):
            return self.refuse(403, "foreign Host")
        if self.headers.get("Transfer-Encoding"):
            return self.refuse(411, "chunked body")
        try:
            n = int(self.headers.get("Content-Length", ""))
        except ValueError:
            return self.refuse(411, "no length")
        if n < 0 or n > MAX_BODY:
            return self.refuse(413, "body too large")
        body = self.rfile.read(n)
        if len(body) != n:
            return self.refuse(400, "short body")
        why = body_refusal(body)
        if why:
            return self.refuse(403, why)
        hdrs = upstream_headers(self.headers.items(), self.server.token)
        try:
            conn = http.client.HTTPSConnection("127.0.0.1", self.server.egress_port, timeout=600,
                                               context=self.server.tls)
            conn.set_tunnel(UPSTREAM, 443)
            conn.putrequest("POST", self.path, skip_host=True, skip_accept_encoding=True)
            conn.putheader("Host", UPSTREAM)
            for k, v in hdrs:
                conn.putheader(k, v)
            conn.putheader("Content-Length", str(len(body)))
            conn.endheaders(body)
            resp = conn.getresponse()
        except (OSError, http.client.HTTPException) as e:
            self.audit("FAIL", "%s (%s)" % (self.path, type(e).__name__))
            return self.refuse(502, "upstream unreachable")
        self.audit("ALLOW", "%s -> %d" % (self.path, resp.status))
        try:
            self.send_response(resp.status, resp.reason)
            for k, v in resp.getheaders():
                if k.lower() not in HOP:
                    self.send_header(k, v)
            # Close-delimited body: streamed (SSE) as it arrives, no re-chunking.
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            while True:
                chunk = resp.read1(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except OSError:
            pass
        finally:
            conn.close()

    def _refuse_other(self):
        self.refuse(403, "method")

    do_GET = do_PUT = do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = do_CONNECT = _refuse_other


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--egress-port", type=int, required=True)
    ap.add_argument("--port-file", required=True)
    ap.add_argument("--log", required=True)
    args = ap.parse_args()
    try:
        token = read_token(sys.stdin)
    except ValueError as e:
        sys.exit("model-forwarder: %s" % e)
    sys.stdin.close()
    srv = Server(("127.0.0.1", 0), Handler)
    srv.token = token
    srv.egress_port = args.egress_port
    srv.log_path = args.log
    srv.tls = tls_context()
    tmp = args.port_file + ".tmp"
    with open(tmp, "w") as f:
        f.write("%d\n" % srv.server_address[1])
    os.replace(tmp, args.port_file)
    srv.serve_forever()


if __name__ == "__main__":
    main()
