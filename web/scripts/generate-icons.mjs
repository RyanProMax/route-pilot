import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-js';

// Keep launcher and browser icons synchronized with the shared vector mark.
const mark = await readFile(new URL('../src/assets/routepilot-mark.svg', import.meta.url), 'utf8');
await writeFile(new URL('../public/routepilot-mark.svg', import.meta.url), mark);
await writeFile(new URL('../public/favicon.svg', import.meta.url), mark);
const paths = mark.match(/<svg[^>]*>([\s\S]*)<\/svg>/)?.[1];
const viewBox = mark.match(/viewBox="0 0 (\d+) (\d+)"/);
if (!paths || !viewBox || viewBox[1] !== viewBox[2]) throw Error('Invalid Route Pilot mark');
const directory = new URL('../public/icons/', import.meta.url);
await mkdir(directory, { recursive: true });
for (const [file, size, fraction] of [
  ['icon-192.png', 192, 0.72], ['icon-512.png', 512, 0.72],
  ['maskable-512.png', 512, 0.64], ['apple-touch-icon.png', 180, 0.72],
]) {
  const inset = (512 - 512 * fraction) / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#ffffff"/><g fill="none" transform="translate(${inset},${inset}) scale(${512 * fraction / Number(viewBox[1])})">${paths}</g></svg>`;
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  await writeFile(new URL(file, directory), png);
}
