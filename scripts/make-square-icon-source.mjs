// Recreates the app icon from the *favicon's* two-tile mark (sampled exact
// colors: sil.light-blue #00A7E1 / brand.dark #034D8A, rounded-rectangle
// tiles) redrawn crisply at high resolution, rather than upscaling the
// 32x32 favicon.png directly (which stays soft/blurry at 512px — there's no
// real detail to recover from a source that small, and the corner rounding
// in particular is only 1-2px there — impossible to scale up cleanly). Not
// a pixel-for-pixel trace of the favicon's exact proportions (those were
// tuned for a tiny browser-tab context) — same two colors/shapes, balanced
// padding for an app-icon canvas instead.
import sharp from 'sharp'

const SIZE = 1024
// Tiles are portrait rectangles, not squares — matches the actual favicon
// (measured ~12px wide x 14px tall per tile at its native 32x32 size).
// Taller tiles push the two-tile group's overall bounding box closer to
// square, which sits better centered on a square icon canvas.
const TILE_W = 380
const TILE_H = Math.round(TILE_W * (14 / 12))
const GAP = 28
const RADIUS = Math.round(TILE_W * 0.12)
const totalWidth = TILE_W * 2 + GAP
const left = Math.round((SIZE - totalWidth) / 2)
const top = Math.round((SIZE - TILE_H) / 2)

const svg = `
<svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${SIZE}" height="${SIZE}" fill="#ffffff"/>
  <rect x="${left}" y="${top}" width="${TILE_W}" height="${TILE_H}" rx="${RADIUS}" ry="${RADIUS}" fill="#00A7E1"/>
  <rect x="${left + TILE_W + GAP}" y="${top}" width="${TILE_W}" height="${TILE_H}" rx="${RADIUS}" ry="${RADIUS}" fill="#034D8A"/>
</svg>`

await sharp(Buffer.from(svg)).png().toFile('public/icon-source.png')
console.log('Wrote public/icon-source.png (1024x1024, favicon two-tile mark)')
