// Stickers in the hero: a trail behind the mouse on desktop, a few pops where you tap on phones.
// Rules: hero only; never on top of the paste box (its box + 16px is off limits); never catch clicks;
// each one lives SETTINGS.stickers.lifetimeSeconds (the last fadeSeconds fading); at most maxOnScreen.
import { SETTINGS } from '../../settings.js';
import { randomSticker } from './stickers.js';
import { prefersReducedMotion } from './motion.js';

const INTERACTIVE = 'a, button, input, select, textarea, label, summary, form, [role="button"], [contenteditable]';
const positive = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);
const rand = (lo, hi) => lo + Math.random() * (hi - lo);

// hero:   the section the stickers live in
// avoid:  elements stickers must never cover (the paste form block)
export function initTrail(hero, { avoid = [], margin = 16, settings = SETTINGS } = {}) {
  if (!hero) return null;
  const cfg = (settings && settings.stickers) || {};
  const spacing = positive(cfg.spacingPx, 90);
  const life = positive(cfg.lifetimeSeconds, 2.5) * 1000;
  const fade = Math.min(life, positive(cfg.fadeSeconds, 0.5) * 1000);
  const max = Math.max(1, Math.round(positive(cfg.maxOnScreen, 12)));
  const perTap = Math.max(1, Math.round(positive(cfg.tapCount, 3)));
  const fineHover = window.matchMedia('(hover: hover) and (pointer: fine)');

  let layer = hero.querySelector('.sticker-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'sticker-layer';
    layer.setAttribute('aria-hidden', 'true');
    hero.prepend(layer);
  }

  const live = [];
  let seed = Date.now() % 1000003;
  let last = null;
  let travelled = 0;
  let lastPointer = '';

  // Off-limits boxes, in the layer's coordinates, grown by `margin` on every side.
  function zones(layerRect) {
    const out = [];
    for (const el of avoid) {
      if (!el || !el.getBoundingClientRect) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      out.push({
        l: r.left - layerRect.left - margin,
        t: r.top - layerRect.top - margin,
        r: r.right - layerRect.left + margin,
        b: r.bottom - layerRect.top + margin,
      });
    }
    return out;
  }

  // Centre point for a sticker whose rotated bounding box is bw x bh, or null to skip it.
  // If it would touch an off-limits box, nudge it just outside (up, down, left or right,
  // whichever is closest); if that is too far from the cursor, skip it.
  function place(x, y, bw, bh, blocked) {
    const hit = (cx, cy) => blocked.some((z) =>
      cx - bw / 2 < z.r && cx + bw / 2 > z.l && cy - bh / 2 < z.b && cy + bh / 2 > z.t);
    if (!hit(x, y)) return { x, y };
    const limit = Math.max(bw, bh) * 0.9;
    const options = [];
    for (const z of blocked) {
      options.push({ x, y: z.t - bh / 2 - 0.5 }, { x, y: z.b + bh / 2 + 0.5 },
        { x: z.l - bw / 2 - 0.5, y }, { x: z.r + bw / 2 + 0.5, y });
    }
    options.sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y));
    for (const o of options) {
      if (Math.hypot(o.x - x, o.y - y) > limit) break;
      if (!hit(o.x, o.y)) return o;
    }
    return null;
  }

  function drop(item) {
    clearTimeout(item.timer);
    item.el.remove();
    const i = live.indexOf(item);
    if (i >= 0) live.splice(i, 1);
  }

  function clear() {
    while (live.length) drop(live[0]);
  }

  // clientX/clientY: where the sticker should be centred (viewport coordinates).
  function spawn(clientX, clientY) {
    let sticker;
    try {
      sticker = randomSticker(seed++, settings);
    } catch (e) {
      return null;
    }
    if (!sticker || typeof sticker.svg !== 'string') return null;
    const w = positive(sticker.width, 150);
    const h = positive(sticker.height, 80);
    const angle = rand(-14, 14);
    const rad = (angle * Math.PI) / 180;
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    const bw = w * cos + h * sin;
    const bh = w * sin + h * cos;

    const layerRect = layer.getBoundingClientRect();
    const spot = place(clientX - layerRect.left, clientY - layerRect.top, bw, bh, zones(layerRect));
    if (!spot) return null;

    const el = document.createElement('div');
    el.className = 'sticker';
    el.style.width = w + 'px';
    el.style.height = h + 'px';
    el.style.transform = `translate(${(spot.x - w / 2).toFixed(1)}px, ${(spot.y - h / 2).toFixed(1)}px) rotate(${angle.toFixed(1)}deg)`;
    el.style.setProperty('--fade', fade + 'ms');
    el.style.setProperty('--fade-delay', life - fade + 'ms');
    const inner = document.createElement('div');
    inner.className = 'sticker-in';
    inner.innerHTML = sticker.svg; // our own SVG from stickers.js
    el.appendChild(inner);
    layer.appendChild(el);

    const item = { el, timer: 0 };
    item.timer = setTimeout(() => drop(item), life);
    live.push(item);
    while (live.length > max) drop(live[0]);
    return el;
  }

  // Desktop trail: one sticker per `spacing` px of mouse travel.
  hero.addEventListener('pointermove', (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    if (!fineHover.matches || prefersReducedMotion()) {
      last = null;
      return;
    }
    const x = e.pageX;
    const y = e.pageY;
    if (!last) {
      last = { x, y };
      return;
    }
    travelled += Math.hypot(x - last.x, y - last.y);
    last = { x, y };
    if (travelled >= spacing) {
      travelled = 0;
      spawn(e.clientX, e.clientY);
    }
  }, { passive: true });
  hero.addEventListener('pointerleave', () => {
    last = null;
    travelled = 0;
  });

  // Phones: a few stickers where the visitor taps (not on the input, buttons or links).
  hero.addEventListener('pointerdown', (e) => {
    lastPointer = e.pointerType || '';
  }, { passive: true });
  hero.addEventListener('click', (e) => {
    if (prefersReducedMotion()) return;
    const touch = lastPointer === 'touch' || lastPointer === 'pen' || (!lastPointer && !fineHover.matches);
    if (!touch) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target && target.closest(INTERACTIVE)) return;
    if (target && avoid.some((el) => el && el.contains(target))) return;
    const x = e.clientX;
    const y = e.clientY;
    for (let i = 0; i < perTap; i++) {
      setTimeout(() => spawn(x + (i ? rand(-70, 70) : 0), y + (i ? rand(-56, 56) : 0)), i * 90);
    }
  });

  try {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => { if (mq.matches) clear(); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  } catch (e) { /* ignore */ }

  return { spawn, clear, count: () => live.length, layer };
}
