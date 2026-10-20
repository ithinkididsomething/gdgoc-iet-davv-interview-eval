import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from './auth';
import { useOnline } from './net';
import { getLastSyncAt, SyncEngine, type SyncReport } from './sync';
import { listOutbox } from './idb';
import { scheduleSheetSync } from './sheetSync';

interface SyncCtx {
  engine: SyncEngine;
  pending: number;
  conflicts: number;
  errors: number;
  synced: number;
  running: boolean;
  lastReport: SyncReport | null;
  lastSyncAt: string | null;
  refresh: () => Promise<void>;
  syncNow: () => Promise<SyncReport>;
}

const Ctx = createContext<SyncCtx | null>(null);

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const { getToken, status } = useAuth();
  const online = useOnline();
  const engine = useMemo(() => new SyncEngine(getToken), [getToken]);
  const [counts, setCounts] = useState({ pending: 0, conflicts: 0, errors: 0, synced: 0 });
  const [running, setRunning] = useState(false);
  const [lastReport, setLastReport] = useState<SyncReport | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const items = await listOutbox();
    setCounts({
      pending: items.filter((i) => i.status === 'pending').length,
      errors: items.filter((i) => i.status === 'error').length,
      conflicts: items.filter((i) => i.status === 'conflict').length,
      synced: items.filter((i) => i.status === 'synced').length,
    });
    setLastSyncAt(await getLastSyncAt());
    setRunning(engine.isRunning());
    setLastReport(engine.getLastReport());
  }, [engine]);

  const syncNow = useCallback(async () => {
    const report = await engine.syncNow();
    await refresh();
    if (report.synced > 0) scheduleSheetSync(getToken);
    return report;
  }, [engine, refresh, getToken]);

  useEffect(() => {
    const unsub = engine.subscribe(() => {
      void refresh();
    });
    void refresh();
    return unsub;
  }, [engine, refresh]);

  // Automatic sync: startup, network recovery, tab visibility.
  useEffect(() => {
    if (status !== 'online') return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') void syncNow();
    };
    window.addEventListener('online', syncNow);
    document.addEventListener('visibilitychange', onVisible);
    if (online) void syncNow();
    return () => {
      window.removeEventListener('online', syncNow);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [status, online, syncNow]);

  const value = useMemo<SyncCtx>(
    () => ({
      engine,
      ...counts,
      running,
      lastReport,
      lastSyncAt,
      refresh,
      syncNow,
    }),
    [engine, counts, running, lastReport, lastSyncAt, refresh, syncNow],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSync(): SyncCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSync must be used within SyncProvider');
  return ctx;
}
