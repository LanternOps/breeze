// Test helper: a fetch that serves recorded GitHub API responses (W06, #10750).
//
// `routes` maps `"<METHOD> <path+query>"` (path as GitHub serves it, e.g.
// `GET /repos/o/r/actions/runs/1`) to a response, a list of responses served in
// order (the last one repeats), or a function `(request) => response`.
// A response is `{ status, body }` (JSON), `{ status, text }`, `{ status, bytes }`
// or `{ status, location }` (a redirect). Unrouted requests answer 404 and are
// listed in `unrouted`, so a test can assert it asked only for what it meant to.
import { readFileSync } from 'node:fs';

export function loadRoutes(url) {
  return JSON.parse(readFileSync(url, 'utf8')).routes;
}

export function fakeFetch(routes = {}) {
  const calls = [];
  const unrouted = [];
  const served = new Map();
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const key = `${method} ${url.pathname}${url.search}`;
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    const request = { method, key, url: url.href, body, headers: init.headers ?? {} };
    calls.push(request);
    let route = routes[key] ?? routes[`${method} ${url.href}`];
    if (typeof route === 'function') route = route(request);
    if (Array.isArray(route)) {
      const n = served.get(key) ?? 0;
      served.set(key, n + 1);
      route = route[Math.min(n, route.length - 1)];
    }
    if (route === undefined) {
      unrouted.push(key);
      route = { status: 404, body: { message: 'Not Found' } };
    }
    if (route.throws) throw new Error(route.throws);
    if (route.location) return new Response(null, { status: route.status ?? 302, headers: { location: route.location } });
    if (route.bytes) return new Response(route.bytes, { status: route.status ?? 200 });
    const text = route.text ?? (route.body === undefined ? '' : JSON.stringify(route.body));
    return new Response(text, { status: route.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls, unrouted };
}
