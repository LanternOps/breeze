import { describe, it, expect } from 'vitest';
import {
  formatHttpFailure,
  formatHttpFailureDetail,
  summarizeResponseBody,
  MAX_OPERATOR_ERROR_LENGTH,
} from './httpFailureMessage';
import { scrubChannelTestError } from './notificationChannelSecrets';

// The reported body, verbatim from #3992: a webhook channel pointed at a URL
// that answers 405 with an HTML error page. 500 characters of this landed in
// the channel card and buried the only useful token.
const EXAMPLE_DOMAIN_405 =
  '<!doctype html><html lang="en"><head><title>Example Domain</title>' +
  '<link rel="icon" href="data:,">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<style>body{background:#eee;width:60vw;margin:15vh auto;font-family:system-ui,sans-serif}h1{font-size:1.5em}</style>' +
  '</head><body><h1>Example Domain</h1>' +
  '<p>This domain is for use in illustrative examples in documents.</p>' +
  '</body></html>';

describe('summarizeResponseBody', () => {
  it('reduces the reported HTML error page to readable prose', () => {
    const summary = summarizeResponseBody(EXAMPLE_DOMAIN_405);

    expect(summary).toContain('Example Domain');
    expect(summary).toContain('This domain is for use in illustrative examples');
    // No markup, and — the part a naive tag-strip gets wrong — no leftover CSS.
    expect(summary).not.toContain('<');
    expect(summary).not.toContain('>');
    expect(summary).not.toContain('background:#eee');
    expect(summary).not.toContain('font-family');
    expect(summary).not.toContain('doctype');
  });

  it('drops script contents, not just the script tags', () => {
    const summary = summarizeResponseBody(
      '<html><body><script>var token="leaky";alert(1)</script><p>Method Not Allowed</p></body></html>'
    );

    expect(summary).toBe('Method Not Allowed');
  });

  it('handles a body truncated mid-tag or mid-script without leaking the fragment', () => {
    expect(summarizeResponseBody('<p>Not allowed</p><div class="foot')).toBe('Not allowed');
    expect(summarizeResponseBody('<p>Not allowed</p><script>var secret="abc')).toBe('Not allowed');
    expect(summarizeResponseBody('<p>Not allowed</p><!-- internal note about')).toBe('Not allowed');
    // A DECLARATION cut mid-write needs its own rule — the tag pattern requires
    // a letter after the optional `/`, so it never matches `<!doctype htm` and
    // the fragment used to survive into the card. A proxy timeout or a reset
    // partway through the response reproduces this exactly.
    expect(summarizeResponseBody('<p>Not allowed</p><!doctype htm')).toBe('Not allowed');
    expect(summarizeResponseBody('<p>Not allowed</p><![CDATA[ leftover')).toBe('Not allowed');
  });

  it('collapses newlines and indentation into single spaces', () => {
    expect(summarizeResponseBody('{\n  "error":\n\t"invalid_payload"\n}')).toBe('{ "error": "invalid_payload" }');
  });

  it('decodes the entities that would otherwise render as noise', () => {
    expect(summarizeResponseBody('<p>Tenant &amp; site&nbsp;mismatch &#8212; retry</p>')).toBe(
      'Tenant & site mismatch — retry'
    );
    // Hex numeric entities take the other fork of the same branch.
    expect(summarizeResponseBody('rate limit &#x2014; retry after 30s')).toBe('rate limit — retry after 30s');
    // Anything unusable stays literal rather than becoming mojibake.
    expect(summarizeResponseBody('a &#x110000; b &notarealentity; c')).toBe(
      'a &#x110000; b &notarealentity; c'
    );
  });

  it('leaves a plain-text body alone apart from trimming', () => {
    expect(summarizeResponseBody('  invalid_payload: field "text" is required  ')).toBe(
      'invalid_payload: field "text" is required'
    );
  });

  // Angle brackets around an address are ordinary in provider prose. Treating
  // them as markup would delete the one thing the operator needs to see.
  it('does not mistake an angle-bracketed address for a tag', () => {
    expect(summarizeResponseBody('recipient <ops@example.com> was rejected')).toBe(
      'recipient <ops@example.com> was rejected'
    );
  });

  it('returns an empty string when nothing readable survives', () => {
    expect(summarizeResponseBody('<html><head><style>b{color:red}</style></head><body></body></html>')).toBe('');
    expect(summarizeResponseBody('')).toBe('');
    expect(summarizeResponseBody(undefined)).toBe('');
    expect(summarizeResponseBody(null)).toBe('');
  });

  it('truncates at a word boundary rather than mid-token', () => {
    const summary = summarizeResponseBody(`${'alpha bravo '.repeat(40)}`, 40);

    expect(summary.length).toBeLessThanOrEqual(40);
    expect(summary.endsWith('…')).toBe(true);
    // Every kept token is whole.
    for (const token of summary.replace('…', '').trim().split(' ')) {
      expect(['alpha', 'bravo']).toContain(token);
    }
  });

  // A hostile destination can return an unbounded body (the senders pass no
  // `maxBytes` to safeFetch), and SCRIPT_OR_STYLE_BLOCK is a lazy scan with a
  // backreference — quadratic on a body full of unclosed `<script` tags. The
  // input window keeps that constant. This asserts the bound holds by timing
  // the pathological shape rather than by reading the code.
  it('does not degrade on a hostile multi-megabyte body', () => {
    const hostile = '<script src="x" '.repeat(60_000); // ~1MB, 60k unclosed opens

    const started = Date.now();
    const summary = summarizeResponseBody(hostile);
    const elapsed = Date.now() - started;

    expect(summary.length).toBeLessThanOrEqual(MAX_OPERATOR_ERROR_LENGTH);
    expect(elapsed).toBeLessThan(1000);
  });

  // A window with no boundary anywhere is one opaque blob — which is exactly
  // the shape a credential has. It is dropped rather than sliced through, and
  // the caller falls back to a bare `HTTP <status>`.
  it('drops a window with no boundary rather than slicing through it', () => {
    expect(summarizeResponseBody('x'.repeat(400), 40)).toBe('');
  });

  // What dropping a whitespace-free window does NOT cost: truncation only
  // engages above the cap, so an ordinary short minified body is returned
  // whole and never reaches the boundary rule at all.
  it('returns a short minified body whole, boundary rule never engaged', () => {
    expect(summarizeResponseBody('{"error":"invalid_grant"}')).toBe('{"error":"invalid_grant"}');
  });
});

describe('formatHttpFailure', () => {
  it('keeps the status token in front and caps the whole message', () => {
    const message = formatHttpFailure(405, EXAMPLE_DOMAIN_405);

    expect(message.startsWith('HTTP 405: ')).toBe(true);
    expect(message).toContain('Example Domain');
    expect(message.length).toBeLessThanOrEqual(MAX_OPERATOR_ERROR_LENGTH);
  });

  it('omits the separator when the body carried nothing readable', () => {
    expect(formatHttpFailure(502, '<html><body></body></html>')).toBe('HTTP 502');
    expect(formatHttpFailure(502, undefined)).toBe('HTTP 502');
  });

  it('degrades to a generic prefix when the status is unknown', () => {
    expect(formatHttpFailure(undefined, undefined)).toBe('HTTP error');
  });

  it('never exceeds the operator cap, whatever the destination returns', () => {
    for (const body of ['y'.repeat(5000), `${'word '.repeat(500)}`, '<p>a</p>'.repeat(500)]) {
      expect(formatHttpFailure(500, body).length).toBeLessThanOrEqual(MAX_OPERATOR_ERROR_LENGTH);
    }
  });
});

describe('formatHttpFailureDetail', () => {
  it('keeps the unshortened body for the log line', () => {
    const detail = formatHttpFailureDetail(405, EXAMPLE_DOMAIN_405);

    expect(detail).toContain('<!doctype html>');
    expect(detail.length).toBeGreaterThan(MAX_OPERATOR_ERROR_LENGTH);
  });

  it('still bounds a hostile destination', () => {
    expect(formatHttpFailureDetail(500, 'z'.repeat(50_000)).length).toBeLessThanOrEqual(512);
  });
});

// The operator-facing shortening happens BEFORE `scrubChannelTestError` runs,
// so it must not hand the scrubber a credential it can no longer recognise.
// Assembled at runtime, never written as a literal: GitHub push protection
// blocks a Slack-webhook-shaped string in source even when it is fabricated.
describe('composition does not weaken credential scrubbing', () => {
  const webhookUrl = `https://${['hooks', 'slack', 'com'].join('.')}/services/T00000000/B00000000/SECRETTOKENVALUE00000001`;

  it('still scrubs a webhook URL the destination echoed inside an HTML body', () => {
    const composed = formatHttpFailure(404, `<html><body><p>no_service for ${webhookUrl}</p></body></html>`);
    const scrubbed = scrubChannelTestError('slack', { webhookUrl }, composed);

    expect(scrubbed).not.toContain(webhookUrl);
    expect(scrubbed).not.toContain('SECRETTOKENVALUE00000001');
    expect(scrubbed).toContain('no_service');
  });

  // The reason the truncation cuts at a word boundary: a hard slice through a
  // URL leaves a prefix that literal-substring scrubbing cannot match.
  //
  // The fixture is tuned so the token STRADDLES the cut — with a naive hard
  // slice, 17 characters of it survive. The first assertion proves that
  // precondition, so this test cannot quietly become vacuous if the cap, the
  // prefix width or the URL length ever changes: if the token stops straddling,
  // the control fails rather than the guarantee passing for free.
  it('drops an echoed URL whole rather than leaving a scrubber-proof prefix', () => {
    const body = `the destination refused this delivery attempt outright and returned no_service ${webhookUrl}`;
    const budget = MAX_OPERATOR_ERROR_LENGTH - 'HTTP 404'.length - 2;

    // Control: a hard slice at the same budget WOULD publish part of the token.
    const hardSliced = body.slice(0, budget - 1);
    expect(hardSliced).toContain('SECRETTOKENVALUE');
    expect(hardSliced).not.toContain('SECRETTOKENVALUE00000001');

    const composed = formatHttpFailure(404, body);
    const scrubbed = scrubChannelTestError('slack', { webhookUrl }, composed) ?? '';

    // The real thing drops the URL whole, so no fragment of the token is left.
    expect(composed).not.toContain('SECRETTOKENVALUE');
    expect(scrubbed).not.toContain('SECRETTOKENVALUE');
    expect(scrubbed).not.toContain('hooks.slack.com');
    // ...and the operator still learns what happened.
    expect(scrubbed).toContain('no_service');
  });

  // The sharpest form of the leak, and the one a hard-cut fallback could not
  // survive: a destination that answers with nothing but the URL it was called
  // on — `res.status(404).send(req.originalUrl)` — so the body has no
  // whitespace at all and the token sits past the cap. Pass 2's pattern
  // matcher is no help here: a token carried as a PATH SEGMENT looks like
  // nothing in particular. Measured before the fix: 38 characters of the token
  // survived into the card.
  it('drops an echoed URL that is the whole body, token past the cap', () => {
    const token = 'SUPERSECRETTOKENVALUE0123456789ABCDEFGHIJ';
    const url =
      'https://hooks.vendor.example/services/tenant-acme-corporation-holdings-emea-region/workspace-primary-alerts/in' +
      token;

    // Control: the token really does straddle the cut for this fixture, so the
    // test cannot go vacuous if the cap or the URL shape changes.
    const cut = MAX_OPERATOR_ERROR_LENGTH - 'HTTP 404'.length - 2 - 1;
    expect(url.indexOf(token)).toBeLessThan(cut);
    expect(url.indexOf(token) + token.length).toBeGreaterThan(cut);
    expect(/\s/.test(url)).toBe(false);

    const composed = formatHttpFailure(404, url);
    const scrubbed = scrubChannelTestError('webhook', { url }, composed) ?? '';

    expect(composed).toBe('HTTP 404');
    expect(scrubbed).not.toContain('SUPERSECRETTOKEN');
  });

  // Entity decoding runs BEFORE truncation, so a destination that echoes a
  // secret as `TOKEN&quot;PART` hands the truncator a `"` sitting INSIDE the
  // secret. Treating punctuation as a cut point let the cut land on that
  // injected quote and publish `TOKENPART1`.
  it('does not cut on a boundary an HTML entity injected into a secret', () => {
    const secret = 'TOKENPART1"TOKENPART2LONGLONGLONGLONGLONGLONGLONGLONGLONGLONG';
    const body = `${'x'.repeat(100)} TOKENPART1&quot;TOKENPART2LONGLONGLONGLONGLONGLONGLONGLONGLONGLONG`;

    const composed = formatHttpFailure(404, body);
    const scrubbed = scrubChannelTestError('webhook', { headers: { 'X-Key': secret } }, composed) ?? '';

    expect(scrubbed).not.toContain('TOKENPART1');
  });

  // The case that killed the structural-punctuation fallback. A webhook
  // channel's secrets are not only its URL: secretKeysForType('webhook')
  // covers authToken, authPassword and apiKeyValue, which are admin-typed with
  // no charset restriction (`config: z.record(z.string(), z.unknown())`, and
  // validateOutboundHeader constrains header NAMES, not values). So a `|` or a
  // `"` inside an API key is entirely legal, and an unspaced
  // `error=…;description=…` echo let the cut land inside it — 44 characters of
  // the key survived. Cutting only at whitespace is what closes this.
  it('does not cut inside an api key that contains punctuation', () => {
    const apiKey = 'PLACEHOLDERAPIKEY_ABCDEFGHIJKLMNOPQRSTUVWXYZ|MOREDATAAFTERPIPE1234567890abcdefghijklmnopqrstuvwxyz';
    const body = `error=invalid_token;description=the_supplied_key(${apiKey})did_not_match_any_record_for_this_account`;

    // Control: no whitespace anywhere, and the key straddles the cut.
    expect(/\s/.test(body)).toBe(false);
    expect(body.length).toBeGreaterThan(MAX_OPERATOR_ERROR_LENGTH);

    const composed = formatHttpFailure(404, body);
    const scrubbed = scrubChannelTestError('webhook', { apiKeyValue: apiKey }, composed) ?? '';

    expect(composed).toBe('HTTP 404');
    expect(scrubbed).not.toContain('PLACEHOLDERAPIKEY');
  });
});

// #3992 round 2. The composer normalises (strips tags, decodes entities,
// collapses whitespace, truncates) and `scrubChannelTestError` at the route
// removes the channel's own credentials by LITERAL substring — so scrubbing
// only afterwards cannot catch what normalising rewrote, and the credential
// reaches the channel card and the test toast.
//
// The obvious alternative — keep scrubbing afterwards, but also search for the
// NORMALISED form of each secret — is unsound, and the third case below is the
// proof. Redaction has to run on the raw body, before the first lossy step.
//
// Every case carries a control asserting the leak IS reachable without the
// fix, so none of them can pass vacuously.
describe('credentials in the raw body are redacted before anything rewrites it', () => {
  it('masks a secret whose repeated whitespace the summary collapses', () => {
    const secret = 'alpha  beta  gamma';
    const body = `<p>rejected credential ${secret}</p>`;

    expect(formatHttpFailure(401, body)).toContain('alpha beta gamma'); // control

    const out = formatHttpFailure(401, body, { secrets: [secret] });

    expect(out).not.toContain('alpha beta gamma');
    expect(out).not.toContain(secret);
    expect(out).toContain('********');
  });

  it('masks a secret that tag-stripping splits in two', () => {
    const secret = 'alpha<b>beta-secret';
    const body = `rejected credential ${secret}`;

    expect(formatHttpFailure(401, body)).toContain('beta-secret'); // control

    const out = formatHttpFailure(401, body, { secrets: [secret] });

    expect(out).not.toContain('beta-secret');
    expect(out).not.toContain('alpha beta-secret');
  });

  // THE decisive case. Entity decoding consumes the `;` that came from OUTSIDE
  // the secret, so the transformed text contains neither `abcd&amp` (the raw
  // secret) nor any normalisation of it — it contains `abcd&`. No variant-
  // matching scheme can catch this, because the string being looked for does
  // not exist in either form. Redacting first is immune: the secret is gone
  // before the decoder runs.
  it('masks a secret whose trailing entity is completed by the text around it', () => {
    const secret = 'abcd&amp';
    const body = `rejected credential ${secret};`;

    const control = formatHttpFailure(401, body);
    expect(control).toContain('abcd&'); // control: the leak is real
    expect(control).not.toContain('abcd&amp'); // and no variant would have matched

    const out = formatHttpFailure(401, body, { secrets: [secret] });

    expect(out).not.toContain('abcd&');
    expect(out).toContain('********');
  });

  // truncate() cuts at whitespace, and the module documents its own residual:
  // a secret that CONTAINS whitespace can still be split, leaving a prefix that
  // no complete-secret match can find. Redacting first removes it first.
  it('masks a secret that truncation would otherwise cut in half', () => {
    const secret = 'front-half back-half-tail';
    const body = `reject ${secret}`;

    expect(formatHttpFailure(500, body, { maxLength: 40 })).toContain('front-half'); // control

    const out = formatHttpFailure(500, body, { secrets: [secret], maxLength: 40 });

    expect(out).not.toContain('front-half');
  });

  // A secret straddling the 8 KB scan bound would be cut by that slice before
  // masking could see it, publishing the prefix. Masking runs on a window
  // widened by the longest secret, so no occurrence starting inside the scan
  // window is ever bisected by the bound.
  it('masks a secret straddling the summary input window', () => {
    const secret = 'boundary-secret-value';
    const body = 'ab '.repeat(2729) + secret; // secret starts at 8187, window ends at 8192

    expect(summarizeResponseBody(body, 20000)).toContain('bound'); // control: prefix survives

    const out = summarizeResponseBody(body, 20000, [secret]);

    expect(out).not.toContain('bound');
  });

  // The log/delivery-record form is un-normalised on purpose so debugging loses
  // nothing — but nothing downstream scrubs it, so it must not carry the
  // channel's own credentials either.
  it('masks the unshortened detail form too', () => {
    const secret = 'detail-secret-value';

    expect(formatHttpFailureDetail(500, `boom ${secret}`)).toContain(secret); // control

    expect(formatHttpFailureDetail(500, `boom ${secret}`, [secret])).not.toContain(secret);
  });

  // Ordering invariant: a shorter secret that is a prefix of a longer one must
  // not replace its head first and carve the longer one into a fragment that no
  // longer matches. Sorted longest-first across ALL secrets, not per caller.
  it('masks the longer secret when one secret is a prefix of another', () => {
    const short = 'abcdefgh';
    const long = 'abcdefghSECRETTAIL';

    const out = formatHttpFailure(401, `rejected ${long}`, { secrets: [short, long] });

    expect(out).not.toContain('SECRETTAIL');
  });

  // The composer is not the only producer — a thrown Error.message reaches the
  // route scrub un-normalised — so the route scrub stays the second bracket.
  it('leaves the route scrub able to catch an untransformed message', () => {
    const authPassword = 'plain-secret-value';

    const scrubbed = scrubChannelTestError(
      'webhook',
      { authPassword },
      `rejected ${authPassword}`
    );

    expect(scrubbed).not.toContain(authPassword);
  });
});
