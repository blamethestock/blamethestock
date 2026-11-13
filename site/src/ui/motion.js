// Page motion: headline fit + white-block wipe, fade-and-rise reveals, the sliding giant line,
// and the three how-it-works stops. Importing this file does nothing by itself
// (the font preview page reuses fitLines); page.js calls initMotion().

const REDUCE_QUERY = '(prefers-reduced-motion: reduce)';

export function prefersReducedMotion() {
  try {
    return !!(window.matchMedia && window.matchMedia(REDUCE_QUERY).matches);
  } catch (e) {
    return false;
  }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const viewportWidth = () => document.documentElement.clientWidth || window.innerWidth;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Scale box's font-size so the WIDEST of `lines` ends up `targetWidth` px wide.
// Measures at a fixed size, then scales (letter-spacing is in em, so width is linear in size).
// offsetWidth ignores CSS transforms, so this also works inside scaled preview frames.
export function fitLines(box, lines, targetWidth, { maxSize = Infinity, minSize = 0 } = {}) {
  const els = Array.from(lines || []);
  if (!box || !els.length || !(targetWidth > 0)) return 0;
  const widest = () => els.reduce((w, el) => Math.max(w, el.offsetWidth), 0);
  let size = 200;
  // Two passes: fonts with an optical-size axis change shape with size, so measure again once.
  for (let pass = 0; pass < 2; pass++) {
    box.style.fontSize = size.toFixed(2) + 'px';
    const w = widest();
    if (!w) return 0;
    const next = clamp((size * targetWidth) / w, minSize, maxSize);
    if (Math.abs(next - size) / size < 0.004) break;
    size = next;
  }
  box.style.fontSize = size.toFixed(2) + 'px';
  return size;
}

function fitHeadline(headline, ratio) {
  const lines = headline.querySelectorAll('.line-text');
  if (!lines.length) return;
  // The paste box must be fully on screen on first load. On normal screens (and every phone
  // held upright) the 90%-width rule wins; on wide, short windows the headline shrinks a bit instead.
  const lineHeight = parseFloat(getComputedStyle(headline).getPropertyValue('--head-lh')) || 0.83;
  const form = document.getElementById('paste-form');
  const tool = document.getElementById('hero-tool');
  let maxSize = Infinity;
  if (form && tool) {
    const top = headline.getBoundingClientRect().top + window.scrollY;
    const below = (parseFloat(getComputedStyle(tool).marginTop) || 0) + form.offsetHeight + 24;
    maxSize = (window.innerHeight - top - below) / (lines.length * lineHeight);
  }
  fitLines(headline, lines, viewportWidth() * ratio, { maxSize: Math.max(48, maxSize) });
}

// Big single words (footer wordmark, token ticker): <p data-fit="0.995" data-fit-max="220"><span class="fit-text">
function fitBlocks() {
  document.querySelectorAll('[data-fit]').forEach((box) => {
    const text = box.querySelector('.fit-text');
    if (!text || !text.textContent.trim() || !box.clientWidth) return;
    const share = parseFloat(box.getAttribute('data-fit')) || 1;
    const maxSize = parseFloat(box.getAttribute('data-fit-max')) || Infinity;
    fitLines(box, [text], box.clientWidth * share, { maxSize });
  });
}

// ---- reveals ----
function setupReveals(reduce) {
  const els = Array.from(document.querySelectorAll('[data-reveal]'));
  if (reduce || !('IntersectionObserver' in window)) {
    els.forEach((el) => el.classList.add('is-in'));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        }
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.01 },
  );
  els.forEach((el) => io.observe(el));
}

// ---- how it works: three stops while the panel is pinned (CSS sticky, no scroll-jacking) ----
function setupHow() {
  const track = document.querySelector('#how .how-track');
  if (!track) return null;
  const steps = Array.from(track.querySelectorAll('.how-step'));
  const bars = Array.from(track.querySelectorAll('.how-progress span'));
  let current = -1;

  function show(index) {
    if (index === current) return;
    current = index;
    steps.forEach((step, i) => {
      step.classList.toggle('is-active', i === index);
      step.classList.toggle('is-before', i < index);
    });
  }
  function update() {
    if (!document.documentElement.classList.contains('motion') || !steps.length) return;
    const rect = track.getBoundingClientRect();
    const scrollable = Math.max(1, rect.height - window.innerHeight);
    const p = clamp(-rect.top / scrollable, 0, 1);
    const n = steps.length;
    show(Math.min(n - 1, Math.floor(p * n)));
    bars.forEach((bar, i) => bar.style.setProperty('--p', clamp(p * n - i, 0, 1).toFixed(3)));
  }
  function makeStatic() {
    current = -1;
    steps.forEach((step) => {
      step.classList.add('is-active');
      step.classList.remove('is-before');
    });
  }
  return { update, makeStatic };
}

// ---- the giant line that slides sideways with the scroll ----
function setupMarquee() {
  const section = document.getElementById('marquee');
  const line = document.getElementById('marquee-line');
  if (!section || !line || section.hidden) return null;
  let visible = !('IntersectionObserver' in window);
  let copyWidth = 0;

  function measure() {
    const first = line.firstElementChild;
    copyWidth = first ? first.offsetWidth : line.offsetWidth;
  }
  function update() {
    if (!visible || !document.documentElement.classList.contains('motion')) return;
    if (!copyWidth) measure();
    const rect = section.getBoundingClientRect();
    const vh = window.innerHeight;
    const p = clamp((vh - rect.top) / (vh + rect.height), 0, 1);
    const travel = Math.min(copyWidth, viewportWidth() * 1.25);
    line.style.transform = `translate3d(${(-p * travel).toFixed(1)}px, 0, 0)`;
  }
  function reset() {
    line.style.transform = '';
  }
  if (!visible) {
    new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) update();
    }).observe(section);
  }
  return { update, measure, reset };
}

// ---- main ----
// opts.ratio      share of the screen width the wider headline line fills (SETTINGS.headline.widthOfScreen)
// opts.fontReady  promise that settles when the chosen web font has loaded (or failed)
export function initMotion({ ratio = 0.9, fontReady = Promise.resolve() } = {}) {
  const root = document.documentElement;
  const reduce = prefersReducedMotion();
  root.classList.toggle('motion', !reduce);
  const widthRatio = typeof ratio === 'number' && ratio >= 0.3 && ratio <= 1 ? ratio : 0.9;

  const headline = document.getElementById('headline');
  const how = setupHow();
  const marquee = setupMarquee();

  const fitAll = () => {
    if (headline) fitHeadline(headline, widthRatio);
    fitBlocks();
    if (marquee) marquee.measure();
  };
  fitAll();

  // Headline reveal: wait for the web font (max 1.6 s) so the wipe uncovers the real letters.
  if (headline) {
    if (reduce) {
      headline.classList.remove('is-waiting');
    } else {
      headline.classList.add('is-waiting');
    }
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      fitAll();
      headline.classList.remove('is-waiting');
      if (!reduce && !prefersReducedMotion()) {
        void headline.offsetWidth; // restart point for the CSS animation
        headline.classList.add('is-revealing');
      }
    };
    Promise.race([Promise.resolve(fontReady).catch(() => {}), wait(1600)]).then(start);
  }

  setupReveals(reduce);
  if (reduce && how) how.makeStatic();

  // One rAF-throttled loop for everything that follows the scroll position.
  let queued = false;
  const tick = () => {
    queued = false;
    if (how) how.update();
    if (marquee) marquee.update();
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(tick);
  };
  window.addEventListener('scroll', schedule, { passive: true });

  // Refit when the width changes (phones change height while scrolling; ignore small height changes).
  let lastW = viewportWidth();
  let lastH = window.innerHeight;
  let resizeQueued = false;
  window.addEventListener('resize', () => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      const w = viewportWidth();
      const h = window.innerHeight;
      if (w !== lastW || Math.abs(h - lastH) > 120) {
        lastW = w;
        lastH = h;
        fitAll();
      }
      tick();
    });
  }, { passive: true });

  // A late font swap changes letter widths: measure again.
  if (document.fonts && document.fonts.addEventListener) {
    document.fonts.addEventListener('loadingdone', () => { fitAll(); tick(); });
  }

  // Reduced motion switched on while the page is open: drop to the still version right away.
  try {
    const mq = window.matchMedia(REDUCE_QUERY);
    const onChange = () => {
      if (!mq.matches) return;
      root.classList.remove('motion');
      if (headline) headline.classList.remove('is-waiting', 'is-revealing');
      document.querySelectorAll('[data-reveal]').forEach((el) => el.classList.add('is-in'));
      if (marquee) marquee.reset();
      if (how) how.makeStatic();
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  } catch (e) { /* old browser: nothing to do */ }

  tick();
  return { fitAll, update: tick, reduce };
}
