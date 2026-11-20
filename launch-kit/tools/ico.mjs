// Writes a .ico file that holds several PNG images (16, 32, 48 px). Every current browser reads PNG-in-ICO.
import fs from 'node:fs';

export function writeIco(pngs, sizes, out) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach((p, i) => {
    const s = sizes[i];
    dir.writeUInt8(s >= 256 ? 0 : s, i * 16);
    dir.writeUInt8(s >= 256 ? 0 : s, i * 16 + 1);
    dir.writeUInt8(0, i * 16 + 2); dir.writeUInt8(0, i * 16 + 3);
    dir.writeUInt16LE(1, i * 16 + 4); dir.writeUInt16LE(32, i * 16 + 6);
    dir.writeUInt32LE(p.length, i * 16 + 8); dir.writeUInt32LE(offset, i * 16 + 12);
    offset += p.length;
  });
  fs.writeFileSync(out, Buffer.concat([head, dir, ...pngs]));
}
