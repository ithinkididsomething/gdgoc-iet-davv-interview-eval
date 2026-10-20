import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from './api';
import {
  DEMO_MODE,
  OFFLINE_SESSION_HOURS,
  SUPABASE_ANON_KEY,
  SUPABASE_CONFIGURED,
  SUPABASE_URL,
} from './config';
import {
  getOfflineSession,
  saveOfflineSession,
  wipeLocalData,
  type OfflineSession,
} from './idb';
import { createClient } from '@supabase/supabase-js';
import type { Panel, Profile } from './types';

interface MeResponse {
  profile: Profile;
  panels: Panel[];
  is_admin: boolean;
}

interface AuthState {
  status: 'loading' | 'online' | 'offline' | 'signed_out';
  session: Session | null;
  profile: Profile | null;
  panels: Panel[];
  offlineSession: OfflineSession | null;
  signIn: (email: string, password: string) => Promise<void>;
  register: (fullName: string, email: string, password: string, code: string) => Promise<void>;
  signOut: () => Promise<void>;
  getToken: () => Promise<string | null>;
  refreshMe: () => Promise<void>;
  /** True when we only have a local offline session (not fresh server auth). */
  isOfflineSession: boolean;
}

const PENDING_CODE_KEY = 'gdgoc-pending-code';
const DEMO_TOKEN_KEY = 'gdgoc-demo-token';

/**
 * Completes registration server-side: a valid panel code makes the account a
 * judge of that panel, the admin invite code makes it an admin, and anything
 * else destroys the account. Called with the fresh sign-up session.
 */
async function completeRegistration(token: string, code: string): Promise<{ role: 'judge' | 'admin' }> {
  return api('/auth/complete-registration', {
    token,
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

const AuthContext = createContext<AuthState | null>(null);

let sb: SupabaseClient | null = null;
export function supabase(): SupabaseClient {
  if (!sb) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      throw new Error('Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
    }
    sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'gdgoc-auth' },
    });
  }
  return sb;
}

async function restoreOfflineSession(
  setOfflineSession: (value: OfflineSession | null) => void,
  setProfile: (value: Profile | null) => void,
  setStatus: (value: AuthState['status']) => void,
): Promise<boolean> {
  const off = await getOfflineSession();
  if (!off) return false;
  setOfflineSession(off);
  setProfile({
    id: off.user_id,
    email: off.email,
    full_name: off.full_name,
    role: off.role,
  });
  setStatus('offline');
  return true;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthState['status']>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [panels, setPanels] = useState<Panel[]>([]);
  const [offlineSession, setOfflineSession] = useState<OfflineSession | null>(null);

  const loadMe = useCallback(async (token: string) => {
    const me = await api<MeResponse>('/me', { token });
    setProfile(me.profile);
    setPanels(me.panels);
    await saveOfflineSession({
      user_id: me.profile.id,
      email: me.profile.email,
      full_name: me.profile.full_name,
      role: me.profile.role,
      panel_ids: me.panels.map((p) => p.id),
      expires_at: new Date(Date.now() + OFFLINE_SESSION_HOURS * 3_600_000).toISOString(),
    });
  }, []);

  const applyDemoSession = useCallback(
    async (token: string) => {
      localStorage.setItem(DEMO_TOKEN_KEY, token);
      await loadMe(token);
      setOfflineSession(await getOfflineSession());
      setStatus('online');
    },
    [loadMe],
  );

  const bootstrap = useCallback(async () => {
    if (DEMO_MODE) {
      const token = localStorage.getItem(DEMO_TOKEN_KEY);
      if (token) {
        try {
          await applyDemoSession(token);
          return;
        } catch {
          localStorage.removeItem(DEMO_TOKEN_KEY);
        }
      }
      if (await restoreOfflineSession(setOfflineSession, setProfile, setStatus)) return;
      setStatus('signed_out');
      return;
    }

    // Missing VITE_SUPABASE_* (typical Vercel preview) must not call createClient —
    // that throws and leaves a blank page.
    if (!SUPABASE_CONFIGURED) {
      if (await restoreOfflineSession(setOfflineSession, setProfile, setStatus)) return;
      setStatus('signed_out');
      return;
    }

    try {
      const sbClient = supabase();
      const { data } = await sbClient.auth.getSession();
      const s = data.session;
      setSession(s);
      if (s) {
        try {
          await loadMe(s.access_token);
          setStatus('online');
          setOfflineSession(await getOfflineSession());
          return;
        } catch {
          // Token valid but backend unreachable — fall back to offline session.
          if (await restoreOfflineSession(setOfflineSession, setProfile, setStatus)) return;
        }
      }
      if (await restoreOfflineSession(setOfflineSession, setProfile, setStatus)) return;
      setStatus('signed_out');
    } catch {
      if (await restoreOfflineSession(setOfflineSession, setProfile, setStatus)) return;
      setStatus('signed_out');
    }
  }, [applyDemoSession, loadMe]);

  useEffect(() => {
    void bootstrap();
    if (DEMO_MODE || !SUPABASE_CONFIGURED) return;
    const { data: sub } = supabase().auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, [bootstrap]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      if (DEMO_MODE) {
        const res = await api<{ token: string }>('/auth/demo-login', {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        });
        await applyDemoSession(res.token);
        return;
      }
      const { error } = await supabase().auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message);
      const { data } = await supabase().auth.getSession();
      setSession(data.session);
      if (!data.session) throw new Error('Sign-in did not produce a session');
      // A code entered at registration (before email confirmation, when
      // sessions weren't issued) is completed here, once sign-in works.
      const pending = localStorage.getItem(PENDING_CODE_KEY);
      if (pending) {
        localStorage.removeItem(PENDING_CODE_KEY);
        try {
          await completeRegistration(data.session.access_token, pending);
        } catch {
          /* invalid code — backend already removed the account */
        }
        try {
          await loadMe(data.session.access_token);
          setStatus('online');
          setOfflineSession(await getOfflineSession());
        } catch {
          await supabase().auth.signOut({ scope: 'local' });
          throw new Error('Registration was not completed. Please register again with a valid code.');
        }
        return;
      }
      await loadMe(data.session.access_token);
      setOfflineSession(await getOfflineSession());
      setStatus('online');
    },
    [applyDemoSession, loadMe],
  );

  const register = useCallback(
    async (fullName: string, email: string, password: string, code: string) => {
      if (DEMO_MODE) {
        throw new Error('Registration is disabled in demo mode. Sign in with admin@demo.local or judge@demo.local.');
      }
      const { data, error } = await supabase().auth.signUp({
        email,
        password,
        options: { data: { full_name: fullName } },
      });
      if (error) throw new Error(error.message);
      if (data.user && !data.session) {
        // Email confirmation still enabled on this project: finish after
        // the user confirms and signs in.
        localStorage.setItem(PENDING_CODE_KEY, code);
        return;
      }
      if (!data.session) throw new Error('Registration did not produce a session');
      try {
        await completeRegistration(data.session.access_token, code);
      } catch (e) {
        // Invalid code — the backend destroyed the account. Sign out locally
        // and surface the reason.
        await supabase().auth.signOut({ scope: 'local' });
        if (e instanceof ApiError && e.status === 429) throw new Error(e.message);
        throw new Error('Invalid code. Your account was not created.');
      }
    },
    [],
  );

  const signOut = useCallback(async () => {
    localStorage.removeItem(DEMO_TOKEN_KEY);
    if (!DEMO_MODE) {
      try {
        await supabase().auth.signOut({ scope: 'local' });
      } catch {
        /* offline — local wipe still proceeds */
      }
    }
    await wipeLocalData();
    setSession(null);
    setProfile(null);
    setPanels([]);
    setOfflineSession(null);
    setStatus('signed_out');
  }, []);

  const getToken = useCallback(async () => {
    if (DEMO_MODE) return localStorage.getItem(DEMO_TOKEN_KEY);
    if (!SUPABASE_CONFIGURED) return null;
    const { data } = await supabase().auth.getSession();
    return data.session?.access_token ?? null;
  }, []);

  const refreshMe = useCallback(async () => {
    const token = await getToken();
    if (!token) throw new Error('Not signed in');
    await loadMe(token);
    setStatus('online');
  }, [getToken, loadMe]);

  const value = useMemo<AuthState>(
    () => ({
      status,
      session,
      profile,
      panels,
      offlineSession,
      signIn,
      register,
      signOut,
      getToken,
      refreshMe,
      isOfflineSession: status === 'offline',
    }),
    [status, session, profile, panels, offlineSession, signIn, register, signOut, getToken, refreshMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
