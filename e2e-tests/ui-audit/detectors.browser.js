// In-page layout detectors for the UI audit. This file is injected into the
// page as source text (see detectors.ts), NOT imported: it must stay plain,
// self-contained JavaScript — a transpiled TS function would drag in helper
// references (`__name`, …) that do not exist in the page.
//
// It is one expression: a function taking { mobile } and returning
// { findings, signature, links }. Each finding's element (and a spill's
// culprit) is tagged with its index so crops.ts can find it again.
(function detectLayoutIssues(opts) {
  const MAX_PER_KIND = 15;
  const vw = document.documentElement.clientWidth; // excludes the scrollbar
  const vh = window.innerHeight;
  const findings = [];
  const counts = {};
  const REF = 'data-ui-audit-ref';
  const CULPRIT = 'data-ui-audit-culprit';

  // the previous theme's scan tagged this same DOM
  for (const attr of [REF, CULPRIT]) {
    for (const e of document.querySelectorAll('[' + attr + ']')) e.removeAttribute(attr);
  }

  // space-separated: one element can carry several findings
  function tag(el, attr, ref) {
    const cur = el.getAttribute(attr);
    el.setAttribute(attr, cur ? cur + ' ' + ref : String(ref));
  }

  function push(f, el, culprit) {
    counts[f.kind] = (counts[f.kind] || 0) + 1;
    if (counts[f.kind] > MAX_PER_KIND) return;
    if (el) {
      f.ref = findings.length;
      tag(el, REF, f.ref);
      if (culprit) tag(culprit, CULPRIT, f.ref);
      // Does the viewport screenshot show it? The app shell scrolls <main>,
      // not the document, so anything below the fold is simply not in it.
      // Taller-than-viewport boxes count as shown when their top is on screen.
      const r = (culprit || el).getBoundingClientRect();
      f.inView = r.top >= 0 && r.top < vh && (r.bottom <= vh || r.height > vh / 2);
    }
    findings.push(f);
  }

  function describe(el) {
    const parts = [];
    let cur = el;
    for (let depth = 0; cur && cur.nodeType === 1 && depth < 4; depth++) {
      const tid = cur.getAttribute('data-testid');
      if (tid) {
        parts.unshift('[data-testid="' + tid + '"]');
        break;
      }
      let s = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift(s + '#' + CSS.escape(cur.id));
        break;
      }
      const cls = (typeof cur.className === 'string' ? cur.className : '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2);
      if (cls.length) s += '.' + cls.map((c) => CSS.escape(c)).join('.');
      parts.unshift(s);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    // <= 2px also drops sr-only text (1x1, clipped) — invisible by design.
    if (r.width <= 2 || r.height <= 2) return false;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
      return false;
    }
    if (el.closest('[aria-hidden="true"], [inert]')) return false;
    // visually-hidden pattern (sr-only): a real box clipped to nothing
    const cs = getComputedStyle(el);
    if (cs.clipPath !== 'none' && /inset\(50%\)|circle\(0/.test(cs.clipPath)) return false;
    if (cs.clip && cs.clip !== 'auto' && /rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)/.test(cs.clip)) return false;
    return true;
  }

  function hasScrollAncestorX(el) {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
    return false;
  }

  function hasClipAncestorX(el) {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (getComputedStyle(p).overflowX !== 'visible') return true;
    }
    return false;
  }

  // Is (x, y) inside every clipping ancestor's box? If not, the point is
  // scrolled/clipped away — whatever elementFromPoint returns there is not
  // "covering" the control.
  function pointInClipAncestors(el, x, y) {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const r = p.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) return false;
    }
    return true;
  }

  // Partly scrolled out of its nearest scroll container? Then whatever sits
  // over its edge is the scroller's surroundings, not an overlap bug.
  function partlyScrolledAway(el, r) {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (!/auto|scroll/.test(cs.overflowY + cs.overflowX)) continue;
      const pr = p.getBoundingClientRect();
      return r.top < pr.top - 1 || r.bottom > pr.bottom + 1 || r.left < pr.left - 1 || r.right > pr.right + 1;
    }
    return false;
  }

  function hasDirectText(el) {
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && n.textContent.trim()) return true;
    }
    return false;
  }

  const INTERACTIVE_SEL =
    'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="switch"], [role="menuitem"]';

  // A block whose only content is text (plus inline decoration) — the kind of
  // element where clipping loses words, as opposed to a layout container.
  function isTextLeaf(el) {
    if (!el.textContent || !el.textContent.trim()) return false;
    if (hasDirectText(el)) return true;
    for (const d of el.querySelectorAll('*')) {
      if (d.matches(INTERACTIVE_SEL)) return false;
      const disp = getComputedStyle(d).display;
      if (!disp.startsWith('inline') && d.tagName.toLowerCase() !== 'svg') return false;
    }
    return true;
  }

  const all = Array.from(document.body.querySelectorAll('*'));
  const visible = all.filter(isVisible);

  // --- page-level horizontal overflow -------------------------------------
  const docW = document.documentElement.scrollWidth;
  if (docW > vw + 1) {
    const offenders = visible.filter((el) => {
      const r = el.getBoundingClientRect();
      if (r.right <= vw + 1) return false;
      const parent = el.parentElement;
      if (!parent) return false;
      // the element that first sticks out, not every descendant that follows it
      if (parent !== document.body && parent.getBoundingClientRect().right > vw + 1) return false;
      return !hasClipAncestorX(el);
    });
    push({
      source: 'layout',
      kind: 'page-horizontal-overflow',
      severity: 'high',
      message:
        'Page scrolls horizontally: content is ' + docW + 'px wide in a ' + vw + 'px viewport' +
        (offenders.length ? '; widest offenders: ' + offenders.slice(0, 3).map(describe).join(' | ') : ''),
      selector: offenders.length ? describe(offenders[0]) : undefined,
    }, offenders[0]);
  }

  // --- content spilling out of its box ------------------------------------
  const spilling = [];
  for (const el of visible) {
    const cs = getComputedStyle(el);
    if (cs.overflowX !== 'visible' || cs.display.startsWith('inline') || cs.display === 'contents') continue;
    if (el.scrollWidth <= el.clientWidth + 4) continue;
    const box = el.getBoundingClientRect();
    let culprit = null;
    let n = 0;
    for (const d of el.querySelectorAll('*')) {
      if (++n > 300) break;
      const dr = d.getBoundingClientRect();
      if (dr.right <= box.right + 4 || dr.width === 0) continue;
      // absolutely/fixed positioned popovers and badges spill on purpose, and
      // a negative right margin (-mx-2 hover rows) is a deliberate bleed
      let positioned = false;
      let bleed = 0;
      for (let p = d; p && p !== el; p = p.parentElement) {
        const pcs = getComputedStyle(p);
        if (pcs.position === 'absolute' || pcs.position === 'fixed') {
          positioned = true;
          break;
        }
        bleed += Math.max(0, -parseFloat(pcs.marginRight) || 0);
      }
      if (!positioned && dr.right - box.right > bleed + 1) {
        culprit = d;
        break;
      }
    }
    if (culprit) spilling.push({ el, culprit, px: Math.round(culprit.getBoundingClientRect().right - box.right) });
  }
  // keep the innermost box: an outer container spills only because an inner one does
  for (const s of spilling) {
    if (spilling.some((o) => o !== s && s.el.contains(o.el))) continue;
    push({
      source: 'layout',
      kind: 'content-overflow',
      severity: 'medium',
      message: 'Content spills ' + s.px + 'px past the right edge of its box (culprit: ' + describe(s.culprit) + ')',
      selector: describe(s.el),
    }, s.el, s.culprit);
  }

  // --- clipped text --------------------------------------------------------
  for (const el of visible) {
    const cs = getComputedStyle(el);
    const clipX = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
    const clipY = cs.overflowY === 'hidden' || cs.overflowY === 'clip';
    if (!clipX && !clipY) continue;
    if (cs.textOverflow === 'ellipsis') continue;
    if (cs.webkitLineClamp && cs.webkitLineClamp !== 'none') continue;
    if (cs.clipPath !== 'none' || (cs.clip && cs.clip !== 'auto')) continue;
    if (!isTextLeaf(el)) continue;
    const lostX = clipX && el.scrollWidth > el.clientWidth + 1;
    const lostY = clipY && el.scrollHeight > el.clientHeight + 2;
    if (!lostX && !lostY) continue;
    push({
      source: 'layout',
      kind: 'clipped-text',
      severity: 'medium',
      message:
        'Text is cut off ' + (lostX ? 'horizontally' : 'vertically') + ' with no ellipsis: "' +
        el.textContent.trim().replace(/\s+/g, ' ').slice(0, 60) + '"',
      selector: describe(el),
    }, el);
  }

  // --- controls: offscreen, covered, too small ----------------------------
  const controls = visible.filter((el) => el.matches(INTERACTIVE_SEL) && !el.disabled);
  for (const el of controls) {
    const r = el.getBoundingClientRect();
    const label = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').trim().slice(0, 40);

    // Straddling the edge = cut off. Fully off-canvas (closed drawers) is intentional.
    const straddles = (r.left < -1 && r.right > 0) || (r.right > vw + 1 && r.left < vw);
    if (straddles && !hasScrollAncestorX(el)) {
      push({
        source: 'layout',
        kind: 'offscreen-control',
        severity: 'high',
        message: 'Control "' + label + '" is cut off by the viewport edge (x ' + Math.round(r.left) + '→' + Math.round(r.right) + ', viewport ' + vw + ')',
        selector: describe(el),
      }, el);
    }

    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx >= 0 && cx < vw && cy >= 0 && cy < vh && pointInClipAncestors(el, cx, cy) && !partlyScrolledAway(el, r)) {
      const hit = document.elementFromPoint(cx, cy);
      const lbl = el.closest('label');
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(el) && !(lbl && lbl.contains(hit))) {
        push({
          source: 'layout',
          kind: 'covered-control',
          severity: 'high',
          message: 'Control "' + label + '" is covered by ' + describe(hit),
          selector: describe(el),
        }, el);
      }
    }

    if (opts.mobile && (r.width < 24 || r.height < 24)) {
      const inlineLink = el.tagName === 'A' && getComputedStyle(el).display === 'inline';
      const labelledToggle =
        el.tagName === 'INPUT' && /^(checkbox|radio)$/.test(el.type) && (el.closest('label') || (el.labels && el.labels.length));
      if (!inlineLink && !labelledToggle) {
        push({
          source: 'layout',
          kind: 'small-target',
          severity: 'low',
          message: 'Tap target "' + label + '" is ' + Math.round(r.width) + '×' + Math.round(r.height) + 'px (min 24×24)',
          selector: describe(el),
        }, el);
      }
    }
  }

  // --- broken images -------------------------------------------------------
  for (const img of document.images) {
    const r = img.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (img.complete && img.naturalWidth === 0) {
      push({
        source: 'layout',
        kind: 'broken-image',
        severity: 'medium',
        message: 'Image failed to load: ' + (img.currentSrc || img.src).slice(0, 120),
        selector: describe(img),
      }, img);
    }
  }

  // --- page shape, for grouping pages into critique buckets ---------------
  const root = document.querySelector('main') || document.body;
  const feats = [];
  if (root.querySelector('table, [role="grid"], [role="table"]')) feats.push('table');
  if (root.querySelector('[role="tablist"]')) feats.push('tabs');
  const fields = root.querySelectorAll(
    'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="search"]), select, textarea',
  ).length;
  if (fields >= 4) feats.push('form');
  if (root.querySelectorAll('.recharts-wrapper, canvas').length >= 2) feats.push('charts');
  const signature = feats.sort().join('+') || 'plain';

  const links = Array.from(document.querySelectorAll('a[href]'), (a) => a.href);

  return { findings, signature, links, totals: counts };
});
