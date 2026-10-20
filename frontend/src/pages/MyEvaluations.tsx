import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { listOutbox } from '../lib/idb';
import { useOnline } from '../lib/net';
import { useSync } from '../lib/syncContext';
import { PageHeader } from '../components/PageHeader';
import { SortableTh, useSort } from '../components/Sortable';
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

export function MyEvaluations() {
  const { getToken } = useAuth();
  const online = useOnline();
  const { refresh } = useSync();
  const [server, setServer] = useState<EvaluationWithScores[] | null>(null);
  const [local, setLocal] = useState<OutboxItem[]>([]);
  const [verticals, setVerticals] = useState<Vertical[]>([]);

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
          }
        } catch {
          setServer(null);
        }
      }
    })();
  }, [getToken, online, refresh]);

  return (
    <>
      <PageHeader
        title="My evaluations"
        description="Local drafts on this device and evaluations already submitted to the server."
        actions={
          <Link className="btn secondary" to="/sync">
            Sync status
          </Link>
        }
      />
      <section className="section">
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
                </div>
              </div>
            ))
        )}
      </section>

      <section className="section">
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
          <>
            <div className="table-wrap card desktop-table" style={{ padding: 0 }}>
              <table className="data">
                <thead>
                  <tr>
                    <SortableTh label="Candidate" sortKey="candidate" state={sort} />
                    <SortableTh label="Round" sortKey="round" state={sort} />
                    <SortableTh label="Score" sortKey="score" state={sort} />
                    <SortableTh label="Version" sortKey="version" state={sort} />
                    <SortableTh label="Submitted" sortKey="submitted" state={sort} />
                  </tr>
                </thead>
                <tbody>
                  {sort.sorted.map((e) => (
                    <tr key={e.id}>
                      <td>{e.candidate_name ?? e.candidate_id}</td>
                      <td>{e.round_name ?? e.round_id}</td>
                      <td>{e.overall_score ?? '—'}</td>
                      <td>v{e.version}</td>
                      <td>{new Date(e.submitted_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="stack-list">
              {sort.sorted.map((e) => (
                <article className="stack-card" key={e.id}>
                  <div className="stack-card-head">
                    <strong>{e.candidate_name ?? e.candidate_id}</strong>
                    <span className="badge ok">Submitted</span>
                  </div>
                  <dl>
                    <div>
                      <dt>Round</dt>
                      <dd>{e.round_name ?? e.round_id}</dd>
                    </div>
                    <div>
                      <dt>Score</dt>
                      <dd>{e.overall_score ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>Version</dt>
                      <dd>v{e.version}</dd>
                    </div>
                    <div>
                      <dt>Submitted</dt>
                      <dd>{new Date(e.submitted_at).toLocaleString()}</dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>
          </>
        )}
      </section>
    </>
  );
}
