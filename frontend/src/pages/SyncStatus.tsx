import { useEffect, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { AnimatedNumber, ConfirmDialog, ProgressBar } from '../components/Ui';
import { useAuth } from '../lib/auth';
import { listOutbox } from '../lib/idb';
import { useOnline } from '../lib/net';
import { useSync } from '../lib/syncContext';
import type { OutboxItem } from '../lib/types';

export function SyncStatus() {
  const { status } = useAuth();
  const online = useOnline();
  const { engine, syncNow, running, lastReport, lastSyncAt, refresh } = useSync();
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [confirmClear, setConfirmClear] = useState(false);

  const reload = async () => {
    await refresh();
    setItems(await listOutbox());
  };

  useEffect(() => {
    void reload();
    const unsub = engine.subscribe(() => void reload());
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  const pending = items.filter((i) => i.status === 'pending' || i.status === 'syncing');
  const errors = items.filter((i) => i.status === 'error');
  const conflicts = items.filter((i) => i.status === 'conflict');
  const synced = items.filter((i) => i.status === 'synced');

  const total = items.length;
  const syncedPct = total > 0 ? Math.round((synced.length / total) * 100) : running ? 40 : 100;

  return (
    <>
      <PageHeader
        title="Synchronization"
        description="Upload queued evaluations, review conflicts, and confirm the last successful sync on this device."
        actions={
          <button className="btn" onClick={() => void syncNow()} disabled={running || !online || status !== 'online'}>
            {running ? 'Synchronizing…' : 'Sync now'}
          </button>
        }
      />
      <div className="card">
        <div className="grid cols-3">
          <div className="stat yellow">
            <div className="value">
              <AnimatedNumber value={pending.length + errors.length} />
            </div>
            <div className="label">Waiting</div>
          </div>
          <div className="stat red">
            <div className="value">
              <AnimatedNumber value={conflicts.length} />
            </div>
            <div className="label">Conflicts</div>
          </div>
          <div className="stat green">
            <div className="value">
              <AnimatedNumber value={synced.length} />
            </div>
            <div className="label">Synced on this device</div>
          </div>
        </div>
        <p className="muted mt">
          {online ? 'Network is available.' : 'Network is offline — items stay queued.'}{' '}
          {lastSyncAt ? `Last successful sync: ${new Date(lastSyncAt).toLocaleString()}` : 'No successful sync yet.'}
          {status === 'offline' ? ' You are on an offline session — sign in to sync.' : ''}
        </p>
        <div className="sync-progress-wrap">
          <div className="btn-row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>
              {running ? 'Uploading queued evaluations…' : errors.length ? 'Retry waiting on failed items' : 'Sync progress'}
            </span>
            <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>
              {syncedPct}%
            </span>
          </div>
          <ProgressBar
            value={syncedPct}
            tone={errors.length || conflicts.length ? 'yellow' : 'green'}
            label="Synchronization progress"
          />
        </div>
        {lastReport && <div className={`alert ${lastReport.errors || lastReport.conflicts ? 'warn' : 'success'}`}>{lastReport.message}</div>}
        <div className="btn-row">
          <button className="btn" onClick={() => void syncNow()} disabled={running || !online || status !== 'online'}>
            {running ? 'Synchronizing…' : 'Sync now'}
          </button>
          {synced.length > 0 && (
            <button className="btn secondary" onClick={() => setConfirmClear(true)}>
              Clear synced items
            </button>
          )}
        </div>
      </div>

      {[...conflicts, ...errors, ...pending].length === 0 && synced.length === 0 && (
        <div className="card empty">The outbox is empty. Evaluations you submit will appear here.</div>
      )}

      {conflicts.length > 0 && (
        <>
          <h2>Conflicts</h2>
          <div className="alert warn">
            The server already has an official evaluation for this candidate from you. Your local copy
            is preserved below and will not overwrite the server record. Review it, then either open
            the candidate (if the round allows edits) or discard the local copy.
          </div>
          {conflicts.map((item) => (
            <ConflictCard key={item.id} item={item} onChanged={reload} />
          ))}
        </>
      )}

      {errors.length > 0 && (
        <>
          <h2>Failed uploads (will retry)</h2>
          {errors.map((item) => (
            <QueueCard key={item.id} item={item} />
          ))}
        </>
      )}

      {pending.length > 0 && (
        <>
          <h2>Waiting to upload</h2>
          {pending.map((item) => (
            <QueueCard key={item.id} item={item} />
          ))}
        </>
      )}

      {synced.length > 0 && (
        <>
          <h2>Recently synchronized</h2>
          {synced
            .slice()
            .reverse()
            .map((item) => (
              <QueueCard key={item.id} item={item} />
            ))}
        </>
      )}

      <ConfirmDialog
        open={confirmClear}
        title="Clear synced items?"
        message="This removes confirmed evaluations from the local list. The server keeps the authoritative records."
        confirmLabel="Clear"
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          void engine.clearSynced().then(reload);
          setConfirmClear(false);
        }}
      />
    </>
  );
}

function QueueCard({ item }: { item: OutboxItem }) {
  return (
    <div className="card tight outbox-item">
      <div className="head">
        <strong>{item.candidate_name || item.candidate_id}</strong>
        <span className="badge neutral">{item.status}</span>
      </div>
      <div className="muted">
        {item.round_name} · score {item.overall_score ?? '—'} ·{' '}
        {new Date(item.client_created_at).toLocaleString()}
        {item.attempts > 0 ? ` · attempts: ${item.attempts}` : ''}
      </div>
      {item.last_error && <div className="muted">Last error: {item.last_error}</div>}
    </div>
  );
}

function ConflictCard({ item, onChanged }: { item: OutboxItem; onChanged: () => void }) {
  const { engine } = useSync();
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="card tight outbox-item conflict">
      <div className="head">
        <strong>{item.candidate_name || item.candidate_id}</strong>
        <span className="badge err">Conflict</span>
      </div>
      <div className="muted">
        {item.round_name} · local score {item.overall_score ?? '—'}
      </div>
      <div className="muted">{item.conflict?.message ?? item.last_error}</div>
      {item.conflict?.server ? (
        <details className="mt">
          <summary>View server record</summary>
          <pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: '0.8rem' }}>
            {JSON.stringify(item.conflict.server, null, 2)}
          </pre>
        </details>
      ) : null}
      <div className="btn-row mt">
        <button className="btn secondary small" onClick={() => setConfirm(true)}>
          Discard local copy
        </button>
      </div>
      <ConfirmDialog
        open={confirm}
        danger
        title="Discard local copy?"
        message="The locally stored evaluation will be deleted. The server's official evaluation remains."
        confirmLabel="Discard"
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          void engine.discardConflicting(item.id).then(onChanged);
          setConfirm(false);
        }}
      />
    </div>
  );
}
