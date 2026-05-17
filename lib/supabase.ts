import 'react-native-url-polyfill/auto.js'
import AsyncStorage from '@react-native-async-storage/async-storage'
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

async function removePersistedAuthSession() {
  const keys = await AsyncStorage.getAllKeys()
  const authKeys = keys.filter(
    (key) => isSupabaseAuthKey(key) && !isPkceCodeVerifierKey(key)
  )
  if (authKeys.length > 0) {
    await AsyncStorage.multiRemove(authKeys)
  }

  memoryAuthSession.clear()
}

const authStorage = {
  getItem: async (key: string) => {
    if (!persistAuthSession && isSupabaseAuthKey(key) && !isPkceCodeVerifierKey(key)) {
      return memoryAuthSession.get(key) ?? null
    }

    return AsyncStorage.getItem(key)
  },
  setItem: async (key: string, value: string) => {
    // Keep PKCE temporary verifier available for OAuth callback exchange,
    // even when long-lived session persistence is disabled.
    if (!persistAuthSession && isSupabaseAuthKey(key) && !isPkceCodeVerifierKey(key)) {
      memoryAuthSession.set(key, value)
      return
    }

    return AsyncStorage.setItem(key, value)
  },
  removeItem: async (key: string) => {
    if (!persistAuthSession && isSupabaseAuthKey(key) && !isPkceCodeVerifierKey(key)) {
      memoryAuthSession.delete(key)
      return
    }

    return AsyncStorage.removeItem(key)
  },
}

export function setAuthSessionPersistenceEnabled(enabled: boolean) {
  persistAuthSession = enabled
}

export async function clearPersistedAuthSession() {
  await removePersistedAuthSession()
}

export function isInvalidRefreshTokenError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const message =
    'message' in error && typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : ''

  return (
    message.includes('Invalid Refresh Token') ||
    message.includes('Refresh Token Not Found') ||
    message.includes('refresh_token_not_found')
  )
}

export function isMissingAuthSessionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const message =
    'message' in error && typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : ''

  return message.includes('Auth session missing')
}

export async function recoverFromInvalidRefreshToken(error: unknown): Promise<boolean> {
  if (!isInvalidRefreshTokenError(error)) return false
  await clearPersistedAuthSession()
  try {
    await supabase.auth.signOut({ scope: 'local' })
  } catch {
    // no-op, local session was already invalid
  }
  return true
}

export async function getCurrentUserSafe(): Promise<User | null> {
  try {
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
    if (sessionError) {
      await recoverFromInvalidRefreshToken(sessionError)
      return null
    }

    if (sessionData.session?.user) {
      return sessionData.session.user
    }

    const { data, error } = await supabase.auth.getUser()
    if (error) {
      if (isMissingAuthSessionError(error)) return null
      await recoverFromInvalidRefreshToken(error)
      return null
    }

    return data.user ?? null
  } catch {
    return null
  }
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: authStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    // PKCE is required for OAuth code exchange in callback.tsx.
    flowType: 'pkce',
  },
})
