import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useAuth } from './auth';
import { getMeta } from './idb';
import { useOnline } from './net';
import { prepareOfflineData, type OfflinePrepResult } from './offlinePrep';
import { useSync } from './syncContext';

interface OfflinePrepState {
  preparing: boolean;
  ready: boolean;
  error: string | null;
  report: string | null;
  refresh: () => Promise<void>;
}

const Ctx = createContext<OfflinePrepState | null>(null);

export function OfflinePrepProvider({ children }: { children: React.ReactNode }) {
  const { getToken, panels, profile, status } = useAuth();
  const online = useOnline();
  const { syncNow } = useSync();
  const [preparing, setPreparing] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    void getMeta<boolean>('offline_prepared').then((value) => setReady(!!value));
  }, []);

  const prepare = useCallback(async () => {
    if (inFlight.current) return;
    if (
      status !== 'online' ||
      !online ||
      !profile ||
      profile.role === 'admin' ||
      panels.length === 0
    ) {
      return;
    }

    inFlight.current = true;
    setPreparing(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error('Session expired — sign in again to prepare offline data.');
      const result: OfflinePrepResult = await prepareOfflineData(token, profile.id);
      setReady(true);
      setReport(
        `Offline data updated: ${result.candidates} candidate(s), ${result.rounds} open round(s), ${result.criteria} criteria stored locally.`,
      );
      void syncNow().catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Offline preparation failed.');
    } finally {
      inFlight.current = false;
      setPreparing(false);
    }
  }, [getToken, online, panels.length, profile?.id, profile?.role, status, syncNow]);

  useEffect(() => {
    void prepare();
  }, [prepare]);

  return (
    <Ctx.Provider value={{ preparing, ready, error, report, refresh: prepare }}>
      {children}
    </Ctx.Provider>
  );
}

export function useOfflinePrep(): OfflinePrepState {
  const value = useContext(Ctx);
  if (!value) throw new Error('useOfflinePrep must be used inside OfflinePrepProvider');
  return value;
}
