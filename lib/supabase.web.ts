import { createClient } from '@supabase/supabase-js'
import type { User } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!

let persistAuthSession = true
const memoryAuthSession = new Map<string, string>()

function isSupabaseAuthKey(key: string) {
  return key.includes('auth-token') && key.startsWith('sb-')
}

function isPkceCodeVerifierKey(key: string) {
  return key.includes('code-verifier') && key.startsWith('sb-')
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: {
      getItem: async (key: string) => {
        if (!persistAuthSession && isSupabaseAuthKey(key) && !isPkceCodeVerifierKey(key)) {
          return memoryAuthSession.get(key) ?? null
        }

        return typeof window !== 'undefined' ? window.localStorage.getItem(key) : null
      },
      setItem: async (key: string, value: string) => {
        if (!persistAuthSession && isSupabaseAuthKey(key) && !isPkceCodeVerifierKey(key)) {
          memoryAuthSession.set(key, value)
          return
        }

        if (typeof window !== 'undefined') {
          window.localStorage.setItem(key, value)
        }
      },
      removeItem: async (key: string) => {
        if (!persistAuthSession && isSupabaseAuthKey(key) && !isPkceCodeVerifierKey(key)) {
          memoryAuthSession.delete(key)
          return
        }

        if (typeof window !== 'undefined') {
          window.localStorage.removeItem(key)
        }
      },
    },
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true, 
    flowType: 'pkce',
    // storageKey: 'acidex-auth',
  },
})

export function setAuthSessionPersistenceEnabled(enabled: boolean) {
  persistAuthSession = enabled
}

export async function clearPersistedAuthSession() {
  memoryAuthSession.clear()
  if (typeof window === 'undefined') return

  const keys = Object.keys(window.localStorage)
  for (const key of keys) {
    if (isSupabaseAuthKey(key) && !isPkceCodeVerifierKey(key)) {
      window.localStorage.removeItem(key)
    }
  }
}

export async function getCurrentUserSafe(): Promise<User | null> {
  try {
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
    if (sessionError) return null

    if (sessionData.session?.user) {
      return sessionData.session.user
    }

    const { data, error } = await supabase.auth.getUser()
    if (error) return null

    return data.user ?? null
  } catch {
    return null
  }
}