(function () {
  function applyTheme() {
    var t = localStorage.getItem('theme');
    var dark =
      t === 'dark' ||
      (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
  }

  // Apply data-density on <html> before first paint so page-level CSS
  // density rules in globals.css take effect without a flash of the
  // comfortable layout. Mirrors breeze.density localStorage key set by
  // apps/web/src/lib/density.ts. Default is comfortable (no attribute
  // needed, but we set it for consistency / selector simplicity).
  function applyDensity() {
    var d = localStorage.getItem('breeze.density');
    if (d !== 'comfortable' && d !== 'compact' && d !== 'dense') {
      d = 'comfortable';
    }
    document.documentElement.setAttribute('data-density', d);
  }

  applyTheme();
  applyDensity();

  if (!window.__themeSwap) {
    window.__themeSwap = true;
    document.addEventListener('astro:after-swap', function () {
      applyTheme();
      applyDensity();
      var main = document.querySelector('main');
      if (main) main.scrollTop = 0;
    });
  }
})();
