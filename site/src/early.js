// Tiny early switch: lets the page hide things that animate in, before they flash.
// If the page script never starts (very old browser, blocked file), show everything after 4 s.
(function () {
  var d = document.documentElement;
  d.classList.add('js');
  try {
    if (!window.matchMedia || !matchMedia('(prefers-reduced-motion: reduce)').matches) d.classList.add('motion');
  } catch (e) {}
  setTimeout(function () {
    if (!d.classList.contains('page-ok')) d.classList.remove('js', 'motion');
  }, 4000);
})();
