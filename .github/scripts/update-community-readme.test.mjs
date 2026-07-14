import assert from 'node:assert/strict';
import test from 'node:test';

import {
  escapeHtml,
  isBot,
  renderGallery,
  replaceMarkedBlock,
} from './update-community-readme.mjs';

test('escapes HTML-sensitive characters', () => {
  assert.equal(
    escapeHtml(`Breeze & <fast> \"remote\" 'management'`),
    'Breeze &amp; &lt;fast&gt; &quot;remote&quot; &#39;management&#39;',
  );
});

test('identifies GitHub bot account types and login suffixes', () => {
  assert.equal(isBot({ login: 'release-service', type: 'Bot' }), true);
  assert.equal(isBot({ login: 'dependabot[bot]', type: 'User' }), true);
  assert.equal(isBot({ login: 'octocat', type: 'User' }), false);
});

test('renders linked, escaped, fixed-size accessible avatars', () => {
  assert.equal(
    renderGallery([
      {
        login: 'ada',
        name: `Ada <Lovelace> & \"Friends\"`,
        avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
        url: 'https://github.com/ada?tab=overview&from=gallery',
      },
      {
        login: `grace'o`,
        avatarUrl: 'https://avatars.githubusercontent.com/u/2',
        url: 'https://github.com/grace-o',
      },
    ], 'No community members yet.'),
    '<a href="https://github.com/ada?tab=overview&amp;from=gallery"><img src="https://avatars.githubusercontent.com/u/1?v=4&amp;s=128" width="64" height="64" alt="Ada &lt;Lovelace&gt; &amp; &quot;Friends&quot;" title="Ada &lt;Lovelace&gt; &amp; &quot;Friends&quot; (@ada)" /></a>\n'
      + '<a href="https://github.com/grace-o"><img src="https://avatars.githubusercontent.com/u/2?s=128" width="64" height="64" alt="grace&#39;o" title="grace&#39;o (@grace&#39;o)" /></a>',
  );
});

test('renders the supplied empty state when the account list is empty', () => {
  assert.equal(renderGallery([], '_Be the first sponsor._'), '_Be the first sponsor._');
});

test('replaces exactly one marker pair', () => {
  const source = 'before\n<!-- sponsors:start -->\nold\n<!-- sponsors:end -->\nafter\n';
  assert.equal(
    replaceMarkedBlock(source, 'sponsors', 'new'),
    'before\n<!-- sponsors:start -->\nnew\n<!-- sponsors:end -->\nafter\n',
  );
  assert.throws(() => replaceMarkedBlock('missing', 'sponsors', 'new'), /exactly one/);
});

test('rejects duplicated or reversed marker pairs', () => {
  assert.throws(
    () => replaceMarkedBlock(
      '<!-- sponsors:start -->\nfirst\n<!-- sponsors:start -->\nsecond\n<!-- sponsors:end -->',
      'sponsors',
      'new',
    ),
    /exactly one/,
  );
  assert.throws(
    () => replaceMarkedBlock(
      '<!-- sponsors:start -->\nfirst\n<!-- sponsors:end -->\nsecond\n<!-- sponsors:end -->',
      'sponsors',
      'new',
    ),
    /exactly one/,
  );
  assert.throws(
    () => replaceMarkedBlock(
      '<!-- sponsors:end -->\nold\n<!-- sponsors:start -->',
      'sponsors',
      'new',
    ),
    /exactly one/,
  );
});
