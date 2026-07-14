export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

export function isBot(account) {
  return account.type === 'Bot' || account.login.endsWith('[bot]');
}

export function renderGallery(accounts, emptyMarkdown) {
  if (accounts.length === 0) {
    return emptyMarkdown;
  }

  return accounts.map((account) => {
    const displayName = account.name || account.login;
    const avatarUrl = new URL(account.avatarUrl);
    avatarUrl.searchParams.set('s', '128');

    return '<a href="' + escapeHtml(account.url) + '">'
      + '<img src="' + escapeHtml(avatarUrl.toString()) + '"'
      + ' width="64" height="64"'
      + ' alt="' + escapeHtml(displayName) + '"'
      + ' title="' + escapeHtml(displayName + ' (@' + account.login + ')') + '" />'
      + '</a>';
  }).join('\n');
}

export function replaceMarkedBlock(markdown, name, content) {
  const start = '<!-- ' + name + ':start -->';
  const end = '<!-- ' + name + ':end -->';
  if (markdown.split(start).length !== 2
      || markdown.split(end).length !== 2
      || markdown.indexOf(start) > markdown.indexOf(end)) {
    throw new Error('README must contain exactly one ordered ' + name + ' marker pair');
  }
  return markdown.slice(0, markdown.indexOf(start))
    + start + '\n' + content + '\n' + end
    + markdown.slice(markdown.indexOf(end) + end.length);
}
