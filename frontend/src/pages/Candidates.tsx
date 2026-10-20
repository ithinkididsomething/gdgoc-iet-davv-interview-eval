import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { listCachedCandidates, saveCandidates } from '../lib/idb';
import { useOnline } from '../lib/net';
import { PageHeader } from '../components/PageHeader';
import { SortableTh, useSort } from '../components/Sortable';
import type { Candidate, Vertical } from '../lib/types';

const STATUS_TONE: Record<string, string> = {
  pending: 'neutral',
  in_progress: 'blue',
  completed: 'ok',
  no_show: 'err',
};

export function Candidates() {
  const { getToken, panels } = useAuth();
  const online = useOnline();
  const [params] = useSearchParams();
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [source, setSource] = useState<'server' | 'cache'>('server');
  const [verticals, setVerticals] = useState<Vertical[]>([]);
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [branch, setBranch] = useState('');
  const [panelId, setPanelId] = useState('');
  const [verticalId, setVerticalId] = useState('');
  const [shift, setShift] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    if (online) {
      try {
        const token = await getToken();
        if (!token) throw new Error('Session expired — sign in again');
        const qs = new URLSearchParams();
        if (search) qs.set('search', search);
        if (branch) qs.set('branch', branch);
        if (panelId) qs.set('panelId', panelId);
        if (verticalId) qs.set('verticalId', verticalId);
        if (shift) qs.set('shift', shift);
        if (status) qs.set('interviewStatus', status);
        const res = await api<{ candidates: Candidate[] }>(`/candidates?${qs}`, { token });
        // Candidates this judge has already evaluated move to "My evaluations".
        const evaluated = new Set<string>();
        try {
          const mine = await api<{ evaluations: { candidate_id: string }[] }>('/evaluations/mine', { token });
          for (const e of mine.evaluations) evaluated.add(e.candidate_id);
        } catch {
          /* pending list still works if history cannot be loaded */
        }
        const pending = res.candidates.filter((c) => !evaluated.has(c.id));
        setCandidates(pending);
        setSource('server');
        if (search === '' && branch === '' && !panelId && !verticalId && !shift && !status) {
          // Cache the unfiltered pending list for offline use
          void saveCandidates(pending);
        }
        return;
      } catch (e) {
        // fall through to cache
        setError(e instanceof Error ? e.message : 'Failed to load candidates');
      }
    }
    const cached = await listCachedCandidates(panels.map((p) => p.id));
    setCandidates(cached);
    setSource('cache');
  }, [getToken, panels, online, search, branch, panelId, verticalId, shift, status]);

  useEffect(() => {
    if (!online || verticals.length > 0) return;
    void getToken()
      .then((token) => (token ? api<{ verticals: Vertical[] }>('/verticals', { token }) : null))
      .then((r) => r && setVerticals(r.verticals))
      .catch(() => undefined);
  }, [online, verticals.length, getToken]);

  useEffect(() => {
    const q = params.get('q');
    if (q != null) setSearch(q);
  }, [params]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  const branches = useMemo(() => {
    const set = new Set((candidates ?? []).map((c) => c.branch).filter(Boolean));
    return [...set].sort();
  }, [candidates]);

  const getSortValue = useCallback(
    (c: Candidate, key: string): unknown => {
      switch (key) {
        case 'name':
          return c.full_name;
        case 'branch':
          return c.branch;
        case 'roll':
          return c.roll_number;
        case 'vertical':
          return verticals.find((v) => v.id === c.vertical_id)?.name ?? '';
        case 'priority':
          return c.priority;
        case 'application':
          return c.application_id;
        case 'status':
          return c.interview_status;
        default:
          return '';
      }
    },
    [verticals],
  );
  const sort = useSort(candidates ?? [], getSortValue, 'name');

  const verticalName = (id: string | null | undefined) =>
    id ? verticals.find((v) => v.id === id)?.name ?? id : null;

  return (
    <>
      <PageHeader
        title="Candidates"
        description={
          <>
            {source === 'cache' ? 'Showing locally cached data (offline).' : 'Loaded from the server.'}{' '}
            {candidates ? `${candidates.length} shown.` : ''}
          </>
        }
      />
      {error && source === 'cache' && (
        <div className="alert warn">Could not reach the server ({error}). Using cached data.</div>
      )}
      <div className="card">
        <div className="filters">
          <div>
            <label>Name / application ID</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…" />
          </div>
          <div>
            <label>Branch</label>
            <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="e.g. CSE" list="branch-list" />
            <datalist id="branch-list">
              {branches.map((b) => (
                <option key={b} value={b} />
              ))}
            </datalist>
          </div>
          <div>
            <label>Panel</label>
            <select value={panelId} onChange={(e) => setPanelId(e.target.value)}>
              <option value="">All my panels</option>
              {panels.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Vertical</label>
            <select value={verticalId} onChange={(e) => setVerticalId(e.target.value)}>
              <option value="">All verticals</option>
              {verticals.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Shift</label>
            <select value={shift} onChange={(e) => setShift(e.target.value)}>
              <option value="">Any</option>
              <option value="Shift 1">Shift 1</option>
              <option value="Shift 2">Shift 2</option>
            </select>
          </div>
          <div>
            <label>Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Any</option>
              <option value="pending">Pending</option>
              <option value="in_progress">In progress</option>
              <option value="completed">Completed</option>
              <option value="no_show">No show</option>
            </select>
          </div>
        </div>
      </div>

      {candidates === null ? (
        <div className="empty">
          <span className="spinner" /> Loading…
        </div>
      ) : candidates.length === 0 ? (
        <div className="empty">No candidates match your filters.</div>
      ) : (
        <>
          <div className="table-wrap card desktop-table" style={{ padding: 0 }}>
            <table className="data">
              <thead>
                <tr>
                  <SortableTh label="Name" sortKey="name" state={sort} />
                  <SortableTh label="Branch" sortKey="branch" state={sort} />
                  <SortableTh label="Roll" sortKey="roll" state={sort} />
                  <SortableTh label="Vertical / Shift" sortKey="vertical" state={sort} />
                  <SortableTh label="Priority" sortKey="priority" state={sort} />
                  <SortableTh label="Application" sortKey="application" state={sort} />
                  <SortableTh label="Status" sortKey="status" state={sort} />
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sort.sorted.map((c) => (
                  <tr key={c.id}>
                    <td>{c.full_name}</td>
                    <td>{c.branch}</td>
                    <td className="mono">{c.roll_number ?? '—'}</td>
                    <td>
                      {c.vertical_id ? (
                        <>
                          {verticalName(c.vertical_id)}
                          {c.shift ? <div className="muted" style={{ fontSize: '0.75rem' }}>{c.shift}</div> : null}
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>{c.priority ?? '—'}</td>
                    <td className="mono">{c.application_id ?? '—'}</td>
                    <td>
                      <span className={`badge ${STATUS_TONE[c.interview_status] ?? 'neutral'}`}>
                        {c.interview_status.replace('_', ' ')}
                      </span>
                    </td>
                    <td>
                      <Link className="btn small" to={`/candidates/${c.id}/evaluate`}>
                        Evaluate
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="stack-list">
            {sort.sorted.map((c) => (
              <article className="stack-card" key={c.id}>
                <div className="stack-card-head">
                  <strong>{c.full_name}</strong>
                  <span className={`badge ${STATUS_TONE[c.interview_status] ?? 'neutral'}`}>
                    {c.interview_status.replace('_', ' ')}
                  </span>
                </div>
                <dl>
                  <div>
                    <dt>Branch</dt>
                    <dd>{c.branch || '—'}</dd>
                  </div>
                  <div>
                    <dt>Roll</dt>
                    <dd className="mono">{c.roll_number ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>Vertical / shift</dt>
                    <dd>
                      {verticalName(c.vertical_id) ?? '—'}
                      {c.shift ? ` · ${c.shift}` : ''}
                    </dd>
                  </div>
                  <div>
                    <dt>Priority</dt>
                    <dd>{c.priority ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>Application</dt>
                    <dd className="mono">{c.application_id ?? '—'}</dd>
                  </div>
                </dl>
                <Link className="btn" to={`/candidates/${c.id}/evaluate`}>
                  Evaluate
                </Link>
              </article>
            ))}
          </div>
        </>
      )}
    </>
  );
}
