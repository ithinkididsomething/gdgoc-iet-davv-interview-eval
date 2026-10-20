import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { listCachedCandidates, listCachedRounds } from '../lib/idb';
import { useOnline } from '../lib/net';
import { useOfflinePrep } from '../lib/offlinePrepContext';
import { useSync } from '../lib/syncContext';

export function OfflinePrep() {
  const { status } = useAuth();
  const online = useOnline();
  const { pending, lastSyncAt, syncNow } = useSync();
  const { preparing, ready, error, report, refresh } = useOfflinePrep();
  const [cachedCount, setCachedCount] = useState(0);
  const [roundsCount, setRoundsCount] = useState(0);

  const refreshStatus = useCallback(async () => {
    setCachedCount((await listCachedCandidates()).length);
    setRoundsCount((await listCachedRounds()).length);
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus, pending, preparing]);

  return (
    <>
      <h1>Offline preparation</h1>
      <p className="muted">
        Offline data is prepared automatically whenever you are signed in online. Judges can then
        interview and rate candidates without internet; evaluations are stored in this browser
        (IndexedDB) and uploaded automatically when the connection returns.
      </p>

      <div className="card">
        <h3>Readiness</h3>
        <p>
          {preparing ? (
            <span className="badge blue">
              <span className="spinner" style={{ width: 10, height: 10, borderWidth: 2 }} />{' '}
              Preparing automatically
            </span>
          ) : ready ? (
            <span className="badge ok">Ready for offline interviews</span>
          ) : (
            <span className="badge warn">
              {error ? 'Waiting to retry' : 'Preparing automatically'}
            </span>
          )}
        </p>
        <ul className="muted">
          <li>Cached candidates: {cachedCount}</li>
          <li>Cached open rounds: {roundsCount}</li>
          <li>
            Last successful sync:{' '}
            {lastSyncAt ? new Date(lastSyncAt).toLocaleString() : 'never on this device'}
          </li>
          <li>Queued evaluations: {pending}</li>
          <li>Network: {online ? 'online' : 'offline'}</li>
          <li>
            App installed / service worker:{' '}
            {typeof window !== 'undefined' && 'serviceWorker' in navigator ? 'supported' : 'not supported'}
          </li>
        </ul>
        {status === 'offline' && (
          <div className="alert warn">
            You are on an offline session. Automatic preparation and synchronization require
            signing in while online.
          </div>
        )}
        {error && (
          <div className="alert error">
            {error}{' '}
            <button className="btn secondary small" onClick={() => void refresh()}>
              Retry now
            </button>
          </div>
        )}
        {report && !preparing && <div className="alert success">{report}</div>}
        <div className="btn-row">
          <button className="btn secondary" onClick={() => void syncNow()} disabled={preparing || !online}>
            Sync now
          </button>
          <Link className="btn secondary" to="/candidates">
            Open candidate list
          </Link>
        </div>
      </div>

      <div className="card">
        <h3>How offline mode behaves</h3>
        <ul className="muted">
          <li>Candidate and round data refresh automatically after sign-in and on future visits.</li>
          <li>Submitted evaluations are saved locally first and confirmed before counting as synced.</li>
          <li>
            The offline session expires after a configurable period (default 12 hours); after that you
            must sign in again.
          </li>
          <li>
            On shared devices, use <strong>Log out</strong> — it wipes all locally cached candidates
            and evaluations.
          </li>
        </ul>
      </div>
    </>
  );
}
