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

// ---- how it works: three steps and one example card that fills in as they go ----
// Wide screens: the panel stays put while you scroll (CSS sticky, no scroll-jacking). The line on the left
// fills, each step lights up when the line reaches it, and the card adds that step's part. Nothing is taken
// away, so the last stop shows the whole story at once.
// Phones: three blocks one after another. Each gets its own copy of the card holding everything up to that
// step, fades in as it arrives, and its dot lights when it reaches the middle of the screen.
const HOW_PINNED = '(min-width: 900px) and (min-height: 561px)'; // same as the sticky rule in styles.css
const HOW_WIDE = '(min-width: 900px)';
const HOW_STARTS = [0, 0.28, 0.64]; // where steps 1, 2 and 3 start, as a share of the pinned scroll

function setupHow() {
  const section = document.getElementById('how');
  const track = section && section.querySelector('.how-track');
  if (!track) return null;
  const steps = Array.from(track.querySelectorAll('.how-step'));
  const nodes = steps.map((step) => step.querySelector('.how-node') || step);
  const demo = track.querySelector('.how-demo');
  const parts = demo ? Array.from(demo.querySelectorAll('[data-at]')) : [];
  const atOf = (el) => Number(el.getAttribute('data-at')) || 1;
  const query = (q) => {
    try { return window.matchMedia ? window.matchMedia(q) : null; } catch (e) { return null; }
  };
  const pinnedQ = query(HOW_PINNED);
  const wideQ = query(HOW_WIDE);

  // The phone copies: step N's card holds the parts of steps 1..N.
  if (demo) {
    steps.forEach((step, i) => {
      const body = step.querySelector('.how-body') || step;
      if (body.querySelector('.how-mini')) return;
      const mini = demo.cloneNode(true);
      mini.classList.remove('how-demo');
      mini.classList.add('how-mini');
      mini.querySelectorAll('[data-at]').forEach((el) => {
        if (atOf(el) > i + 1) el.remove();
        else el.classList.add('is-on');
      });
      body.appendChild(mini);
    });
  }

  function paint(active, fills, done) {
    steps.forEach((step, i) => {
      step.classList.toggle('is-active', i === active);
      step.classList.toggle('is-done', done ? true : i < active);
      step.style.setProperty('--fill', clamp(fills[i], 0, 1).toFixed(3));
    });
  }

  // Everything showing, nothing moving (reduced motion, short windows that don't pin).
  function makeStatic() {
    section.classList.remove('is-pinned');
    steps.forEach((step) => step.classList.add('is-seen'));
    paint(-1, steps.map(() => 1), true);
    parts.forEach((el) => el.classList.add('is-on'));
  }

  function update() {
    if (!steps.length) return;
    if (!document.documentElement.classList.contains('motion')) {
      makeStatic();
      return;
    }
    const vh = window.innerHeight;
    const pinned = pinnedQ ? pinnedQ.matches : false;
    const wide = wideQ ? wideQ.matches : viewportWidth() >= 900;
    section.classList.toggle('is-pinned', pinned);

    if (pinned) {
      const rect = track.getBoundingClientRect();
      const p = clamp(-rect.top / Math.max(1, rect.height - vh), 0, 1);
      // Nothing is lit while the panel is still sliding up into view; step 1 lights once it's well in.
      let active = -1;
      if (rect.top < vh * 0.45) {
        active = 0;
        while (active < steps.length - 1 && p >= HOW_STARTS[active + 1]) active++;
      }
      const fills = steps.map((_, i) => {
        const from = HOW_STARTS[i];
        const to = HOW_STARTS[i + 1];
        return to === undefined ? 1 : (p - from) / (to - from);
      });
      steps.forEach((step) => step.classList.add('is-seen'));
      paint(active, fills, false);
      parts.forEach((el) => el.classList.toggle('is-on', atOf(el) <= active + 1));
      return;
    }

    if (wide) {
      makeStatic();
      return;
    }

    // Phones: a reading line a bit below the middle of the screen lights the dots and fills the line.
    const line = vh * 0.62;
    const boxes = nodes.map((node) => node.getBoundingClientRect());
    let active = -1;
    steps.forEach((step, i) => {
      if (step.getBoundingClientRect().top < vh * 0.9) step.classList.add('is-seen');
      if (boxes[i].top + boxes[i].height / 2 < line) active = i;
    });
    const fills = steps.map((_, i) => {
      const next = boxes[i + 1];
      if (!next) return 1;
      const from = boxes[i].bottom;
      return (line - from) / Math.max(1, next.top - from);
    });
    paint(active, fills, false);
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
