// Preserve the source GLB geometry and texture dimensions; compress only its
// embedded images for delivery. Run from any directory with Node 22+.
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const source = new URL('../../../3dmodel/night_sky_visible_spectrum_monochromatic (1).glb', import.meta.url);
const target = new URL('../public/models/lunarveil-universe-hd.glb', import.meta.url);
const input = await readFile(source);
if (input.readUInt32LE(0) !== 0x46546c67 || input.readUInt32LE(4) !== 2) throw new Error('Expected GLB v2');
const jsonLength = input.readUInt32LE(12);
const document = JSON.parse(input.subarray(20, 20 + jsonLength).toString());
if (document.buffers.length !== 1 || document.buffers[0].uri) throw new Error('Expected one embedded buffer');
const binary = input.subarray(28 + jsonLength);
const imageViews = new Set(document.images.map(image => image.bufferView));
const chunks = [];
let offset = 0;
for (const [index, view] of document.bufferViews.entries()) {
  let bytes = binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  if (imageViews.has(index)) {
    const before = await sharp(bytes).metadata();
    bytes = await sharp(bytes).webp({ quality: 94, effort: 6 }).toBuffer();
    const after = await sharp(bytes).metadata();
    if (before.width !== after.width || before.height !== after.height) throw new Error('Texture dimensions changed');
    console.log(`Sky texture: ${after.width} x ${after.height} (native resolution)`);
  }
  view.byteOffset = offset;
  view.byteLength = bytes.length;
  chunks.push(bytes);
  const padding = (4 - bytes.length % 4) % 4;
  if (padding) chunks.push(Buffer.alloc(padding));
  offset += bytes.length + padding;
}
for (const image of document.images) image.mimeType = 'image/webp';
for (const texture of document.textures) {
  if (texture.source !== undefined) {
    texture.extensions = { ...texture.extensions, EXT_texture_webp: { source: texture.source } };
    delete texture.source;
  }
}
document.extensionsUsed = [...new Set([...(document.extensionsUsed ?? []), 'EXT_texture_webp'])];
document.extensionsRequired = [...new Set([...(document.extensionsRequired ?? []), 'EXT_texture_webp'])];
document.buffers[0].byteLength = offset;
const rawJson = Buffer.from(JSON.stringify(document));
const json = Buffer.concat([rawJson, Buffer.alloc((4 - rawJson.length % 4) % 4, 0x20)]);
const header = Buffer.alloc(20);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(28 + json.length + offset, 8);
header.writeUInt32LE(json.length, 12);
header.writeUInt32LE(0x4e4f534a, 16);
const binaryHeader = Buffer.alloc(8);
binaryHeader.writeUInt32LE(offset, 0);
binaryHeader.writeUInt32LE(0x004e4942, 4);
await writeFile(target, Buffer.concat([header, json, binaryHeader, ...chunks]));
console.log(`Prepared GLB: ${28 + json.length + offset} bytes`);
