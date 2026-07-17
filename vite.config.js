import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Fixed, dedicated port (not 5173 — that's routinely occupied by other
  // projects on this machine). strictPort means it fails loudly instead of
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
