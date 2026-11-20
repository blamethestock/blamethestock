// Saves one still per video scene (video/storyboard/<size>-<second>s.png) so every scene can be checked
// in index.html without playing the video.
import fs from 'node:fs';
import { at, bundleOnce, cleanPng } from './lib.mjs';

export const KEY_FRAMES = [0, 60, 165, 205, 330, 470, 575, 700];

export async function storyboard(id, inputProps) {
  const { renderStill, selectComposition } = await import('@remotion/renderer');
  const serveUrl = await bundleOnce();
  const composition = await selectComposition({ serveUrl, id, inputProps, timeoutInMilliseconds: 120000 });
  const tag = `${composition.width}x${composition.height}`;
  fs.mkdirSync(at('video/storyboard'), { recursive: true });
  const audits = [];
  for (const frame of KEY_FRAMES) {
    const out = at(`video/storyboard/${tag}-${String(frame).padStart(3, '0')}.png`);
    const tmp = out + '.tmp.png';
    await renderStill({ composition, serveUrl, timeoutInMilliseconds: 120000, output: tmp, inputProps, frame, overwrite: true,
      onBrowserLog: (l) => { if (l.text.startsWith('AUDIT')) audits.push(JSON.parse(l.text.slice(5))); } });
    await cleanPng(tmp, out, composition.width, composition.height);
    fs.unlinkSync(tmp);
  }
  return audits;
}

if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const props = JSON.parse(fs.readFileSync(at('data/props.json'), 'utf8'));
  for (const id of process.argv.slice(2).length ? process.argv.slice(2) : ['promo-square', 'promo-wide']) {
    const a = await storyboard(id, { ...props, sfx: false });
    console.log(id, JSON.stringify(a.map((x) => [x.frame, x.minFont, x.box, x.outside])));
  }
}
