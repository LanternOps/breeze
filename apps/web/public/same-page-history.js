(function () {
  // Same-page history claims: the first popstate listener on window, so a page
  // can take Back / Forward between two of its own entries (a ticket opened
  // from the tickets board) before Astro's <ClientRouter /> does.
  //
  // The router treats every popstate onto an entry with state as a
  // navigation. For a step that stays on the same page it only skips the
  // re-fetch when the location it last moved to carries a hash
  // (astro dist/transitions/router.js, transition()); otherwise it re-fetches
  // the page and swaps it in, remounting every island and losing their state.
  //
  // Chromium runs window listeners in registration order, capture or not, so
  // a listener an island adds always runs after the router's, too late to
  // stop it. This classic script runs while the document is parsed, before
  // the router module, so its listener runs first. An island registers a
  // claim (lib/samePageHistory.ts); a claim that returns true has handled the
  // step, and the router and every later listener never see it.
  //
  // Loaded by every layout that renders <ClientRouter />: the router is
  // installed by the first page a session loads (often /login, which then
  // soft-navigates in), and a script that first runs after a soft swap would
  // register behind it.
  if (window.__breezeSamePageHistory) return;
  var claims = [];
  window.__breezeSamePageHistory = {
    claim: function (fn) {
      claims.push(fn);
      return function () {
        var index = claims.indexOf(fn);
        if (index >= 0) claims.splice(index, 1);
      };
    },
  };
  window.addEventListener(
    'popstate',
    function (event) {
      var current = claims.slice();
      for (var i = 0; i < current.length; i++) {
        var handled = false;
        try {
          handled = current[i](event) === true;
        } catch (err) {
          console.error('[same-page-history] A claim failed:', err);
        }
        if (handled) {
          event.stopImmediatePropagation();
          return;
        }
      }
    },
    true
  );
})();
