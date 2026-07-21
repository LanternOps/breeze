# Network Proxy — Agent HTTP-Fetch Reverse Proxy + Asset-Modal UX Rework

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Network Proxy feature actually connect — let an operator view a discovered device's HTTP/HTTPS web UI (e.g. a printer admin page) in the browser through a managed agent — and clean up the confusing discovery asset-modal UX around linking vs. proxying.

**Architecture:** The current `ProxyTunnelPage` never opens the relay WebSocket, so tunnels never activate (confirmed: 0 of 7 US tunnels ever reached `active`, fleet-wide, all-time). Rather than bludgeon the single-consumer raw-TCP relay into an HTTP proxy, add a new agent capability: an `http_request` command where the **agent performs the HTTP/HTTPS fetch to the target locally** (Go handles self-signed TLS and concurrency cleanly) and returns the response. The API exposes an authenticated reverse-proxy route (`/api/v1/tunnel-http/:tunnelId/*`) that issues `http_request` commands and streams responses into an iframe. This reuses the existing tunnel-session record, allowlist/SSRF guards, and remote-access policy.

**Tech Stack:** Go (agent: `net/http`, `crypto/tls`), Hono + TypeScript (API), Drizzle ORM, Astro + React (web), Vitest (API/web), Go `testing` (agent).

## Global Constraints

- **Agent version:** new capability requires an agent release. Bump per repo convention; bare semver (no `v` prefix) in code/config; `v` prefix only on git tags. After release, promote on US per region (platformAdmin + MFA; `AGENT_AUTO_PROMOTE=false`).
- **Tenant isolation:** every new DB access on the request path uses `withDbAccessContext`; background/await-result paths use `withSystemDbAccessContext` (RLS forced; bare pool forbidden in request code).
- **SSRF / target safety:** the proxy target is fixed by the `tunnel_sessions` row (`targetHost`/`targetPort`) — never attacker-supplied per request. Reuse existing blocked-CIDR (`127.0.0.0/8` except `127.0.0.1:5900` VNC; `169.254.0.0/16`) and the org destination allowlist (`tunnelAllowlists`). Agent re-validates (defense-in-depth) exactly like `tunnel_open`.
- **Auth:** API auth middleware is **Bearer-token only** (`apps/api/src/middleware/auth.ts:296`). Browser iframe navigations carry no Authorization header, so use a one-time ticket in the iframe URL that the route exchanges for a short-lived **HttpOnly cookie scoped to `/api/v1/tunnel-http/<tunnelId>/`** for sub-resource requests.
- **Frequent commits, TDD, DRY, YAGNI.** UI work stays in-session on Opus (per team convention), backend may be delegated.
- **Security review (`security-review` skill) is mandatory before merge** — this is an authenticated proxy to internal IPs.

---

## File Structure

| File | Responsibility |
|---|---|
| `agent/internal/tunnel/httpfetch.go` (create) | One-shot HTTP/HTTPS fetch to a target with self-signed support, size/time caps, header filtering. |
| `agent/internal/tunnel/httpfetch_test.go` (create) | Table-driven tests against `httptest` (HTTP + TLS) servers. |
| `agent/internal/heartbeat/handlers_httpproxy.go` (create) | `CmdHttpRequest` handler: blocked/allowlist re-check → call `httpfetch` → return result. |
| `agent/internal/heartbeat/handlers_httpproxy_test.go` (create) | Handler tests (blocked target, allowlist deny, success). |
| `agent/internal/heartbeat/handlers_tunnel.go:19-23` (modify) | Register `CmdHttpRequest` in the handler registry. |
| `apps/api/src/routes/agentWs.ts` (modify) | Add `http_request` to result dispatch; add pending-promise map + `sendCommandToAgentAwaitResult`. |
| `apps/api/src/services/agentCommandAwait.ts` (create) | Promise-correlated send-and-await-result helper + result resolver. |
| `apps/api/src/routes/tunnelHttp.ts` (create) | `ALL /:tunnelId/*` reverse-proxy route: ticket↔cookie auth, ownership/policy/online checks, build `http_request`, rewrite + stream response. |
| `apps/api/src/routes/tunnelHttp.test.ts` (create) | Route tests: auth, ownership, rewrite, error mapping. |
| `apps/api/src/routes/tunnels.ts` (modify) | Add `POST /tunnels/:id/http-ticket` (mint ticket for the http proxy). |
| `apps/api/src/index.ts:796` (modify) | Mount `api.route('/tunnel-http', tunnelHttpRoutes)`. |
| `apps/web/src/components/remote/ProxyTunnelPage.tsx` (modify) | Replace the dead "relay URL" box with an iframe to `/api/v1/tunnel-http/:id/` (+ "Open in new tab"); drive status from tunnel + iframe load. |
| `apps/web/src/components/discovery/AssetDetailModal.tsx` (modify) | UX rework: separate "Link (asset tracking)" from a "Remote Proxy" group with its own **bridge-agent picker** (online-only, defaults to discovering agent), clearer copy. |
| `apps/web/src/components/discovery/DiscoveredAssetList.tsx` (modify) | Include device `status` in the `devices` list; pass discovering-device hint to the modal. (modal-close fix already applied.) |

---

## Task 1: Agent — one-shot HTTP/HTTPS fetch (`httpfetch.go`)

**Files:**
- Create: `agent/internal/tunnel/httpfetch.go`
- Test: `agent/internal/tunnel/httpfetch_test.go`

**Interfaces:**
- Produces:
  ```go
  // FetchRequest is one proxied HTTP request to a LAN target.
  type FetchRequest struct {
      Scheme  string              // "http" | "https" (derived from target port / explicit)
      Host    string              // target IP/host
      Port    int                 // target port
      Method  string              // GET/POST/...
      Path    string              // path + raw query, e.g. "/admin/index.html?x=1"
      Headers map[string][]string // forwarded request headers (already filtered by caller)
      Body    []byte              // request body (may be nil)
  }
  type FetchResponse struct {
      Status  int
      Headers map[string][]string
      Body    []byte              // capped; truncated flag set if exceeded
      Truncated bool
  }
  // Fetch performs the request. timeout caps total time; maxBody caps response bytes.
  func Fetch(ctx context.Context, req FetchRequest, timeout time.Duration, maxBody int64) (*FetchResponse, error)
  ```
- Consumes: nothing from prior tasks.

- [ ] **Step 1: Write the failing test** (`httpfetch_test.go`)

```go
package tunnel

import (
	"context"
	"crypto/tls"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestFetch(t *testing.T) {
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/echo" && r.Method == http.MethodPost {
			b, _ := io.ReadAll(r.Body)
			w.Header().Set("X-Seen", "yes")
			w.WriteHeader(201)
			w.Write([]byte("got:" + string(b)))
			return
		}
		w.Write([]byte("hello-plain"))
	}))
	defer plain.Close()

	tlsSrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("hello-tls"))
	}))
	defer tlsSrv.Close()

	hostPort := func(u string) (string, int) {
		u = strings.TrimPrefix(strings.TrimPrefix(u, "http://"), "https://")
		parts := strings.SplitN(u, ":", 2)
		var p int
		_, _ = fmtSscan(parts[1], &p)
		return parts[0], p
	}

	t.Run("plain GET", func(t *testing.T) {
		h, p := hostPort(plain.URL)
		resp, err := Fetch(context.Background(), FetchRequest{Scheme: "http", Host: h, Port: p, Method: "GET", Path: "/"}, 5*time.Second, 1<<20)
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != 200 || string(resp.Body) != "hello-plain" {
			t.Fatalf("got %d %q", resp.Status, resp.Body)
		}
	})

	t.Run("POST body + headers", func(t *testing.T) {
		h, p := hostPort(plain.URL)
		resp, err := Fetch(context.Background(), FetchRequest{Scheme: "http", Host: h, Port: p, Method: "POST", Path: "/echo", Body: []byte("ping")}, 5*time.Second, 1<<20)
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != 201 || string(resp.Body) != "got:ping" || resp.Headers["X-Seen"][0] != "yes" {
			t.Fatalf("got %d %q %v", resp.Status, resp.Body, resp.Headers)
		}
	})

	t.Run("self-signed TLS accepted", func(t *testing.T) {
		h, p := hostPort(tlsSrv.URL)
		resp, err := Fetch(context.Background(), FetchRequest{Scheme: "https", Host: h, Port: p, Method: "GET", Path: "/"}, 5*time.Second, 1<<20)
		if err != nil {
			t.Fatal(err)
		}
		if string(resp.Body) != "hello-tls" {
			t.Fatalf("got %q", resp.Body)
		}
		_ = tls.VersionTLS12
	})

	t.Run("body cap truncates", func(t *testing.T) {
		h, p := hostPort(plain.URL)
		resp, err := Fetch(context.Background(), FetchRequest{Scheme: "http", Host: h, Port: p, Method: "GET", Path: "/"}, 5*time.Second, 4)
		if err != nil {
			t.Fatal(err)
		}
		if !resp.Truncated || len(resp.Body) != 4 {
			t.Fatalf("expected truncated 4 bytes, got %d trunc=%v", len(resp.Body), resp.Truncated)
		}
	})
}
```

> Note: add a tiny `fmtSscan` shim or replace with `strconv.Atoi`/`fmt.Sscan` directly — the helper above is illustrative; use `strconv.Atoi(parts[1])` in the real test.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/tunnel/ -run TestFetch -v`
Expected: FAIL (`undefined: Fetch`).

- [ ] **Step 3: Write minimal implementation** (`httpfetch.go`)

```go
package tunnel

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"
)

type FetchRequest struct {
	Scheme  string
	Host    string
	Port    int
	Method  string
	Path    string
	Headers map[string][]string
	Body    []byte
}

type FetchResponse struct {
	Status    int
	Headers   map[string][]string
	Body      []byte
	Truncated bool
}

// hop-by-hop headers we never forward in either direction.
var hopByHop = map[string]bool{
	"connection": true, "keep-alive": true, "proxy-authenticate": true,
	"proxy-authorization": true, "te": true, "trailer": true,
	"transfer-encoding": true, "upgrade": true,
}

func Fetch(ctx context.Context, req FetchRequest, timeout time.Duration, maxBody int64) (*FetchResponse, error) {
	scheme := req.Scheme
	if scheme == "" {
		if req.Port == 443 {
			scheme = "https"
		} else {
			scheme = "http"
		}
	}
	url := fmt.Sprintf("%s://%s%s", scheme, net.JoinHostPort(req.Host, fmt.Sprintf("%d", req.Port)), req.Path)

	var bodyReader io.Reader
	if len(req.Body) > 0 {
		bodyReader = newByteReader(req.Body)
	}
	hreq, err := http.NewRequestWithContext(ctx, req.Method, url, bodyReader)
	if err != nil {
		return nil, err
	}
	for k, vs := range req.Headers {
		if hopByHop[lower(k)] {
			continue
		}
		for _, v := range vs {
			hreq.Header.Add(k, v)
		}
	}

	client := &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			// Self-signed printer/device certs are the norm on a LAN. The tunnel
			// target is already constrained to the tunnel_session's host:port and
			// re-checked against the org allowlist, so cert pinning adds no security
			// here while breaking every real device. Skip verification deliberately.
			TLSClientConfig:   &tls.Config{InsecureSkipVerify: true}, //nolint:gosec
			DisableKeepAlives: true,
			Proxy:             nil,
		},
		// Do not auto-follow redirects — the API layer rewrites Location.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}

	resp, err := client.Do(hreq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	limited := io.LimitReader(resp.Body, maxBody+1)
	b, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	truncated := int64(len(b)) > maxBody
	if truncated {
		b = b[:maxBody]
	}

	outHeaders := map[string][]string{}
	for k, vs := range resp.Header {
		if hopByHop[lower(k)] {
			continue
		}
		outHeaders[k] = vs
	}
	return &FetchResponse{Status: resp.StatusCode, Headers: outHeaders, Body: b, Truncated: truncated}, nil
}

func lower(s string) string { return string([]byte(toLowerASCII(s))) }
```

> Add small helpers `toLowerASCII`, `newByteReader` (wrap `bytes.NewReader`). Prefer `bytes.NewReader`/`strings.ToLower` directly — the named helpers above are only to keep the snippet self-contained; use stdlib in the real implementation.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agent && go test -race ./internal/tunnel/ -run TestFetch -v`
Expected: PASS (all subtests).

- [ ] **Step 5: Commit**

```bash
git add agent/internal/tunnel/httpfetch.go agent/internal/tunnel/httpfetch_test.go
git commit -m "feat(agent): one-shot HTTP/HTTPS fetch for tunnel http-proxy"
```

---

## Task 2: Agent — `http_request` command handler

**Files:**
- Create: `agent/internal/heartbeat/handlers_httpproxy.go`
- Test: `agent/internal/heartbeat/handlers_httpproxy_test.go`
- Modify: `agent/internal/heartbeat/handlers_tunnel.go:19-23` (registry)

**Interfaces:**
- Consumes: `tunnel.Fetch` (Task 1); existing `tunnel.IsBlocked(host, port, isVNC)` (`agent/internal/tunnel/allowlist.go:114`), `tunnel.IsAllowed(host, port, rules)` (`allowlist.go:145`).
- Produces: handler registered under command type `"http_request"` returning a result payload:
  ```jsonc
  // command result payload (status:"completed")
  { "status": 200, "headers": {"Content-Type":["text/html"]}, "bodyB64": "...", "truncated": false }
  // on rejection: Status "failed", error "blocked target" | "not allowed" | dial/timeout message
  ```

- [ ] **Step 1: Write the failing test** — assert (a) blocked target → failed, (b) empty allowlist → failed, (c) allowed → completed with decoded body. Mirror the structure of the existing `handlers_tunnel.go` tests; use an `httptest` server as the target and pass its host/port + an allowlist rule covering it.

- [ ] **Step 2: Run** `cd agent && go test ./internal/heartbeat/ -run TestHandleHttpRequest -v` → FAIL.

- [ ] **Step 3: Implement** `handleHttpRequest`:

```go
package heartbeat

import (
	"context"
	"encoding/base64"
	"time"

	"github.com/<org>/breeze/agent/internal/tunnel" // match existing import path
)

const CmdHttpRequest = "http_request"

const (
	httpProxyTimeout = 20 * time.Second
	httpProxyMaxBody = 16 << 20 // 16 MiB
)

func (h *Handler) handleHttpRequest(cmd Command) CommandResult {
	host, _ := cmd.Payload["targetHost"].(string)
	port := toInt(cmd.Payload["targetPort"])
	scheme, _ := cmd.Payload["scheme"].(string)
	method, _ := cmd.Payload["method"].(string)
	path, _ := cmd.Payload["path"].(string)
	headers := toHeaderMap(cmd.Payload["headers"])
	var body []byte
	if b64, ok := cmd.Payload["bodyB64"].(string); ok && b64 != "" {
		body, _ = base64.StdEncoding.DecodeString(b64)
	}

	// Defense-in-depth: re-apply the same guards as tunnel_open.
	if tunnel.IsBlocked(host, port, false) {
		return failed(cmd, "blocked target")
	}
	rules := parseAllowlistRules(cmd.Payload["allowlistRules"]) // reuse helper from handlers_tunnel.go
	if !tunnel.IsAllowed(host, port, rules) {
		return failed(cmd, "target not allowed")
	}

	ctx, cancel := context.WithTimeout(context.Background(), httpProxyTimeout)
	defer cancel()
	resp, err := tunnel.Fetch(ctx, tunnel.FetchRequest{
		Scheme: scheme, Host: host, Port: port, Method: method, Path: path, Headers: headers, Body: body,
	}, httpProxyTimeout, httpProxyMaxBody)
	if err != nil {
		return failed(cmd, err.Error())
	}
	return completed(cmd, map[string]any{
		"status":    resp.Status,
		"headers":   resp.Headers,
		"bodyB64":   base64.StdEncoding.EncodeToString(resp.Body),
		"truncated": resp.Truncated,
	})
}
```

> `failed`/`completed`/`toInt`/`toHeaderMap`/`parseAllowlistRules` — reuse or mirror the helpers already in `handlers_tunnel.go`. Register in the registry map (`handlers_tunnel.go:19-23`): `CmdHttpRequest: h.handleHttpRequest`.

- [ ] **Step 4: Run** `cd agent && go test -race ./internal/heartbeat/ -run TestHandleHttpRequest -v` → PASS.

- [ ] **Step 5: Commit** `feat(agent): http_request command handler for network proxy`.

---

## Task 3: API — send-command-and-await-result helper

**Files:**
- Create: `apps/api/src/services/agentCommandAwait.ts`
- Test: `apps/api/src/services/agentCommandAwait.test.ts`
- Modify: `apps/api/src/routes/agentWs.ts` (call the resolver from result dispatch)

**Interfaces:**
- Consumes: `sendCommandToAgent(agentId, command)` (`agentWs.ts:2500`), the `commandResultSchema` shape (`agentWs.ts:571`).
- Produces:
  ```ts
  export function sendCommandToAgentAwaitResult(
    agentId: string,
    command: { id: string; type: string; payload: Record<string, unknown> },
    timeoutMs: number,
  ): Promise<{ status: string; result?: unknown; error?: string }>;
  export function resolvePendingAgentCommand(commandId: string, result: { status: string; result?: unknown; error?: string }): void;
  ```

- [ ] **Step 1: Write the failing test** — `sendCommandToAgentAwaitResult` rejects on timeout; resolves when `resolvePendingAgentCommand(id, …)` is called with the matching id; returns `{status:'failed'}` if `sendCommandToAgent` returns false (agent offline). Mock `sendCommandToAgent`.

- [ ] **Step 2: Run** `cd apps/api && pnpm exec vitest run src/services/agentCommandAwait.test.ts` → FAIL.

- [ ] **Step 3: Implement** a `Map<string, {resolve, reject, timer}>` keyed by `command.id`; `sendCommandToAgentAwaitResult` registers the entry, calls `sendCommandToAgent` (resolve `{status:'failed', error:'agent offline'}` if false), arms a timeout that rejects/cleans up; `resolvePendingAgentCommand` looks up the id, clears the timer, resolves, deletes.

- [ ] **Step 4:** Wire into `agentWs.ts`: in `processCommandResult`, before/after the existing dispatch, call `resolvePendingAgentCommand(result.commandId, { status: result.status, result: result.result, error: result.error })` so awaited commands resolve. (Add `http_request` is fire-via-await, so it does **not** need a persist handler in `commandResultHandlers` — the resolver path is enough; ensure unknown types still hit the resolver.)

- [ ] **Step 5:** Run tests → PASS. Commit `feat(api): promise-correlated agent command await helper`.

---

## Task 4: API — `POST /tunnels/:id/http-ticket`

**Files:**
- Modify: `apps/api/src/routes/tunnels.ts` (new route near `ws-ticket`, lines ~762-817)
- Modify: `apps/api/src/services/remoteSessionAuth.ts` (allow a longer TTL for http tickets; see below)
- Test: extend `apps/api/src/routes/tunnels.test.ts`

**Interfaces:**
- Consumes: `createWsTicket({sessionId, sessionType, userId, ip, userAgent})` (`remoteSessionAuth.ts`), `WS_TICKET_TTL_MS` (`remoteSessionAuth.ts:7`).
- Produces: `POST /tunnels/:id/http-ticket` → `{ ticket: string }`. Mint with `sessionType: 'tunnel-http'`.

- [ ] **Step 1: Write the failing test** — authed owner gets `{ ticket }`; non-owner gets 404/403; mint uses `sessionType:'tunnel-http'`.
- [ ] **Step 2:** Run the test → FAIL.
- [ ] **Step 3:** Implement: copy the `ws-ticket` handler, change `sessionType` to `'tunnel-http'`. **TTL:** the existing 60s is too tight for an interactive page (the agent also idle-closed at ~60s, but that idle reaper does not apply here — there's no long-lived tunnel; each request is a fresh `http_request`). Add a separate constant `HTTP_TICKET_TTL_MS = 5 * 60 * 1000` and thread a per-type TTL into `createWsTicket` (default keeps 60s for `tunnel`/`vnc`). Update `consumeWsTicket`/`createWsTicket` to accept/apply per-type TTL.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(api): http-ticket minting for network proxy`.

---

## Task 5: API — reverse-proxy route `tunnelHttp.ts`

**Files:**
- Create: `apps/api/src/routes/tunnelHttp.ts`
- Test: `apps/api/src/routes/tunnelHttp.test.ts`
- Modify: `apps/api/src/index.ts:796` (mount), near the other tunnel routes.

**Interfaces:**
- Consumes: `validateTunnelAccess`-style checks (reuse the ownership/online/policy logic — extract a shared `assertTunnelUsable(tunnelId, userId)` if convenient, or replicate the session+device+policy lookups from `tunnelWs.ts:159-243`), `consumeWsTicket` (one-time, sessionType `'tunnel-http'`), `sendCommandToAgentAwaitResult` (Task 3), `getActiveAllowlistPatterns(orgId)` (`tunnels.ts:286`), `isAgentConnected` (`agentWs.ts:2546`).
- Produces: `tunnelHttpRoutes` (Hono). Routes:
  - `GET|POST|PUT|... /:tunnelId/*` — the proxy.
  - Mounted at `/api/v1/tunnel-http`.

**Auth model (no Bearer on iframe navigations):**
1. First request carries `?__bzt=<ticket>`. Route consumes the one-time ticket, verifies it matches `:tunnelId` + sessionType `tunnel-http`, loads the session, checks owner + device online + remote-access policy.
2. Route mints a short-lived signed cookie `bz_tunnel_<tunnelId>` (HttpOnly, Secure, SameSite=Lax, `Path=/api/v1/tunnel-http/<tunnelId>/`, ~5 min) carrying `{userId, tunnelId, exp}` (sign with the existing JWT/secret util). Redirect (302) to the same URL **without** the `__bzt` query so the ticket isn't re-used/leaked in referrers.
3. Subsequent sub-resource requests authenticate via the cookie. Each request re-checks owner+online+policy (cheap) before dispatching.

> This route is **NOT** behind the global Bearer `authMiddleware` — like `tunnel-ws`, it self-authenticates (ticket then cookie). Mount it the same way (`// no auth middleware — ticket/cookie self-auth`).

- [ ] **Step 1: Write the failing tests** (`tunnelHttp.test.ts`):
  - missing/invalid ticket and no cookie → 401.
  - valid ticket → 302 setting `bz_tunnel_<id>` cookie, Location strips `__bzt`.
  - with valid cookie: dispatches `http_request` with the right `targetHost`/`targetPort`/`scheme` (from session; scheme `https` when port 443 else `http`), method, path (`/*` + query), filtered headers; returns agent status/body; sets response content-type from agent headers.
  - agent offline → 502; agent timeout → 504; session not owned → 404.
  - HTML rewriting: a `<head>` response gets a `<base href="/api/v1/tunnel-http/<id>/">` injected; a 3xx `Location: http://<target>/foo` is rewritten to `/api/v1/tunnel-http/<id>/foo`.

- [ ] **Step 2:** Run `cd apps/api && pnpm exec vitest run src/routes/tunnelHttp.test.ts` → FAIL.

- [ ] **Step 3: Implement** the route. Sketch:

```ts
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
// reuse: consumeWsTicket, session/device/policy lookups, sendCommandToAgentAwaitResult,
// getActiveAllowlistPatterns, isAgentConnected, getTrustedClientIp, signTunnelCookie/verifyTunnelCookie

export const tunnelHttpRoutes = new Hono();

const HTTP_REQUEST_TIMEOUT_MS = 25_000;
const HOP_BY_HOP = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','host']);

tunnelHttpRoutes.all('/:tunnelId/*', async (c) => {
  const tunnelId = c.req.param('tunnelId');
  const basePath = `/api/v1/tunnel-http/${tunnelId}/`;

  // 1. Authn: cookie first, else one-time ticket → set cookie → redirect.
  let userId = await verifyTunnelCookie(getCookie(c, `bz_tunnel_${tunnelId}`), tunnelId);
  if (!userId) {
    const ticket = c.req.query('__bzt');
    const consumed = ticket ? await consumeWsTicket(ticket) : null;
    if (!consumed || consumed.sessionId !== tunnelId || consumed.sessionType !== 'tunnel-http') {
      return c.text('Unauthorized', 401);
    }
    userId = consumed.userId;
    setCookie(c, `bz_tunnel_${tunnelId}`, await signTunnelCookie(userId, tunnelId), {
      httpOnly: true, secure: true, sameSite: 'Lax', path: basePath, maxAge: 300,
    });
    const url = new URL(c.req.url);
    url.searchParams.delete('__bzt');
    return c.redirect(url.pathname + url.search, 302);
  }

  // 2. Authz: owner + device online + policy (fail-closed). Reuse the tunnelWs checks.
  const session = await loadOwnedTunnelSession(tunnelId, userId); // {agentId, targetHost, targetPort, type, orgId, deviceStatus}
  if (!session) return c.text('Not found', 404);
  if (session.deviceStatus !== 'online' || !isAgentConnected(session.agentId)) return c.text('Bridge agent offline', 502);
  // (remote-access policy re-check here)

  // 3. Build + dispatch http_request.
  const wildcard = c.req.path.slice(basePath.length); // path after base
  const qs = new URL(c.req.url).search;
  const headers: Record<string,string[]> = {};
  for (const [k,v] of Object.entries(c.req.header())) if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = [v as string];
  const bodyBuf = ['GET','HEAD'].includes(c.req.method) ? undefined : Buffer.from(await c.req.arrayBuffer());
  const scheme = session.targetPort === 443 ? 'https' : 'http';

  const res = await sendCommandToAgentAwaitResult(session.agentId, {
    id: `http-req-${tunnelId}-${cryptoRandomId()}`,
    type: 'http_request',
    payload: {
      tunnelId, targetHost: session.targetHost, targetPort: session.targetPort, scheme,
      method: c.req.method, path: '/' + wildcard + qs,
      headers, bodyB64: bodyBuf ? bodyBuf.toString('base64') : '',
      allowlistRules: await getActiveAllowlistPatterns(session.orgId),
    },
  }, HTTP_REQUEST_TIMEOUT_MS).catch(() => null);

  if (!res) return c.text('Upstream timeout', 504);
  if (res.status === 'failed') return c.text(`Proxy error: ${res.error ?? 'unknown'}`, 502);

  // 4. Rewrite + return.
  const r = res.result as { status: number; headers: Record<string,string[]>; bodyB64: string };
  let body: Buffer | string = Buffer.from(r.bodyB64, 'base64');
  const ctype = (r.headers['Content-Type']?.[0] ?? r.headers['content-type']?.[0] ?? '').toLowerCase();
  const respHeaders = new Headers();
  for (const [k,vs] of Object.entries(r.headers)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || lk === 'content-length' || lk === 'content-security-policy') continue;
    if (lk === 'location') { respHeaders.set(k, rewriteLocation(vs[0], session, basePath)); continue; }
    if (lk === 'set-cookie') { for (const v of vs) respHeaders.append('set-cookie', scopeCookiePath(v, basePath)); continue; }
    for (const v of vs) respHeaders.append(k, v);
  }
  if (ctype.includes('text/html')) {
    body = injectBaseTag(body.toString('utf8'), basePath); // insert <base href="basePath"> after <head>
    respHeaders.set('content-type', ctype || 'text/html');
  }
  return new Response(body, { status: r.status, headers: respHeaders });
});
```

> Helpers to implement in-file: `loadOwnedTunnelSession`, `signTunnelCookie`/`verifyTunnelCookie` (HMAC with existing secret), `rewriteLocation`, `scopeCookiePath`, `injectBaseTag`, `cryptoRandomId`. Strip upstream CSP so the framed page renders. `<base>` injection handles most relative-URL printer UIs; document absolute-URL/JS-built-URL limitations as known gaps.

- [ ] **Step 4:** Run tests → PASS.
- [ ] **Step 5:** Mount in `index.ts:796`: `api.route('/tunnel-http', tunnelHttpRoutes); // ticket/cookie self-auth`. Commit `feat(api): http reverse-proxy route for network proxy`.

---

## Task 6: Web — `ProxyTunnelPage` renders the service in an iframe

**Files:**
- Modify: `apps/web/src/components/remote/ProxyTunnelPage.tsx`
- Test: `apps/web/src/components/remote/ProxyTunnelPage.test.tsx` (create if absent)

- [ ] **Step 1: Write failing test** — on mount, the page POSTs `/tunnels/:id/http-ticket`, then renders an `<iframe>` whose `src` is `/api/v1/tunnel-http/:id/?__bzt=<ticket>`; shows a "Open in new tab" link to the same; status badge reads `active` once the iframe `onLoad` fires (or tunnel status poll returns non-pending). Failure (ticket error) shows the error box.

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3: Implement** — replace the "WebSocket Relay URL" block (lines 161-181) with:
  - Mint an http-ticket (reuse the existing mint effect, change endpoint to `/tunnels/:id/http-ticket`).
  - `const proxyUrl = `/api/v1/tunnel-http/${tunnelId}/?__bzt=${encodeURIComponent(ticket)}``.
  - Render `<iframe src={proxyUrl} className="h-[70vh] w-full rounded-md border" title="Proxied service" onLoad={() => setStatus('active')} />` plus an "Open in new tab" anchor (`target="_blank" rel="noreferrer"`).
  - Keep the status poll for `failed`/`disconnected`. Remove the copy-URL affordance.

- [ ] **Step 4:** Run web tests → PASS.
- [ ] **Step 5:** Commit `feat(web): render network proxy target in iframe`.

---

## Task 7: Web — Asset modal UX rework (decouple link vs. proxy; online-only bridge picker)

**Files:**
- Modify: `apps/web/src/components/discovery/AssetDetailModal.tsx`
- Modify: `apps/web/src/components/discovery/DiscoveredAssetList.tsx` (devices need `status`; pass discovering-device hint)
- Test: extend `apps/web/src/components/discovery/AssetDetailModal.test.tsx`

**Design (approved):**
- "Link to managed device" stays = **asset tracking / identity only**. Copy clarified: "Identity only — links this asset to a managed device for inventory/asset tracking. Does not affect proxy access."
- New **"Remote Proxy"** group combines: Enable Proxy Access (the allowlist whitelist — clarify copy: "Whitelists this device's IP so an agent may tunnel to it") **and** a **bridge-agent picker** (which agent does the dialing) that is **independent of the identity link**.
- Bridge-agent picker: lists **online devices only**, defaults to the discovering agent (asset's `lastJobId.agentId` → device), else the linked device, else first online. `Connect` uses the picker's deviceId (not `asset.linkedDeviceId`).
- If no online device can bridge: show "No online agent available to proxy to this device" instead of a dead Connect.

- [ ] **Step 1:** In `DiscoveredAssetList.tsx:319`, include status: `setDevices(raw.map(d => ({ id: d.id, name: d.displayName||d.hostname||d.id, online: d.status === 'online' })))`. Update the `devices` prop type in `AssetDetailModal` to `{id; name; online?: boolean}[]`. Pass a `discoveringDeviceId?` hint if available from the asset payload (map from `lastJobId`/scan agent → device; if not exposed, default to linked/first-online and note as a follow-up).
- [ ] **Step 2: Write failing test** — bridge picker shows only `online` devices; defaults appropriately; `Connect` POSTs `/tunnels` with the picker's deviceId; offline-only fleet shows the "no online agent" message; Link copy no longer implies proxy.
- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4: Implement** the restructured right column: separate `<Link>` card (identity copy) and `<RemoteProxy>` card (enable + bridge-agent `<select>` filtered to `devices.filter(d=>d.online)` + Connect using `selectedBridgeDeviceId`). Update `handleConnectProxy` to use `selectedBridgeDeviceId`.
- [ ] **Step 5:** Run all discovery web tests → PASS. Commit `feat(web): decouple asset linking from proxy bridge; online-only bridge picker`.

---

## Task 8: Security review, integration verification, release

- [ ] **Step 1: Security review** — run the `security-review` skill against the branch. Focus: ticket→cookie auth can't be forged/replayed; cookie is path-scoped + HMAC-signed + short TTL; proxy can only ever reach the session's fixed `targetHost:targetPort` (no per-request host override); allowlist + blocked-CIDR enforced on **both** API and agent; per-request authz re-check is fail-closed; tenant isolation on all session lookups (`withDbAccessContext`); rate-limit the proxy route per user.
- [ ] **Step 2: Integration test** — add an API integration test (`__tests__/integration/*.integration.test.ts`) exercising mint-ticket → proxy GET through a stubbed agent (assert the `http_request` command shape + response relay). Run with `--config vitest.integration.config.ts`.
- [ ] **Step 3: Agent race + full suites** — `cd agent && go test -race ./...`; `pnpm test --filter=@breeze/api`; web discovery + remote tests.
- [ ] **Step 4: Release** — bump agent version, build, tag off `main` (full release), register on US, **promote per region** (platformAdmin + MFA). Deploy API + web. Upgrade (or wait for) the bridge endpoint(s) to the new agent.
- [ ] **Step 5: Verify on US** — with the printer (a private LAN IP) linked/whitelisted and a healthy online bridge agent on its subnet, click Connect → the printer's web UI renders in the iframe; `tunnel_sessions` shows the request path working. (Separately: a couple of customer agents are in watchdog failover — restart those out-of-band; unrelated to this fix.)

---

## Self-Review Notes

- **Spec coverage:** root-cause (no WS consumer) → Tasks 5-6 (real consumer via iframe/proxy). "Connecting forever" → status now driven by iframe load + the proxy actually returning bytes. UX confusion (link vs whitelist vs bridge) → Task 7 separates all three. Modal-close bug → already fixed on `fix/discovery-proxy-link-ux`. Offline-device hiding → Task 7 bridge picker. 60s ticket race → Task 4 (5-min http-ticket).
- **Known gaps (documented, not silently dropped):** `<base>`-tag rewriting won't fix absolute-URL or JS-constructed-URL printer UIs (follow-up: fuller HTML/redirect rewriting or per-asset "open in new tab" only); large responses capped at 16 MiB (Task 2) — streaming/chunked transfer is a follow-up; WebSocket-based device UIs aren't supported by one-shot `http_request` (follow-up if needed).
- **Type consistency:** `http_request` payload (`targetHost/targetPort/scheme/method/path/headers/bodyB64/allowlistRules`) is identical in Task 2 (agent), Task 5 (API dispatch). Result shape (`status/headers/bodyB64/truncated`) identical Task 2 → Task 5. `sendCommandToAgentAwaitResult` signature identical Task 3 → Task 5.
