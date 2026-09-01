import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const TIMEOUT_MS = 8000

// Supabase redirects here after Google OAuth. The SDK handles the token
// exchange automatically; we just wait for the session and redirect. If the
// redirect chain (app -> Supabase -> Google -> Supabase -> app) gets blocked
// partway by the browser, SIGNED_IN never fires, so we time out and explain.
export default function AuthCallback() {
  const navigate = useNavigate()
  const [timedOut, setTimedOut] = useState(false)

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session) {
        navigate('/', { replace: true })
      }
    })
    const timer = setTimeout(() => setTimedOut(true), TIMEOUT_MS)
    return () => {
      subscription.unsubscribe()
      clearTimeout(timer)
    }
  }, [navigate])

  if (timedOut) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center text-center px-4">
        <p className="text-gray-600 mb-4 max-w-sm">
          Sign-in is taking longer than expected. If your browser blocked a redirect, allow redirects
          for sil.org and accounts.google.com, then try again.
        </p>
        <button onClick={() => navigate('/', { replace: true })} className="text-brand underline text-sm">
          Back to sign in
        </button>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center text-gray-400">
      Signing you in…
    </div>
  )
}
