// Makes the two soft sound effects for the optional "with sound" video, from scratch (no downloaded audio):
// click.wav (a short soft tick) and whoosh.wav (filtered noise that swells and fades).
import fs from 'node:fs';
import path from 'node:path';

const RATE = 44100;
function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
// fixed-seed noise so every render is identical
function noise(seed = 7) { let x = seed; return () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x3fffffff - 1; }; }

export function makeSfx(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const n = noise();
  // click: 30 ms, a 1.8 kHz blip with a fast decay plus a little noise
  const click = [];
  for (let i = 0; i < RATE * 0.03; i++) {
    const t = i / RATE;
    click.push((Math.sin(2 * Math.PI * 1800 * t) * 0.5 + n() * 0.25) * Math.exp(-t * 180) * 0.6);
  }
  // whoosh: 500 ms of noise through a low-pass filter that opens and closes, with a smooth swell
  const whoosh = [];
  let y = 0;
  const len = RATE * 0.5;
  for (let i = 0; i < len; i++) {
    const p = i / len;
    const env = Math.sin(Math.PI * p) ** 2;
    const cutoff = 300 + 2600 * Math.sin(Math.PI * p);
    const a = 1 - Math.exp(-2 * Math.PI * cutoff / RATE);
    y += a * (n() - y);
    whoosh.push(y * env * 0.9);
  }
  fs.writeFileSync(path.join(dir, 'click.wav'), wav(click));
  fs.writeFileSync(path.join(dir, 'whoosh.wav'), wav(whoosh));
}
