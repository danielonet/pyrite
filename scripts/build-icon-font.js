#!/usr/bin/env node
/**
 * Builds media/pyrite-icons.woff from media/icon.svg.
 *
 * VS Code can only draw icons from a font in places like the status bar, so the logo has to
 * be a glyph. The font is registered in package.json under `contributes.icons` as
 * `pyrite-logo`, which the extension then uses as `$(pyrite-logo)`.
 *
 * Run after changing the logo:  npm run build:icon-font
 * The generated .woff is committed, so a normal build needs no font tooling.
 */

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { SVGIcons2SVGFontStream } = require('svgicons2svgfont');
const svgpath = require('svgpath');
const svg2ttf = require('svg2ttf');
const ttf2woff = require('ttf2woff');

const MEDIA = path.join(__dirname, '..', 'media');
const SOURCE = path.join(MEDIA, 'icon.svg');
const OUTPUT = path.join(MEDIA, 'pyrite-icons.woff');
/** Private Use Area code point; must match `fontCharacter` in package.json. */
const CODE_POINT = 0xe001;
/**
 * How much of the em box the logo fills. VS Code draws a status bar glyph at the bar's own
 * font size and gives no way to scale it, so the padding that makes the logo sit smaller
 * beside the built-in icons has to be baked into the font.
 */
const GLYPH_SCALE = 0.85;

/** The icon as one path in plain user units, with every transform baked in. */
function flattenedPath(svg) {
  const paths = [...svg.matchAll(/<path[^>]*\bd="([^"]+)"/g)].map((m) => m[1]);
  if (!paths.length) throw new Error(`no <path> found in ${SOURCE}`);
  const transform = /<g[^>]*\btransform="([^"]+)"/.exec(svg)?.[1] ?? '';
  return paths.map((d) => svgpath(d).transform(transform).abs().round(3).toString()).join(' ');
}

/** Bounding box of a flattened path, from its coordinate pairs. */
function boundsOf(d) {
  const numbers = (d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    minX = Math.min(minX, numbers[i]);
    maxX = Math.max(maxX, numbers[i]);
    minY = Math.min(minY, numbers[i + 1]);
    maxY = Math.max(maxY, numbers[i + 1]);
  }
  return { minX, minY, width: maxX - minX, height: maxY - minY };
}

async function main() {
  const svg = fs.readFileSync(SOURCE, 'utf8');
  const d = flattenedPath(svg);
  const box = boundsOf(d);
  // Pad the view box so the outline covers GLYPH_SCALE of it; `normalize: false` keeps that
  // ratio instead of scaling the outline back up to fill the em box.
  const pad = { x: (box.width / GLYPH_SCALE - box.width) / 2, y: (box.height / GLYPH_SCALE - box.height) / 2 };
  const view = { x: box.minX - pad.x, y: box.minY - pad.y, width: box.width + 2 * pad.x, height: box.height + 2 * pad.y };
  const glyphSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view.x} ${view.y} ${view.width} ${view.height}"><path d="${d}"/></svg>`;

  const fontStream = new SVGIcons2SVGFontStream({ fontName: 'pyrite-icons', normalize: false, fontHeight: 1000, centerHorizontally: true, centerVertically: true, log: () => {} });
  const svgFont = await new Promise((resolve, reject) => {
    let out = '';
    fontStream.on('data', (chunk) => (out += chunk));
    fontStream.on('end', () => resolve(out));
    fontStream.on('error', reject);
    const glyph = Readable.from([glyphSvg]);
    glyph.metadata = { unicode: [String.fromCodePoint(CODE_POINT)], name: 'pyrite-logo' };
    fontStream.write(glyph);
    fontStream.end();
  });

  const ttf = svg2ttf(svgFont, { description: 'Pyrite icons', url: 'https://github.com/danielonet/pyrite' });
  fs.writeFileSync(OUTPUT, Buffer.from(ttf2woff(new Uint8Array(ttf.buffer)).buffer));
  console.log(`Wrote ${path.relative(process.cwd(), OUTPUT)} (${fs.statSync(OUTPUT).size} bytes), glyph U+${CODE_POINT.toString(16).toUpperCase()} at ${Math.round(GLYPH_SCALE * 100)}% of the em box`);
  if (process.env.PYRITE_ICON_TTF) fs.writeFileSync(process.env.PYRITE_ICON_TTF, Buffer.from(ttf.buffer));
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
