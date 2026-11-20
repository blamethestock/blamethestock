// Re-renders the whole launch kit.
//
//   npm run kit                      every image + all three videos, using the saved live data
//   npm run kit -- --ca 0xABC…       same, after saving the real contract address into config.json
//   npm run kit -- --refresh         fetch fresh live numbers for $AI, $MEME, $BONER first
//   npm run kit -- --no-video        images only (fast)
//   npm run kit -- --video-only      videos only
//
// Then runs the checks (tools/check.mjs) and rebuilds checks/results.js for index.html.
import fs from 'node:fs';
import { retry, summarizeAudits, recordAudit, at, readConfig, writeConfig, RECOMMENDED_LOGO, fetchLive, cardFromResult, PLACEHOLDER, OBSYN, writeProps, renderStillTo, cleanPng, bundleOnce, ff } from './lib.mjs';
import { markSvg, lockupSvg, LOGOS } from './logos.mjs';
import { wordPath } from './wordmark.mjs';
import { makeSfx } from './make-sfx.mjs';
import { writeIco } from './ico.mjs';
import sharp from 'sharp';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const value = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const log = (...a) => console.log('·', ...a);

// ---- 1. settings
const cfg = readConfig();
const newCa = value('--ca');
if (newCa) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(newCa.trim())) { console.error(`That doesn't look like a contract address: ${newCa}`); process.exit(1); }
  cfg.ca = newCa.trim();
  writeConfig(cfg);
  log(`Saved CA ${cfg.ca} in config.json`);
}
if (!LOGOS[cfg.logo]) { console.error(`config.json "logo" must be A, B or C (it is "${cfg.logo}")`); process.exit(1); }
const kit = { ...cfg, recommended: RECOMMENDED_LOGO };

// ---- 2. live data (saved copies in data/live-*.json; --refresh fetches again)
const COINS = { AI: '0x2e8c31162b855a2ffa90f6f8634643ad6f111e18', MEME: '0x385f4f8ae47651ce5f58f5265395a669f8281e18', BONER: '0x98096d17e191b3da1d5f99a6d7b3584351b11e18' };
const dataNotes = [];
const cards = [];
for (const [sym, addr] of Object.entries(COINS)) {
  const file = at(`data/live-${sym}.json`);
  if (flag('--refresh') || !fs.existsSync(file)) {
    log(`Fetching live ${sym}…`);
    const got = await fetchLive(addr);
    if (got.ok) fs.writeFileSync(file, JSON.stringify(got.live, null, 1));
    else dataNotes.push(`${sym}: live fetch failed (${got.why}); ${fs.existsSync(file) ? 'using the last saved numbers' : 'using marked example numbers'}`);
  }
  let card;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!saved.res || !saved.res.ok) throw new Error('saved file has no result');
    card = cardFromResult(saved.res);
    card.fetchedAt = saved.fetchedAt || null;
  } catch {
    card = { ...PLACEHOLDER[sym], windowLabel: '24h', dateText: '—', asOfText: 'Example numbers', placeholder: true };
  }
  cards.push(card);
}

// ---- 3. logo files (pure SVG geometry, no font needed)
const word = wordPath();
const wordSvgs = Object.fromEntries(Object.keys(LOGOS).map((id) => [id, lockupSvg(id, word, { height: 200 })]));
const props = { kit, cards, copy: OBSYN, word: wordSvgs, ai: { ...cards[0], address: COINS.AI }, card: cards[0], sfx: false };
writeProps(props);

makeSfx(at('video/public/sfx'));   // before bundling: the bundle copies video/public
const only = value('--only');
const want = (k) => !only || only.split(',').includes(k);
const images = !flag('--video-only');
const videos = !flag('--no-video');

if (images && want('logo')) {
  log('Logo files…');
  fs.mkdirSync(at('logo'), { recursive: true });
  for (const id of Object.keys(LOGOS)) {
    fs.writeFileSync(at(`logo/option-${id}.svg`), markSvg(id, { size: 1000, scale: 0.8 }));
    fs.writeFileSync(at(`logo/option-${id}-bw.svg`), markSvg(id, { size: 1000, scale: 0.8, color: false }));
  }
  const L = cfg.logo;
  fs.writeFileSync(at('logo/logo.svg'), markSvg(L, { size: 1000, scale: 0.8 }));
  fs.writeFileSync(at('logo/logo-bw.svg'), markSvg(L, { size: 1000, scale: 0.8, color: false }));
  fs.writeFileSync(at('logo/logo-wordmark.svg'), lockupSvg(L, word, { height: 200 }));
  const png = async (svg, out, size) => {
    const tmp = await sharp(Buffer.from(svg), { density: 72 * 4 }).resize(size, size).png().toBuffer();
    await cleanPng(tmp, at(out), size, size);
  };
  await png(markSvg(L, { size: 1000, scale: 0.62 }), 'logo/logo-1000x1000.png', 1000);       // Pons token image: safe inside a circle
  await png(markSvg(L, { size: 400, scale: 0.6 }), 'logo/pfp-400x400.png', 400);              // X profile picture: circle-crop safe
  await png(markSvg(L, { size: 180, scale: 0.7 }), 'logo/apple-touch-icon-180.png', 180);
  await png(markSvg(L, { size: 32, scale: 0.86, round: 0.18 }), 'logo/favicon-32.png', 32);
  const icoSizes = [16, 32, 48];
  const bufs = [];
  for (const s of icoSizes) bufs.push(await sharp(Buffer.from(markSvg(L, { size: s, scale: s <= 16 ? 0.92 : 0.86, round: 0.18 })), { density: 72 * 8 }).resize(s, s).png().toBuffer());
  writeIco(bufs, icoSizes, at('logo/favicon.ico'));
}

if (images) {
  const jobs = [];
  if (want('logo')) jobs.push(['logo-options', 'logo/logo-options-1920x1080.png', {}]);
  if (want('x')) jobs.push(['banner', 'x/banner-1500x500.png', {}], ['og', 'x/og-1200x630.png', {}]);
  if (want('posts')) {
    for (const c of cards) {
      jobs.push(['blame-wide', `posts/blame-${c.symbol}-1200x675.png`, { card: c, square: false }]);
      jobs.push(['blame-square', `posts/blame-${c.symbol}-1080x1080.png`, { card: c, square: true }]);
    }
    jobs.push(['copycat-wide', 'posts/copycat-OBSYN-1200x675.png', { square: false }], ['copycat-square', 'posts/copycat-OBSYN-1080x1080.png', { square: true }]);
    jobs.push(['receipts-wide', 'posts/receipts-1200x675.png', { square: false }], ['receipts-square', 'posts/receipts-1080x1080.png', { square: true }]);
  }
  await bundleOnce();
  for (const [id, out, extra] of jobs) {
    await renderStillTo(id, at(out), { ...props, ...extra });
    log(out);
  }
}

if (videos) {
  const { renderMedia, renderStill, selectComposition } = await import('@remotion/renderer');
  const serveUrl = await bundleOnce();
  const vids = [
    ['promo-square', 'video/video-1080x1080.mp4', false],
    ['promo-wide', 'video/video-1920x1080.mp4', false],
    ['promo-wide', 'video/video-1920x1080-with-sound.mp4', true],
  ];
  for (const [id, out, sfx] of vids) {
    const inputProps = { ...props, sfx };
    const composition = await retry(() => selectComposition({ serveUrl, id, inputProps, timeoutInMilliseconds: 120000 }), out);
    const tmp = at(out + '.tmp.mp4');
    let last = -1;
    let audits = [];
    await retry(() => { audits = []; return renderMedia({
      timeoutInMilliseconds: 120000,
      onBrowserLog: (l) => { if (l.text.startsWith('AUDIT')) audits.push(JSON.parse(l.text.slice(5))); },
      composition, serveUrl, codec: 'h264', outputLocation: tmp, inputProps, crf: 20, pixelFormat: 'yuv420p',
      colorSpace: 'bt709', muted: !sfx, overwrite: true,
      onProgress: ({ progress }) => { const p = Math.floor(progress * 10); if (p !== last) { last = p; process.stdout.write(`  ${out} ${p * 10}%\r`); } },
    }); }, out);
    // strip all metadata (encoder tags, dates) and put the index first so X can start playing early
    await ff('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmp, '-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact',
      '-c', 'copy', '-movflags', '+faststart', at(out)]);
    fs.unlinkSync(tmp);
    recordAudit(out, summarizeAudits(audits));
    log(out);
    if (!sfx) {
      const { storyboard } = await import('./storyboard.mjs');
      await storyboard(id, inputProps);
      const th = out.replace('.mp4', '-first-frame.png');
      const tmpPng = at(th + '.tmp.png');
      await renderStill({ composition, serveUrl, timeoutInMilliseconds: 120000, output: tmpPng, inputProps, frame: 0, overwrite: true });
      await cleanPng(tmpPng, at(th), composition.width, composition.height);
      fs.unlinkSync(tmpPng);
      log(th);
    }
  }
}

if (dataNotes.length) { console.log('\nLIVE DATA NOTES:'); dataNotes.forEach((n) => console.log('  ' + n)); }
fs.writeFileSync(at('data/render-notes.json'), JSON.stringify({ renderedAt: new Date().toISOString(), dataNotes, cards: cards.map((c) => ({ symbol: c.symbol, placeholder: !!c.placeholder, asOfText: c.asOfText, dateText: c.dateText, fetchedAt: c.fetchedAt || null })) }, null, 1));

if (!flag('--no-check')) {
  const { runChecks } = await import('./check.mjs');
  const ok = await runChecks();
  process.exit(ok ? 0 : 1);
}
