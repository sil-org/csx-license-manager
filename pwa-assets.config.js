import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config'

// Regenerates public/pwa-assets/* from public/icon-source.png (a square,
// safe-zone-padded crop of the SIL lockup — see scripts/make-square-icon-source.mjs).
// Downstream apps with their own square mark should replace icon-source.png
// and rerun `npm run pwa:icons` rather than editing generated files by hand.
export default defineConfig({
  preset: minimal2023Preset,
  images: ['public/icon-source.png'],
})
