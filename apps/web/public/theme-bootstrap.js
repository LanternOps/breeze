(function () {
  function applyTheme() {
    var t = localStorage.getItem('theme');
    var dark =
      t === 'dark' ||
      (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
  }

  applyTheme();

  if (!window.__themeSwap) {
    window.__themeSwap = true;
    document.addEventListener('astro:after-swap', function () {
      applyTheme();
      var main = document.querySelector('main');
      if (main) main.scrollTop = 0;
    });
  }
})();
