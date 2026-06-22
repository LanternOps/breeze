(function () {
  // Preserve Monaco's runtime theme colors across Astro View-Transition swaps
  // (issue #1589, follow-up to #1186 and the partial #1593 fix).
  //
  // Monaco appends its theme colors — vs-dark token colors, editor background,
  // selection background — as a runtime <style class="monaco-colors"> in
  // document.head, distinct from the structural editor.main.css <link> that
  // #1186 made swap-safe. Astro rebuilds <head> from the incoming page's markup
  // on a View-Transition swap, dropping that runtime style, and Monaco's
  // module-singleton theme service won't re-inject it for the recreated editor
  // (it creates the global style element only once and short-circuits setTheme
  // when the theme is unchanged). The editor then renders un-themed: white
  // background, white text, invisible selection — until a full refresh.
  //
  // #1593 cloned the style forward but registered the listener INSIDE the React
  // editor component (ScriptForm), so it was absent on the one navigation that
  // actually fails: scripts-LIST -> editor, where ScriptForm is unmounted on the
  // list page. This handler lives in the always-present Layout head instead, so
  // it clones the style forward on EVERY swap regardless of which page or island
  // is mounted. The style "rides along" through intermediate pages (list, etc.)
  // to the next editor mount. Harmless elsewhere: the rules only match
  // .monaco-editor descendants, which don't exist outside the editor.
  if (window.__monacoThemePersist) return;
  window.__monacoThemePersist = true;

  document.addEventListener('astro:before-swap', function (event) {
    var newDocument = event.newDocument;
    if (!newDocument) return;
    if (newDocument.head.querySelector('style.monaco-colors')) return;
    var live = document.head.querySelector('style.monaco-colors');
    if (!live) return;
    var clone = newDocument.createElement('style');
    clone.className = 'monaco-colors';
    clone.textContent = live.textContent;
    newDocument.head.appendChild(clone);
  });
})();
