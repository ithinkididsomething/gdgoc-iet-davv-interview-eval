import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { deleteOutboxItem, listOutbox } from '../lib/idb';
import { useOnline } from '../lib/net';
import { useSync } from '../lib/syncContext';
import { SortableTh, useSort } from '../components/Sortable';
import { ConfirmDialog } from '../components/Ui';
import type { EvaluationWithScores, OutboxItem, Vertical } from '../lib/types';

const statusBadge = (s: OutboxItem['status']) => {
  switch (s) {
    case 'synced':
      return <span className="badge ok">Synced</span>;
    case 'conflict':
      return <span className="badge err">Conflict</span>;
    case 'error':
      return <span className="badge err">Failed</span>;
    case 'syncing':
      return <span className="badge blue">Syncing</span>;
    default:
      return <span className="badge warn">Pending</span>;
  }
};

interface DeleteTarget {
  id: string;
  candidate: string;
  status?: OutboxItem['status'];
}

export function MyEvaluations() {
  const { getToken } = useAuth();
  const online = useOnline();
  const { refresh } = useSync();
  const [server, setServer] = useState<EvaluationWithScores[] | null>(null);
  const [local, setLocal] = useState<OutboxItem[]>([]);
  const [verticals, setVerticals] = useState<Vertical[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const getSortValue = useCallback((e: EvaluationWithScores, key: string): unknown => {
    switch (key) {
      case 'candidate':
        return e.candidate_name ?? e.candidate_id;
      case 'round':
        return e.round_name ?? e.round_id;
      case 'score':
        return e.overall_score;
      case 'version':
        return e.version;
      case 'submitted':
        return e.submitted_at;
      default:
        return '';
    }
  }, []);
  const sort = useSort(server ?? [], getSortValue, 'submitted', 'desc');

  useEffect(() => {
    if (!online) return;
    void getToken()
      .then((token) => (token ? api<{ verticals: Vertical[] }>('/verticals', { token }) : null))
      .then((r) => r && setVerticals(r.verticals))
      .catch(() => undefined);
  }, [online, getToken]);

  useEffect(() => {
    void (async () => {
      await refresh();
      setLocal(await listOutbox());
      if (online) {
        try {
          const token = await getToken();
          if (token) {
            const res = await api<{ evaluations: EvaluationWithScores[] }>('/evaluations/mine', { token });
            setServer(res.evaluations);
            if (res.evaluations.length < 200) {
              const serverIds = new Set(res.evaluations.map((e) => e.id));
              const stale = (await listOutbox()).filter((i) => i.status === 'synced' && !serverIds.has(i.id));
              if (stale.length > 0) {
                for (const item of stale) await deleteOutboxItem(item.id);
                await refresh();
                setLocal(await listOutbox());
              }
            }
          }
        } catch {
          setServer(null);
        }
      }
    })();
  }, [getToken, online, refresh]);

  const removeEvaluation = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setError(null);
    setNotice(null);
    try {
      if (!online) throw new Error('Connect to the internet to remove the server copy.');
      if (deleteTarget.status === 'syncing') {
        throw new Error('Wait for the current sync to finish, then delete again.');
      }
      const token = await getToken();
      if (!token) throw new Error('Session expired. Sign in again.');
      try {
        await api(`/evaluations/${deleteTarget.id}`, { method: 'DELETE', token });
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 404) throw e;
      }
      await deleteOutboxItem(deleteTarget.id);
      await refresh();
      setLocal(await listOutbox());
      setServer((prev) => (prev ? prev.filter((e) => e.id !== deleteTarget.id) : prev));
      setNotice(`${deleteTarget.candidate}'s evaluation was removed from this device and the server.`);
      setDeleteTarget(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete evaluation');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <h1>My evaluations</h1>
      <p className="muted">Your saved drafts and submitted evaluations across every interview round.</p>
      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert success">{notice}</div>}
      <h2>On this device</h2>
      {local.length === 0 ? (
        <div className="card empty">No locally stored evaluations.</div>
      ) : (
        local
          .slice()
          .reverse()
          .map((item) => (
            <div className="card tight outbox-item" key={item.id}>
              <div className="head">
                <strong>{item.candidate_name || item.candidate_id}</strong>
                <span>{statusBadge(item.status)}</span>
              </div>
              <div className="muted">
                {item.round_name} · score {item.overall_score ?? '—'} ·{' '}
                {new Date(item.client_created_at).toLocaleString()}
                {item.attempts > 0 ? ` · ${item.attempts} attempt(s)` : ''}
              </div>
              {item.last_error && <div className="muted">Last error: {item.last_error}</div>}
              <div className="btn-row mt">
                <Link className="btn secondary small" to={`/candidates/${item.candidate_id}/evaluate`}>
                  Open
                </Link>
                <Link className="btn secondary small" to="/sync">
                  Sync status
                </Link>
                <button
                  className="btn danger small"
                  disabled={item.status === 'syncing' || deleting}
                  onClick={() =>
                    setDeleteTarget({
                      id: item.id,
                      candidate: item.candidate_name || item.candidate_id,
                      status: item.status,
                    })
                  }
                >
                  Delete
                </button>
              </div>
            </div>
          ))
      )}

      <h2>Submitted (server)</h2>
      {!online ? (
        <div className="alert warn">Offline — server history is unavailable.</div>
      ) : server === null ? (
        <div className="empty">
          <span className="spinner" /> Loading…
        </div>
      ) : server.length === 0 ? (
        <div className="card empty">No submitted evaluations yet.</div>
      ) : (
        <div className="table-wrap card" style={{ padding: 0 }}>
          <table className="data">
            <thead>
              <tr>
                <SortableTh label="Candidate" sortKey="candidate" state={sort} />
                <SortableTh label="Round" sortKey="round" state={sort} />
                <th>Preferred vertical</th>
                <SortableTh label="Score" sortKey="score" state={sort} />
                <SortableTh label="Version" sortKey="version" state={sort} />
                <SortableTh label="Submitted" sortKey="submitted" state={sort} />
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((e) => (
                <tr key={e.id}>
                  <td>{e.candidate_name ?? e.candidate_id}</td>
                  <td>{e.round_name ?? e.round_id}</td>
                  <td>
                    {e.preferred_vertical_id
                      ? verticals.find((v) => v.id === e.preferred_vertical_id)?.name ?? e.preferred_vertical_id
                      : '—'}
                  </td>
                  <td>{e.overall_score ?? '—'}</td>
                  <td>v{e.version}</td>
                  <td>{new Date(e.submitted_at).toLocaleString()}</td>
                  <td>
                    <Link className="btn secondary small" to={`/candidates/${e.candidate_id}/evaluate`}>
                      Edit
                    </Link>{' '}
                    <button
                      className="btn danger small"
                      disabled={deleting}
                      onClick={() =>
                        setDeleteTarget({
                          id: e.id,
                          candidate: e.candidate_name ?? e.candidate_id,
                        })
                      }
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete this evaluation?"
        message={
          deleteTarget
            ? `${deleteTarget.candidate}'s evaluation will be removed from this device and the server. The candidate can then be evaluated again. This cannot be undone.`
            : ''
        }
        confirmLabel={deleting ? 'Deleting...' : 'Delete permanently'}
        danger
        onConfirm={() => void removeEvaluation()}
        onCancel={() => {
          if (!deleting) setDeleteTarget(null);
        }}
      />
    </>
  );
}
