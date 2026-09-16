/** URL rewriting for an HTTP tunnel. The target comes only from the session row. */
export interface TunnelRewriteOptions {
  basePath: string;
  targetOrigin: string;
}

// Keep this function self-contained: its source is also used by the browser shim,
// so server-rendered and dynamically requested URLs use exactly the same mapping.
export function rewriteTunnelUrl(value: string, options: TunnelRewriteOptions): string {
  const url = value.trim();
  const rootRelative = url.startsWith('/') && !url.startsWith('//');
  if (!rootRelative && !/^(https?:)?\/\//i.test(url)) return value;
  try {
    const target = new URL(options.targetOrigin);
    const parsed = new URL(url, target);
    if (!['http:', 'https:'].includes(parsed.protocol)) return value;
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    const targetPort = target.port || (target.protocol === 'https:' ? '443' : '80');
    if (parsed.hostname !== target.hostname || port !== targetPort) return value;
    // Dot segments (including percent-encoded ones) must not escape the tunnel.
    if (parsed.pathname.startsWith(options.basePath)) {
      return parsed.pathname + parsed.search + parsed.hash;
    }
    return options.basePath + parsed.pathname.slice(1) + parsed.search + parsed.hash;
  } catch {
    return value;
  }
}

/** Preserve comments and ordinary strings; rewrite only CSS URL/import tokens. */
export function rewriteTunnelCss(css: string, options: TunnelRewriteOptions): string {
  return css.replace(
    /\/\*[\s\S]*?\*\/|\burl\(\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^)'"\s]*)\s*\)|@import\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gi,
    (token) => {
      if (!/^(url\(|@import\s)/i.test(token)) return token;
      return token.replace(/^(url\(\s*|@import\s+)(["']?)(.*?)(\2\s*\)?)$/is,
        (_, prefix: string, quote: string, url: string, suffix: string) =>
          prefix + quote + rewriteTunnelUrl(url, options) + suffix);
    },
  );
}

function rewriteSrcset(value: string, options: TunnelRewriteOptions): string {
  let result = '';
  let rest = value;
  while (rest) {
    const separator = rest.match(/^[\s,]+/)?.[0] ?? '';
    result += separator;
    rest = rest.slice(separator.length);
    if (!rest) break;
    // Data URL payloads can contain commas and start with '/'. Consume them as
    // one URL, otherwise a JPEG payload such as /9j/... becomes a proxy path.
    const token = rest.match(/^data:/i)
      ? rest.match(/^[^\s]+/)![0] : rest.match(/^[^\s,]+/)![0];
    rest = rest.slice(token.length);
    const url = token.replace(/,+$/, '');
    result += rewriteTunnelUrl(url, options) + token.slice(url.length);
    if (url.length !== token.length) continue;
    const descriptor = rest.match(/^[^,]*/)?.[0] ?? '';
    result += descriptor;
    rest = rest.slice(descriptor.length);
  }
  return result;
}

// Attribute values are entity-decoded by the browser before URL/CSS parsing.
// Decode numeric references and the markup delimiters used by device templates.
function decodeAttribute(value: string): string {
  const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (entity, name: string) => {
    if (!name.startsWith('#')) return named[name.toLowerCase()] ?? entity;
    const hex = name[1]?.toLowerCase() === 'x';
    const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

function encodeAttribute(value: string, quote: string): string {
  const escaped = value.replace(/&/g, '&amp;');
  if (quote === '"') return escaped.replace(/"/g, '&quot;');
  if (quote === "'") return escaped.replace(/'/g, '&#39;');
  return escaped.replace(/[\s"'`=<>]/g, (char) => `&#${char.charCodeAt(0)};`);
}

function rewriteTag(tag: string, options: TunnelRewriteOptions): string {
  return tag.replace(/(\s+)([^\s=/>]+)(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g,
    (attribute, space: string, name: string, equals: string, double: string | undefined,
      single: string | undefined, bare: string | undefined) => {
      const value = decodeAttribute(double ?? single ?? bare ?? '');
      const quote = double !== undefined ? '"' : single !== undefined ? "'" : '';
      let rewritten: string;
      switch (name.toLowerCase()) {
        case 'src': case 'href': case 'action': case 'formaction': case 'poster':
          rewritten = rewriteTunnelUrl(value, options);
          break;
        case 'srcset': rewritten = rewriteSrcset(value, options); break;
        case 'style': rewritten = rewriteTunnelCss(value, options); break;
        default: return attribute;
      }
      if (rewritten === value) return attribute;
      return space + name + equals + quote + encodeAttribute(rewritten, quote) + quote;
    });
}

function browserShim(options: TunnelRewriteOptions): string {
  // Escape '<' even though the values are server-owned, so serialized options
  // can never terminate the script element. No device JavaScript is rewritten.
  const config = JSON.stringify(options).replace(/</g, '\\u003c');
  return `<script data-breeze-tunnel-rewrite>(function(){
var options=${config};
var rewrite=${rewriteTunnelUrl.toString()};
function map(value){return typeof value==='string'||value instanceof URL?rewrite(String(value),options):value;}
if(typeof fetch==='function'){
  var originalFetch=fetch;
  globalThis.fetch=function(input,init){
    if(typeof Request!=='undefined'&&input instanceof Request){
      var url=map(input.url);
      // Request has already resolved root-relative input against the frame URL.
      if(url===input.url&&typeof location!=='undefined'){
        var resolved=new URL(input.url);
        if(resolved.origin===new URL(location.href).origin)
          url=map(resolved.pathname+resolved.search+resolved.hash);
        if(url===resolved.pathname+resolved.search+resolved.hash) url=input.url;
      }
      if(url!==input.url) input=new Request(url,input);
    }else input=map(input);
    return originalFetch.call(this,input,init);
  };
}
if(typeof XMLHttpRequest!=='undefined'){
  var originalOpen=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(){
    var args=Array.prototype.slice.call(arguments);args[1]=map(args[1]);
    return originalOpen.apply(this,args);
  };
}
if(typeof Element!=='undefined'){
  var originalAttribute=Element.prototype.setAttribute;
  Element.prototype.setAttribute=function(name,value){
    if(/^(src|href)$/i.test(name)) value=map(value);
    return originalAttribute.call(this,name,value);
  };
}
['pushState','replaceState'].forEach(function(name){
  var original=history[name];
  history[name]=function(){
    var args=Array.prototype.slice.call(arguments);
    if(args.length>2) args[2]=map(args[2]);
    return original.apply(this,args);
  };
});
})();</script>`;
}

/**
 * Rewrite markup without touching comments, script source, or raw-text elements.
 * Keep the document's spelling/quoting intact; a full HTML serializer can change
 * legacy device markup. Tokens consume quoted '>' characters and raw-text bodies.
 * WebSocket upgrades and Location setters are not supported by this HTTP bridge.
 */
export function rewriteTunnelHtml(html: string, options: TunnelRewriteOptions): string {
  const injection = `<base href="${options.basePath}">` + browserShim(options);
  let injected = false;
  let sawScript = false;
  const rewritten = html.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title)\b(?:"[^"]*"|'[^']*'|[^'">])*>[\s\S]*?(?:<\/\1\s*>|$)|<![^>]*>|<\/?[a-z][a-z\d:-]*\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi,
    (token: string, rawTag: string | undefined) => {
      if (/^<!/.test(token)) return token;
      if (/^<base\b/i.test(token)) return '';
      if (/^<script data-breeze-tunnel-rewrite>/.test(token)) return '';
      if (rawTag) {
        const opening = token.match(/^<(?:"[^"]*"|'[^']*'|[^'">])*>/)![0];
        let rest = token.slice(opening.length);
        if (rawTag.toLowerCase() === 'style') rest = rewriteTunnelCss(rest, options);
        const result = rewriteTag(opening, options) + rest;
        if (rawTag.toLowerCase() === 'script') sawScript = true;
        return result;
      }
      const result = rewriteTag(token, options);
      if (!injected && !sawScript && /^<head\b/i.test(token)) {
        injected = true;
        return result + injection;
      }
      return result;
    },
  );
  if (injected) return rewritten;
  // Keep a leading doctype in its original position to preserve standards mode.
  const doctype = rewritten.match(/^\s*<!doctype[^>]*>/i)?.[0] ?? '';
  return doctype + injection + rewritten.slice(doctype.length);
}
