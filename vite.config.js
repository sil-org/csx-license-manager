import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    // Installable-app support (manifest + service worker). Icons come from
    // public/icon-source.png — see pwa-assets.config.js and
    // scripts/make-square-icon-source.mjs (same source as sil-app-template's)
    // to regenerate them.
    //
    // No runtimeCaching rules on purpose: this only precaches the built app
    // shell (JS/CSS/HTML), never Supabase API responses — subscription/
    // approval data going stale behind a cache is worse than the app simply
    // requiring a network connection to fetch it.
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'License Manager',
        short_name: 'License Manager',
        description: 'Request and manage software license subscriptions',
        theme_color: '#005CB9',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  // Fixed, dedicated port — not 5173, that's routinely occupied by other
  // projects on this machine. strictPort means it fails loudly instead of
  // silently picking another port, which matters here: Supabase's OAuth
  // redirect allowlist is keyed to an exact "http://localhost:PORT/auth/callback"
  // — if the dev server lands on a different port than what's allow-listed,
  // Supabase's post-login redirect falls back to the Site URL (production)
  // instead of erroring, which looks exactly like "redirects to amplifyapp".
  server: {
    port: 5190,
    strictPort: true,
  },
})
