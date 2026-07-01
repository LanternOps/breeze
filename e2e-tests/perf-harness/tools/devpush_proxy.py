#!/usr/bin/env python3
"""Stable TCP proxy for dev-push: Tailscale IP:PORT -> local caddy front door.

Worktree stack ports are ephemeral (change on recreate). We pin a stable
Tailscale-facing port so PUBLIC_API_URL and each agent's server_url can be
fixed; only the --target is re-pointed when the stack recreates.

Threaded with proper half-close + SO_LINGER so large (~27MB) binary bodies
are not truncated (a naive relay closes both directions on first EOF ->
checksum mismatch on dev-push).
"""
import socket
import struct
import sys
import threading

import os

# No infra defaults committed (CLAUDE.md: no internal IPs in public code).
# Set via flags or env: --listen-host= / RD_PROXY_LISTEN_HOST (your Tailscale IP),
# --listen-port= / RD_PROXY_LISTEN_PORT, --target-port= (caddy front door).
LISTEN_HOST = os.environ.get("RD_PROXY_LISTEN_HOST", "")
LISTEN_PORT = int(os.environ.get("RD_PROXY_LISTEN_PORT", "41890"))
TARGET_HOST = "127.0.0.1"
TARGET_PORT = 0  # caddy front door (web + /api/v1); update on recreate

for a in sys.argv[1:]:
    if a.startswith("--target-port="):
        TARGET_PORT = int(a.split("=", 1)[1])
    elif a.startswith("--listen-port="):
        LISTEN_PORT = int(a.split("=", 1)[1])
    elif a.startswith("--listen-host="):
        LISTEN_HOST = a.split("=", 1)[1]

if not LISTEN_HOST or not TARGET_PORT:
    sys.exit("usage: devpush_proxy.py --listen-host=<tailscale-ip> --target-port=<caddy-port> [--listen-port=N]")


def pipe(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        # Half-close: signal EOF to dst but let the other direction finish.
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def handle(client):
    try:
        upstream = socket.create_connection((TARGET_HOST, TARGET_PORT))
    except OSError as e:
        client.close()
        print(f"upstream connect failed: {e}", flush=True)
        return
    # Linger so queued bytes flush before close (avoids truncation).
    linger = struct.pack("ii", 1, 5)
    for s in (client, upstream):
        s.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, linger)
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    t1 = threading.Thread(target=pipe, args=(client, upstream), daemon=True)
    t2 = threading.Thread(target=pipe, args=(upstream, client), daemon=True)
    t1.start(); t2.start()
    t1.join(); t2.join()
    client.close(); upstream.close()


def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((LISTEN_HOST, LISTEN_PORT))
    srv.listen(64)
    print(f"devpush proxy: {LISTEN_HOST}:{LISTEN_PORT} -> {TARGET_HOST}:{TARGET_PORT}", flush=True)
    while True:
        client, addr = srv.accept()
        threading.Thread(target=handle, args=(client,), daemon=True).start()


if __name__ == "__main__":
    main()
