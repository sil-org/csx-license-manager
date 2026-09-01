import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { resolveProfile } from '../lib/auth'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(undefined) // undefined = loading
  const [profile, setProfile] = useState(null)
  const [authError, setAuthError] = useState(null)

  async function loadProfile(user) {
    try {
      setProfile(await resolveProfile(user))
      setAuthError(null)
    } catch (err) {
      setAuthError(err)
    }
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      if (session?.user) loadProfile(session.user)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      if (session?.user) {
        loadProfile(session.user)
      } else {
        setProfile(null)
        setAuthError(null)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  async function refreshProfile() {
    const { data: { session: s } } = await supabase.auth.getSession()
    if (s?.user) loadProfile(s.user)
  }

  const loading = session === undefined || (session !== null && profile === null && authError === null)

  return (
    <AuthContext.Provider value={{ session, profile, loading, authError, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
