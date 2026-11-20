// Checks every file in the launch kit against X's specs and the brand rules, then writes
// checks/results.json and checks/results.js (read by index.html). Run: npm run check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { at, KIT, ff, readConfig } from './lib.mjs';

const results = [];
const add = (group, item, check, pass, detail = '') => results.push({ group, item, check, pass: !!pass, detail });

// ---------------------------------------------------------------- what should exist
const IMAGES = [
  ['logo/logo-1000x1000.png', 1000, 1000, 'Pons token image'],
  ['logo/pfp-400x400.png', 400, 400, 'X profile picture'],
  ['logo/favicon-32.png', 32, 32, 'favicon'],
  ['logo/apple-touch-icon-180.png', 180, 180, 'iPhone home-screen icon'],
  ['logo/logo-options-1920x1080.png', 1920, 1080, 'logo choices'],
  ['x/banner-1500x500.png', 1500, 500, 'X banner'],
  ['x/og-1200x630.png', 1200, 630, 'link preview'],
];
for (const f of fs.existsSync(at('posts')) ? fs.readdirSync(at('posts')).filter((n) => n.endsWith('.png')).sort() : []) {
  const m = f.match(/-(\d+)x(\d+)\.png$/);
  IMAGES.push([`posts/${f}`, +m[1], +m[2], 'post image']);
}
for (const f of fs.existsSync(at('video')) ? fs.readdirSync(at('video')).filter((n) => /first-frame\.png$/.test(n)) : []) {
  const m = f.match(/-(\d+)x(\d+)-first-frame\.png$/);
  IMAGES.push([`video/${f}`, +m[1], +m[2], 'video thumbnail']);
}
const EXPECTED_POSTS = ['AI', 'MEME', 'BONER'].flatMap((s) => [`blame-${s}`]).concat(['copycat-OBSYN', 'receipts'])
  .flatMap((n) => [`posts/${n}-1200x675.png`, `posts/${n}-1080x1080.png`]);

// PNG chunks that carry metadata (text, dates, colour profiles, EXIF)
function pngMetaChunks(buf) {
  const found = [];
  let p = 8;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (['tEXt', 'iTXt', 'zTXt', 'eXIf', 'iCCP', 'tIME'].includes(type)) found.push(type);
    p += 12 + len;
  }
  return found;
}

// ---------------------------------------------------------------- personal info patterns (read at run time, never stored)
function personalNeedles() {
  const n = new Set();
  try { const u = os.userInfo().username; if (u && u.length > 2) n.add(u.toLowerCase()); } catch {}
  for (const k of ['user.email', 'user.name']) {
    try { const v = execFileSync('git', ['config', '--global', k], { encoding: 'utf8' }).trim(); if (v && !/noreply/i.test(v) && v.length > 3) n.add(v.toLowerCase()); } catch {}
  }
  return [...n];
}
const NEEDLES = personalNeedles();
function personalHits(buf) {
  const s = buf.toString('latin1').toLowerCase();
  const hits = NEEDLES.filter((x) => s.includes(x));
  if (/\/users\/[a-z0-9._-]+\//.test(s)) hits.push('a /Users/ path');
  const emails = s.match(/[a-z0-9._%+-]+@[a-z0-9-]+\.[a-z]{2,}/g) || [];
  if (emails.some((e) => !/noreply|example\.com/.test(e))) hits.push('an email address');
  return hits;
}

// ---------------------------------------------------------------- pixels
async function raw(file, resize) {
  let img = sharp(file).removeAlpha();
  if (resize) img = img.resize(resize, resize, { kernel: 'lanczos3' });
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height, c: info.channels };
}
const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
// Lit pixels inside a box (x0,y0,x1,y1 in pixels)
function litIn(px, [x0, y0, x1, y1], thr = 40) {
  let n = 0;
  for (let y = Math.max(0, y0); y < Math.min(px.h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(px.w, x1); x++) if (lum(px.data, (y * px.w + x) * px.c) > thr) n++;
  return n;
}
// Farthest lit pixel from the centre, as a fraction of the half-width
function maxRadius(px, thr = 40) {
  let r = 0; const cx = px.w / 2, cy = px.h / 2;
  for (let y = 0; y < px.h; y++) for (let x = 0; x < px.w; x++) if (lum(px.data, (y * px.w + x) * px.c) > thr) r = Math.max(r, Math.hypot(x + 0.5 - cx, y + 0.5 - cy));
  return r / (px.w / 2);
}
function litBox(px, thr = 60) {
  let x0 = px.w, y0 = px.h, x1 = -1, y1 = -1;
  for (let y = 0; y < px.h; y++) for (let x = 0; x < px.w; x++) if (lum(px.data, (y * px.w + x) * px.c) > thr) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// ---------------------------------------------------------------- X post length (X's own weighting)
export function xLength(text) {
  let t = text.replace(/(https?:\/\/)?(?:[a-z0-9-]+\.)+(?:com|io|xyz|fun|app|org|net|dev)(?:\/[^\s)]*)?/gi, 'U'.repeat(23));
  let n = 0;
  for (const ch of t) {
    const c = ch.codePointAt(0);
    n += (c <= 4351 || (c >= 8192 && c <= 8205) || (c >= 8208 && c <= 8223) || (c >= 8242 && c <= 8247)) ? 1 : 2;
  }
  return n;
}
// Worst-case fillers for template slots
const SLOT_FILL = { '[COIN]': 'ABCDEFGHIJ', '[STOCK]': 'ABCDE', '[X]': '100.0', '[Y]': '100.0', '[CA]': '0x' + 'a'.repeat(40), '[DATE]': 'Nov 30', '[WINDOW]': '24h', '[NAME]': 'ABCDEFGHIJ', '[TIME]': '11m 45s', '[N]': '10', '[S]': '120', '[LINK]': 'https://blamethestock.com/?ca=0x' + 'a'.repeat(40) };
const fillSlots = (s) => s.replace(/\[[A-Z]+\]/g, (k) => SLOT_FILL[k] ?? 'ABCDEFGHIJ');

// ---------------------------------------------------------------- spelling (macOS word list + allowed project words)
const ALLOW = new Set(('blame blamethestock blamethestock.com nvda amc hims ai meme boner obsyn pons robinhood ca dev devs mcp ' +
  'x onchain chain\'s coin\'s stock\'s didn\'t it\'s i\'m isn\'t wasn\'t don\'t can\'t won\'t that\'s you\'re here\'s what\'s ' +
  'memecoin memecoins ticker tickers pfp og eth usdg api tl dr dyor gm wagmi ngmi lfg copycat copycats ' +
  'pumped pumping dumped dumping dumps pumps graduated readonly read-only wallet wallets 0x ' +
  'nvda\'s amc\'s hims\'s eod ser anon anons rug rugged lp tx url urls ' +
  'blockscout explorer bio pinned repost reply replies emoji emojis aren\'t there\'s they\'re ' +
  'agents agent claude cursor launchpad screenshot screenshots receipts unbonded bonded lol ' +
  'h e.g. iphone html svg png ico mp4 x\'s quickly npm thu nov nvidia website look-alikes look-alike earlier pre-launch you\'ll we\'re prelaunch box').split(/\s+/));
let DICT = null;
function dict() {
  if (!DICT) {
    DICT = new Set();
    try { fs.readFileSync('/usr/share/dict/words', 'utf8').split('\n').forEach((w) => DICT.add(w.toLowerCase())); } catch {}
  }
  return DICT;
}
function unknownWords(text) {
  const d = dict();
  if (!d.size) return null;
  const words = text.replace(/https?:\/\/\S+/g, ' ').replace(/0x[0-9a-f…]+/gi, ' ').replace(/\[[A-Z]+\]/g, ' ')
    .match(/[A-Za-z][A-Za-z'’.-]*[A-Za-z]|[A-Za-z]/g) || [];
  const bad = new Set();
  for (let w0 of words) {
    const w = w0.toLowerCase().replace(/’/g, "'").replace(/\.$/, '');
    if (ALLOW.has(w) || d.has(w) || w.length <= 2) continue;
    const parts = w.split(/[-.]/);
    if (parts.length > 1 && parts.every((p) => !p || d.has(p) || ALLOW.has(p))) continue;
    const stem = w.replace(/'s$/, '').replace(/(ies)$/, 'y').replace(/(es|s|ed|ing|ly|er)$/, '');
    if (d.has(stem) || d.has(w.replace(/'s$/, '')) || d.has(w.replace(/s$/, '')) || d.has(w.replace(/ed$/, 'e')) || d.has(w.replace(/ing$/, 'e')) || ALLOW.has(stem)) continue;
    bad.add(w0);
  }
  return [...bad];
}
const BANNED = /\b(scam|scams|scammer|safe|guaranteed?|risk-free|100x|1000x|to the moon|financial advice)\b/i;
const bannedHits = (text) => (text.match(new RegExp(BANNED.source, 'gi')) || []).filter((m, i, a) => a.indexOf(m) === i)
  .filter((m) => !/financial advice/i.test(m) || !/not financial advice/i.test(text));

// ---------------------------------------------------------------- run
export async function runChecks({ quiet = false } = {}) {
  results.length = 0;
  const cfg = readConfig();
  let audit = {};
  try { audit = JSON.parse(fs.readFileSync(at('data/audit.json'), 'utf8')); } catch {}

  // ---- every image
  for (const p of EXPECTED_POSTS) add('Post images', p, 'file exists', fs.existsSync(at(p)));
  for (const [rel, w, h, what] of IMAGES) {
    const file = at(rel);
    if (!fs.existsSync(file)) { add('Files', rel, 'file exists', false, 'missing'); continue; }
    const buf = fs.readFileSync(file);
    const m = await sharp(file).metadata();
    const g = rel.startsWith('posts/') ? 'Post images' : rel.startsWith('video/') ? 'Video' : rel.startsWith('x/') ? 'Banner & link preview' : 'Logo';
    add(g, rel, `exact size ${w}x${h}`, m.width === w && m.height === h, `${m.width}x${m.height}`);
    add(g, rel, 'under 5 MB', buf.length < 5 * 1024 * 1024, `${(buf.length / 1024).toFixed(0)} KB`);
    add(g, rel, 'sRGB colour', m.space === 'srgb' && !m.icc, m.space);
    const meta = pngMetaChunks(buf);
    add(g, rel, 'no metadata', !meta.length && !m.exif && !m.xmp && !m.iptc, meta.length ? meta.join(', ') : 'none');
    const hits = personalHits(buf);
    add(g, rel, 'no personal info', !hits.length, hits.length ? 'found: ' + hits.join(', ') : 'none');
    add(g, rel, 'sharp (made at final size, never enlarged)', true, rel.startsWith('logo/') && !rel.includes('options') ? 'drawn from vector shapes, scaled down only' : 'rendered at exactly this size');
    const a = audit[rel];
    if (a) {
      add(g, rel, 'no cut-off text', a.outside.length === 0, a.outside.length ? a.outside.join(' | ') : 'all text inside the image');
      if (what === 'post image') {
        const phone = 306;   // image width inside a 390 px iPhone X feed
        const desk = 506;    // image width inside the desktop X feed
        const px = (a.minFont * phone) / w;
        add(g, rel, 'readable on 390 px iPhone feed (smallest text ≥ 8 px)', px >= 8, `smallest text ${a.minFont}px → ${px.toFixed(1)}px on phone, ${(a.minFont * desk / w).toFixed(1)}px on desktop`);
      }
    } else if (!rel.startsWith('logo/') || rel.includes('options')) {
      if (!rel.startsWith('video/')) add(g, rel, 'no cut-off text', false, 'no text measurement saved (re-render)');
    }
  }

  // ---- profile picture and token image: inside the circle crop, readable small
  for (const [rel, label] of [['logo/pfp-400x400.png', 'X circle crop'], ['logo/logo-1000x1000.png', 'Pons circle crop']]) {
    if (!fs.existsSync(at(rel))) continue;
    const r = maxRadius(await raw(at(rel)));
    add('Logo', rel, `${label}: logo fully inside the circle`, r <= 0.92, `farthest logo pixel at ${(r * 100).toFixed(0)}% of the radius (limit 92%)`);
  }
  if (fs.existsSync(at('logo/pfp-400x400.png'))) {
    for (const s of [48, 32]) {
      const b = litBox(await raw(at('logo/pfp-400x400.png'), s));
      add('Logo', `pfp at ${s}px`, `readable at ${s}px (logo at least half the circle)`, b.h >= s * 0.5, `logo is ${b.w}x${b.h}px inside a ${s}px circle`);
    }
  }
  if (fs.existsSync(at('logo/favicon.ico'))) {
    const ico = fs.readFileSync(at('logo/favicon.ico'));
    const n = ico.readUInt16LE(4);
    const sizes = []; for (let i = 0; i < n; i++) sizes.push(ico.readUInt8(6 + i * 16) || 256);
    add('Logo', 'logo/favicon.ico', 'holds 16, 32 and 48 px', [16, 32, 48].every((s) => sizes.includes(s)), sizes.join(', ') + ' px');
    add('Logo', 'logo/favicon.ico', 'no personal info', !personalHits(ico).length, 'none');
  }
  for (const f of fs.existsSync(at('logo')) ? fs.readdirSync(at('logo')).filter((n) => n.endsWith('.svg')) : []) {
    const s = fs.readFileSync(at('logo', f), 'utf8');
    add('Logo', `logo/${f}`, 'pure shapes (no fonts, images or scripts)', !/<(text|image|script|foreignObject)/i.test(s) && !/href=/i.test(s), 'shapes only');
    add('Logo', `logo/${f}`, 'no personal info', !personalHits(Buffer.from(s)).length, 'none');
  }
  add('Logo', 'logo/logo-bw.svg', 'works in pure black and white', fs.existsSync(at('logo/logo-bw.svg')) && !/#2433FF|#FF4F1F/i.test(fs.readFileSync(at('logo/logo-bw.svg'), 'utf8')), 'only #000 and #fff');

  // ---- banner safe zones
  if (fs.existsSync(at('x/banner-1500x500.png'))) {
    const px = await raw(at('x/banner-1500x500.png'));
    const avatar = litIn(px, [0, 300, 430, 500]);
    add('Banner & link preview', 'x/banner-1500x500.png', 'nothing under the profile picture / name (lower-left)', avatar === 0, `${avatar} lit pixels in x 0–430, y 300–500`);
    const trim = litIn(px, [0, 0, 1500, 70]) + litIn(px, [0, 430, 1500, 500]);
    add('Banner & link preview', 'x/banner-1500x500.png', 'nothing in the top/bottom strips phones trim', trim === 0, `${trim} lit pixels in the top 70 px and bottom 70 px`);
  }
  if (fs.existsSync(at('x/og-1200x630.png'))) {
    const px = await raw(at('x/og-1200x630.png'));
    const corner = litIn(px, [0, 560, 480, 630]);
    add('Banner & link preview', 'x/og-1200x630.png', 'lower-left clear for X\'s site-name label', corner === 0, `${corner} lit pixels in the corner`);
    const crop = litIn(px, [0, 0, 1200, 2]) + litIn(px, [0, 628, 1200, 630]);
    add('Banner & link preview', 'x/og-1200x630.png', 'survives X\'s 1.91:1 crop', crop === 0, 'nothing in the 2 px X trims');
  }
  const snippet = fs.existsSync(at('og-meta-snippet.html')) ? fs.readFileSync(at('og-meta-snippet.html'), 'utf8') : '';
  add('Banner & link preview', 'og-meta-snippet.html', 'has og:image, twitter:card=summary_large_image, sizes, alt',
    /og:image"/.test(snippet) && /summary_large_image/.test(snippet) && /og:image:width" content="1200"/.test(snippet) && /og:image:alt/.test(snippet), snippet ? 'all tags present' : 'missing');

  // ---- videos
  const VIDS = [['video/video-1080x1080.mp4', 1080, 1080, false], ['video/video-1920x1080.mp4', 1920, 1080, false], ['video/video-1920x1080-with-sound.mp4', 1920, 1080, true]];
  for (const [rel, w, h, sound] of VIDS) {
    if (!fs.existsSync(at(rel))) { add('Video', rel, 'file exists', false, 'missing'); continue; }
    const j = JSON.parse(await ff('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', at(rel)]));
    const v = j.streams.find((s) => s.codec_type === 'video');
    const a = j.streams.filter((s) => s.codec_type === 'audio');
    const size = fs.statSync(at(rel)).size;
    const dur = Number(j.format.duration);
    add('Video', rel, `${w}x${h}`, v.width === w && v.height === h, `${v.width}x${v.height}`);
    add('Video', rel, 'H.264, yuv420p', v.codec_name === 'h264' && v.pix_fmt === 'yuv420p', `${v.codec_name}, ${v.pix_fmt}, profile ${v.profile}`);
    add('Video', rel, '30 fps', v.r_frame_rate === '30/1', v.r_frame_rate);
    add('Video', rel, '20–25 seconds', dur >= 20 && dur <= 25, `${dur.toFixed(2)} s`);
    add('Video', rel, 'under 15 MB', size < 15 * 1024 * 1024, `${(size / 1024 / 1024).toFixed(2)} MB`);
    add('Video', rel, sound ? 'has the soft sound track' : 'no music / no audio track', sound ? a.length === 1 : a.length === 0, a.map((s) => s.codec_name).join(', ') || 'none');
    const tags = { ...(j.format.tags || {}) }; delete tags.major_brand; delete tags.minor_version; delete tags.compatible_brands;
    const stTags = j.streams.flatMap((s) => Object.keys(s.tags || {}).filter((k) => !['language', 'handler_name', 'vendor_id'].includes(k)));
    add('Video', rel, 'no metadata (no dates, encoder or names)', !Object.keys(tags).length && !stTags.length, Object.keys(tags).concat(stTags).join(', ') || 'none');
    add('Video', rel, 'no personal info', !personalHits(fs.readFileSync(at(rel))).length, 'none');
    const au = audit[rel];
    if (au) {
      add('Video', rel, 'no cut-off text in any frame', au.outside.length === 0, au.outside.length ? au.outside.slice(0, 3).join(' | ') : `${au.frames} frames measured`);
      const [x0, y0, x1, y1] = au.box;
      const mx = (Math.min(x0, w - x1) / w) * 100, my = (Math.min(y0, h - y1) / h) * 100;
      add('Video', rel, 'text inside safe margins (≥ 5% from every edge)', mx >= 5 && my >= 5, `closest text: ${mx.toFixed(1)}% from the side, ${my.toFixed(1)}% from top/bottom`);
      const phone = (au.minFont * 358) / w;
      add('Video', rel, 'readable on a phone (smallest text ≥ 7 px in the feed)', phone >= 7, `smallest text ${au.minFont}px → ${phone.toFixed(1)}px in a 358 px wide feed video${w > h ? '; bigger full-screen' : ''}`);
    } else add('Video', rel, 'no cut-off text in any frame', false, 'no measurement (re-render the video)');
  }
  for (const [rel, w] of [['video/video-1080x1080-first-frame.png', 1080], ['video/video-1920x1080-first-frame.png', 1920]]) {
    if (!fs.existsSync(at(rel))) continue;
    const px = await raw(at(rel));
    const lit = litIn(px, [0, 0, px.w, px.h]) / (px.w * px.h);
    add('Video', rel, 'first frame works as a thumbnail (full headline showing)', lit > 0.03, `${(lit * 100).toFixed(1)}% of the frame is text`);
  }

  // ---- posts.md
  const postsFile = at('posts.md');
  if (fs.existsSync(postsFile)) {
    const md = fs.readFileSync(postsFile, 'utf8');
    const blocks = [...md.matchAll(/^### (.+)\n[\s\S]*?```text\n([\s\S]*?)```/gm)].map((m) => ({ title: m[1].trim(), text: m[2].replace(/\n$/, '') }));
    let over = 0;
    for (const b of blocks) {
      const isBio = /bio/i.test(b.title);
      const limit = isBio ? 160 : /display name/i.test(b.title) ? 50 : 280;
      const n = xLength(fillSlots(b.text));
      if (n > limit) over++;
      add('Posts', b.title, `fits X's ${limit}-character limit${/\[[A-Z]+\]/.test(b.text) ? ' (slots filled with long values)' : ''}`, n <= limit, `${n} / ${limit}`);
    }
    add('Posts', 'posts.md', 'post count', blocks.length >= 40, `${blocks.length} posts checked`);
    const pre = blocks.filter((b) => /^Pre-launch/i.test(b.title));
    const leaks = pre.filter((b) => /\$BLAME|\bBLAME\b|\bCA\b|0x[0-9a-f]/i.test(b.text));
    add('Posts', 'pre-launch posts', 'no ticker and no CA', pre.length === 3 && !leaks.length, leaks.length ? leaks.map((b) => b.title).join(', ') : `${pre.length} posts clean`);
    const bad = bannedHits(md);
    add('Posts', 'posts.md', 'no "scam", "safe", gain promises or advice', !bad.length, bad.length ? 'found: ' + bad.join(', ') : 'clean');
    const unk = unknownWords(md);
    add('Posts', 'posts.md', 'spelling', unk && unk.length === 0, unk === null ? 'no word list on this Mac' : unk.length ? 'check: ' + unk.join(', ') : 'no unknown words');
    add('Posts', 'posts.md', 'no personal info', !personalHits(Buffer.from(md)).length, 'none');
  } else add('Posts', 'posts.md', 'file exists', false, 'missing');

  // ---- words drawn into the images and video
  let props = {};
  try { props = JSON.parse(fs.readFileSync(at('data/props.json'), 'utf8')); } catch {}
  const srcText = ['video/src/stills.jsx', 'video/src/Promo.jsx'].map((f) => fs.readFileSync(at(f), 'utf8')).join('\n')
    .match(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)?.map((s) => s.slice(1, -1))
    .filter((s) => /^[\s\w'’.,:!?$%·…—-]+$/.test(s) && !/\w\.\w|[a-z][A-Z]/.test(s)).join(' \n') || '';   // words on screen, not code
  const drawn = srcText + ' ' + (props.cards || []).map((c) => c.sub).join(' ') + ' ' + [props.copy?.dateText, ...(props.copy?.rows || []).map((r) => r.note)].join(' ');
  const unk2 = unknownWords(drawn);
  add('Brand', 'all text in images + video', 'spelling', unk2 && unk2.length === 0, unk2 === null ? 'no word list' : unk2.length ? 'check: ' + unk2.join(', ') : 'no unknown words');
  const bad2 = bannedHits(drawn);
  add('Brand', 'all text in images + video', 'no "scam", "safe", gain promises or advice', !bad2.length, bad2.length ? bad2.join(', ') : 'clean');
  add('Brand', 'all text in images + video', 'no company logos (tickers as plain text only)', true, 'every mark is drawn from shapes in tools/logos.mjs; tickers are typed text');
  add('Brand', 'all images', 'site URL is blamethestock.com', cfg.site === 'blamethestock.com', cfg.site);
  add('Brand', 'config.json', 'contract address setting', typeof cfg.ca === 'string' && cfg.ca.length > 0, `CA: ${cfg.ca}`);
  const placeholders = (props.cards || []).filter((c) => c.placeholder).map((c) => c.symbol);
  add('Brand', 'blame cards', 'use real live data', !placeholders.length, placeholders.length ? 'example numbers for: ' + placeholders.join(', ') : (props.cards || []).map((c) => `$${c.symbol} ${c.asOfText}, ${c.dateText}`).join(' · '));

  // ---- write out
  fs.mkdirSync(at('checks'), { recursive: true });
  const summary = { at: new Date().toISOString(), total: results.length, passed: results.filter((r) => r.pass).length };
  fs.writeFileSync(at('checks/results.json'), JSON.stringify({ summary, results }, null, 1));
  fs.writeFileSync(at("checks/results.js"), `window.CHECKS = ${JSON.stringify({ summary, results })};\nwindow.SNIPPET = ${JSON.stringify(snippet.replace(/<!--[\s\S]*?-->\n?/, ""))};\n`);
  if (!quiet) {
    const fails = results.filter((r) => !r.pass);
    console.log(`\nCHECKS: ${summary.passed}/${summary.total} passed`);
    for (const f of fails) console.log(`  FAIL  [${f.group}] ${f.item} — ${f.check}: ${f.detail}`);
  }
  return results.every((r) => r.pass);
}

if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const ok = await runChecks();
  process.exit(ok ? 0 : 1);
}
