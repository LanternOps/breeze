/**
 * B-W05 (#6159, D-B39): the fleet-health MCP App view, served as the resource
 * `ui://breeze/fleet-health/v1` (mimeType `text/html;profile=mcp-app`).
 *
 * One static, self-contained HTML5 document: inline style, one inline script,
 * no URL and no network access (messages go to window.parent via postMessage;
 * the sender is checked on receipt). It renders the `structuredContent`
 * that `get_fleet_health` already returns and falls back to the tool's text.
 *
 * Rules (enforced by registry.contract.test.ts and fleetHealthView.test.ts):
 * - Every value is tenant-controlled input. The DOM is built with
 *   createElement + textContent only; no HTML-string sinks, no code-from-string.
 * - Numbers render only when Number.isFinite; anything else renders an em dash.
 * - Display-only: the only messages the view ever sends are ui/initialize,
 *   ui/notifications/initialized and ui/notifications/size-changed (plus empty
 *   responses to a host's ping / ui/resource-teardown requests).
 * - Messages are accepted only from window.parent, only as JSON-RPC 2.0, only
 *   for methods the view knows; everything else is dropped silently.
 * - English only (Gate B 3). Bump the URI version on any change an older
 *   cached host could misrender.
 *
 * Written as a TS string so the API image needs no asset copy step. The script
 * deliberately avoids template literals and backslashes so this file can hold
 * it verbatim.
 */
export const FLEET_HEALTH_VIEW_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Breeze fleet health</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #1d2330;
  --muted: #5f6b7d;
  --line: #e3e7ee;
  --chip: #f2f4f8;
  --critical: #c62828;
  --poor: #ef6c00;
  --fair: #f9a825;
  --good: #2e7d32;
  --warn-bg: #fff4e5;
  --warn-fg: #7a4100;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #12161e;
    --fg: #e6e9ef;
    --muted: #9aa5b5;
    --line: #2a313d;
    --chip: #1d232e;
    --critical: #ef5350;
    --poor: #ffa040;
    --fair: #ffd54f;
    --good: #66bb6a;
    --warn-bg: #3a2a12;
    --warn-fg: #ffd59a;
  }
}
:root[data-theme="dark"] {
  --bg: #12161e;
  --fg: #e6e9ef;
  --muted: #9aa5b5;
  --line: #2a313d;
  --chip: #1d232e;
  --critical: #ef5350;
  --poor: #ffa040;
  --fair: #ffd54f;
  --good: #66bb6a;
  --warn-bg: #3a2a12;
  --warn-fg: #ffd59a;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); }
body { font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; padding: 12px 14px; }
h1 { font-size: 15px; margin: 0 0 2px; font-weight: 600; }
.sub { color: var(--muted); margin: 0 0 10px; }
.bar { display: flex; height: 10px; border-radius: 5px; overflow: hidden; background: var(--chip); margin: 0 0 8px; }
.bar > span { display: block; min-width: 0; }
.bands { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 0 0 10px; align-items: center; }
.band { display: inline-flex; align-items: center; gap: 5px; }
.dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
.critical { background: var(--critical); }
.poor { background: var(--poor); }
.fair { background: var(--fair); }
.good { background: var(--good); }
.chip { background: var(--chip); border-radius: 10px; padding: 1px 8px; }
.muted { color: var(--muted); }
.warn { background: var(--warn-bg); color: var(--warn-fg); border-radius: 6px; padding: 6px 8px; margin: 0 0 10px; }
.wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; }
caption { text-align: left; color: var(--muted); padding: 0 0 4px; }
th, td { text-align: left; padding: 5px 8px 5px 0; border-bottom: 1px solid var(--line); vertical-align: top; white-space: nowrap; }
th { font-weight: 600; color: var(--muted); font-size: 12px; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.host { font-weight: 600; max-width: 260px; overflow: hidden; text-overflow: ellipsis; display: inline-block; vertical-align: bottom; }
.meta { color: var(--muted); font-size: 11px; max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
.prov { color: var(--muted); font-size: 11px; margin-left: 4px; }
.more { color: var(--muted); margin: 8px 0 0; }
pre { white-space: pre-wrap; word-break: break-word; margin: 0; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
</style>
</head>
<body>
<main id="root"><p class="muted">Waiting for the fleet health result…</p></main>
<script data-view>
(function () {
  'use strict';
  var parentWindow = window.parent;
  var INIT_ID = 'breeze-fleet-health-init';
  var state = 'initializing';
  var pending = null;
  var root = document.getElementById('root');

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
  function post(message) {
    parentWindow.postMessage(message, '*');
  }
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function num(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
  function fmtInt(value) {
    var n = num(value);
    return n === null ? '—' : String(n);
  }
  function fmtPercent(value) {
    var n = num(value);
    return n === null ? '—' : n.toFixed(1) + '%';
  }
  function str(value) {
    return typeof value === 'string' && value.length > 0 ? value : '—';
  }
  function clear() {
    while (root.firstChild) root.removeChild(root.firstChild);
  }
  function reportSize() {
    var doc = document.documentElement;
    post({
      jsonrpc: '2.0',
      method: 'ui/notifications/size-changed',
      params: { width: Math.ceil(doc.scrollWidth || 0), height: Math.ceil(doc.scrollHeight || 0) }
    });
  }

  function fallbackText(result) {
    var content = isObject(result) && Array.isArray(result.content) ? result.content : [];
    for (var i = 0; i < content.length; i += 1) {
      var item = content[i];
      if (isObject(item) && item.type === 'text' && typeof item.text === 'string') return item.text;
    }
    return null;
  }

  function renderFallback(result) {
    clear();
    var text = fallbackText(result);
    var pre = el('pre', '', text === null ? 'The tool returned no displayable result.' : text);
    pre.setAttribute('data-testid', 'fh-fallback');
    root.appendChild(pre);
  }

  var BANDS = [
    { key: 'criticalDevices', cls: 'critical', label: 'Critical', range: '0–50' },
    { key: 'poorDevices', cls: 'poor', label: 'Poor', range: '51–70' },
    { key: 'fairDevices', cls: 'fair', label: 'Fair', range: '71–85' },
    { key: 'goodDevices', cls: 'good', label: 'Good', range: '86–100' }
  ];

  var COLUMNS = [
    { key: 'reliabilityScore', label: 'Score', fmt: fmtInt, testid: 'fh-score' },
    { key: 'trendDirection', label: 'Trend', text: true, testid: 'fh-trend' },
    { key: 'uptime30d', label: 'Uptime 30d', fmt: fmtPercent },
    { key: 'crashCount30d', label: 'Crashes', fmt: fmtInt },
    { key: 'hangCount30d', label: 'Hangs', fmt: fmtInt },
    { key: 'serviceFailureCount30d', label: 'Service failures', fmt: fmtInt },
    { key: 'hardwareErrorCount30d', label: 'Hardware errors', fmt: fmtInt },
    { key: 'topIssueCount', label: 'Issues', fmt: fmtInt }
  ];

  function renderCard(data) {
    clear();
    var summary = data.summary;
    var offset = num(data.offset);
    var showing = num(data.showing);
    var total = num(data.total);
    var rows = [];
    var partial = Object.prototype.hasOwnProperty.call(data, '_chat');
    for (var i = 0; i < data.devices.length; i += 1) {
      if (isObject(data.devices[i])) rows.push(data.devices[i]);
      else partial = true;
    }

    root.appendChild(el('h1', '', 'Fleet reliability'));
    var sub = el('p', 'sub', fmtInt(total) + ' matching devices');
    if (offset !== null && offset > 0) {
      sub.textContent += ' · showing ' + fmtInt(showing) + ' (offset ' + fmtInt(offset) + ')';
    }
    sub.setAttribute('data-testid', 'fh-total');
    root.appendChild(sub);

    if (partial) {
      var warn = el('p', 'warn', 'Partial result — the server shortened this output, so some devices or fields are missing.');
      warn.setAttribute('data-testid', 'fh-partial');
      root.appendChild(warn);
    }

    var bar = el('div', 'bar');
    bar.setAttribute('aria-hidden', 'true');
    var bands = el('div', 'bands');
    for (var b = 0; b < BANDS.length; b += 1) {
      var band = BANDS[b];
      var count = num(summary[band.key]);
      if (count !== null && count > 0) {
        var seg = el('span', band.cls);
        seg.style.flexGrow = String(count);
        bar.appendChild(seg);
      }
      var item = el('span', 'band');
      item.setAttribute('data-testid', 'fh-band-' + band.cls);
      item.setAttribute('title', band.label + ' (' + band.range + ')');
      item.appendChild(el('span', 'dot ' + band.cls));
      item.appendChild(el('span', '', band.label + ' ' + fmtInt(summary[band.key])));
      bands.appendChild(item);
    }
    var degrading = el('span', 'chip', fmtInt(summary.degradingDevices) + ' degrading');
    degrading.setAttribute('data-testid', 'fh-degrading');
    bands.appendChild(degrading);
    var average = el('span', 'muted', 'Average score ' + fmtInt(summary.averageScore));
    average.setAttribute('data-testid', 'fh-average');
    bands.appendChild(average);
    root.appendChild(bar);
    root.appendChild(bands);

    var wrap = el('div', 'wrap');
    var table = el('table');
    var caption = el('caption', '', offset === 0 ? 'This page — worst first' : 'This page');
    caption.setAttribute('data-testid', 'fh-caption');
    table.appendChild(caption);
    var thead = el('thead');
    var headRow = el('tr');
    headRow.appendChild(el('th', '', 'Device'));
    for (var c = 0; c < COLUMNS.length; c += 1) {
      headRow.appendChild(el('th', COLUMNS[c].text ? '' : 'num', COLUMNS[c].label));
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    var tbody = el('tbody');
    for (var r = 0; r < rows.length; r += 1) {
      var device = rows[r];
      var tr = el('tr');
      tr.setAttribute('data-testid', 'fh-row');
      var hostCell = el('td');
      var host = el('span', 'host', str(device.hostname));
      host.setAttribute('data-testid', 'fh-host');
      hostCell.appendChild(host);
      if (device.provisional === true) {
        var prov = el('span', 'prov', 'provisional');
        prov.setAttribute('data-testid', 'fh-provisional');
        prov.setAttribute('title', 'Score is provisional: the post-baseline window is still short.');
        hostCell.appendChild(prov);
      }
      var meta = el('div', 'meta', str(device.osType) + ' · ' + str(device.status) + ' · computed ' + str(device.computedAt));
      meta.setAttribute('data-testid', 'fh-meta');
      hostCell.appendChild(meta);
      tr.appendChild(hostCell);
      for (var k = 0; k < COLUMNS.length; k += 1) {
        var column = COLUMNS[k];
        var cell = el('td', column.text ? '' : 'num', column.text ? str(device[column.key]) : column.fmt(device[column.key]));
        if (column.testid) cell.setAttribute('data-testid', column.testid);
        tr.appendChild(cell);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    root.appendChild(wrap);

    if (data.hasMore === true) {
      var remaining = total !== null && offset !== null && showing !== null ? total - offset - showing : null;
      var more = el('p', 'more', (remaining !== null && remaining > 0 ? remaining + ' more' : 'More devices') + ' — ask for the next page.');
      more.setAttribute('data-testid', 'fh-more');
      root.appendChild(more);
    }
  }

  function renderCancelled() {
    clear();
    var line = el('p', 'muted', 'The fleet health request was cancelled.');
    line.setAttribute('data-testid', 'fh-cancelled');
    root.appendChild(line);
  }

  function render(event) {
    try {
      if (event.kind === 'cancelled') {
        renderCancelled();
      } else {
        var result = event.result;
        var data = isObject(result) ? result.structuredContent : undefined;
        if (isObject(result) && result.isError !== true && isObject(data)
          && Array.isArray(data.devices) && isObject(data.summary)) {
          renderCard(data);
        } else {
          renderFallback(result);
        }
      }
    } catch (err) {
      try {
        renderFallback(event.result);
      } catch (fallbackErr) {
        clear();
        var last = el('pre', '', 'Unable to display this result.');
        last.setAttribute('data-testid', 'fh-fallback');
        root.appendChild(last);
      }
    }
    reportSize();
  }

  function deliver(event) {
    if (state === 'ready') render(event);
    else pending = event;
  }

  function completeHandshake(response) {
    state = 'ready';
    if (isObject(response.result) && isObject(response.result.hostContext)) {
      var theme = response.result.hostContext.theme;
      if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
    }
    post({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
    if (pending !== null) {
      var event = pending;
      pending = null;
      render(event);
    }
  }

  window.addEventListener('message', function (event) {
    if (event.source !== parentWindow) return;
    var data = event.data;
    if (!isObject(data) || data.jsonrpc !== '2.0') return;
    var hasMethod = typeof data.method === 'string';

    if (!hasMethod) {
      if (state === 'initializing' && data.id === INIT_ID && ('result' in data || 'error' in data)) {
        completeHandshake(data);
      }
      return;
    }

    var params = isObject(data.params) ? data.params : {};
    switch (data.method) {
      case 'ui/notifications/tool-result':
        deliver({ kind: 'result', result: params });
        return;
      case 'ui/notifications/tool-cancelled':
        deliver({ kind: 'cancelled' });
        return;
      case 'ui/notifications/tool-input':
      case 'ui/notifications/tool-input-partial':
      case 'ui/notifications/host-context-changed':
        return;
      case 'ping':
      case 'ui/resource-teardown':
        if (typeof data.id === 'string' || typeof data.id === 'number') {
          post({ jsonrpc: '2.0', id: data.id, result: {} });
        }
        return;
      default:
        return;
    }
  });

  post({
    jsonrpc: '2.0',
    id: INIT_ID,
    method: 'ui/initialize',
    params: {
      protocolVersion: '2026-01-26',
      appInfo: { name: 'breeze-fleet-health', version: '1' },
      appCapabilities: {}
    }
  });
})();
</script>
</body>
</html>
`;
