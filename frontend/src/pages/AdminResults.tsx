import { Fragment, useCallback, useEffect, useState } from 'react';
import { api, downloadCsv } from '../lib/api';
import { useAuth } from '../lib/auth';
import { SortableTh, useSort } from '../components/Sortable';
import { AdminCandidateProfile } from '../components/AdminCandidateProfile';
import { ConfirmDialog } from '../components/Ui';
import type { JudgeRating, Panel, ResultRow, Vertical } from '../lib/types';

const SERVER_SORT_KEYS = ['name', 'branch', 'average', 'priority', 'roll', 'created'];

export function AdminResults() {
  const { getToken } = useAuth();
  const [rows, setRows] = useState<ResultRow[]>([]);
  const [panels, setPanels] = useState<Panel[]>([]);
  const [verticals, setVerticals] = useState<Vertical[]>([]);
  const [search, setSearch] = useState('');
  const [branch, setBranch] = useState('');
  const [panelId, setPanelId] = useState('');
  const [verticalId, setVerticalId] = useState('');
  const [shift, setShift] = useState('');
  const [evalStatus, setEvalStatus] = useState('');
  const [interviewStatus, setInterviewStatus] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ rating: JudgeRating; candidate: ResultRow } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getSortValue = useCallback((r: ResultRow, key: string): unknown => {
    switch (key) {
      case 'name':
        return r.full_name;
      case 'branch':
        return r.branch;
      case 'panel':
        return r.panel_name;
      case 'vertical':
        return r.vertical_name;
      case 'average':
        return r.average_score;
      case 'evaluations':
        return r.evaluation_count;
      case 'status':
        return r.interview_status;
      default:
        return '';
    }
  }, []);
  const sort = useSort(rows, getSortValue, 'average', 'desc');

  const qs = useCallback(() => {
    const p = new URLSearchParams();
    if (search) p.set('search', search);
    if (branch) p.set('branch', branch);
    if (panelId) p.set('panelId', panelId);
    if (verticalId) p.set('verticalId', verticalId);
    if (shift) p.set('shift', shift);
    if (evalStatus) p.set('evaluationStatus', evalStatus);
    if (interviewStatus) p.set('interviewStatus', interviewStatus);
    p.set('sort', sort.sortKey && SERVER_SORT_KEYS.includes(sort.sortKey) ? sort.sortKey : 'name');
    p.set('order', sort.sortDir);
    return p.toString();
  }, [search, branch, panelId, verticalId, shift, evalStatus, interviewStatus, sort.sortKey, sort.sortDir]);

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    try {
      const res = await api<{ results: ResultRow[] }>(`/results?${qs()}`, { token });
      setRows(res.results);
      const p = await api<{ panels: Panel[] }>('/panels', { token });
      setPanels(p.panels);
      const v = await api<{ verticals: Vertical[] }>('/verticals', { token });
      setVerticals(v.verticals);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load results');
    }
  }, [getToken, qs]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 200);
    return () => clearTimeout(t);
  }, [load]);

  const exportCsv = async (kind: 'summary' | 'detailed') => {
    const token = await getToken();
    if (!token) return;
    try {
      await downloadCsv(`/export/${kind}.csv?${qs()}`, token, `results-${kind}.csv`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    }
  };

  const removeEvaluation = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error('Session expired. Sign in again.');
      await api(`/evaluations/${deleteTarget.rating.evaluation_id}`, { method: 'DELETE', token });
      setDeleteTarget(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete evaluation');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <h1>Results</h1>
      <p className="muted">Review completion, final averages, and individual interviewer ratings.</p>
      {error && <div className="alert error">{error}</div>}
      <div className="card">
        <div className="filters">
          <div>
            <label>Name / application ID</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div>
            <label>Branch</label>
            <input value={branch} onChange={(e) => setBranch(e.target.value)} />
          </div>
          <div>
            <label>Panel</label>
            <select value={panelId} onChange={(e) => setPanelId(e.target.value)}>
              <option value="">All</option>
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
            <label>Evaluation completion</label>
            <select value={evalStatus} onChange={(e) => setEvalStatus(e.target.value)}>
              <option value="">Any</option>
              <option value="not_started">Not started</option>
              <option value="in_progress">In progress</option>
              <option value="complete">Complete</option>
            </select>
          </div>
          <div>
            <label>Interview status</label>
            <select value={interviewStatus} onChange={(e) => setInterviewStatus(e.target.value)}>
              <option value="">Any</option>
              <option value="pending">Pending</option>
              <option value="in_progress">In progress</option>
              <option value="completed">Completed</option>
              <option value="no_show">No show</option>
            </select>
          </div>
          <button className="btn" onClick={() => void exportCsv('summary')}>
            Export summary CSV
          </button>
          <button className="btn secondary" onClick={() => void exportCsv('detailed')}>
            Export detailed CSV
          </button>
        </div>
      </div>

      <div className="table-wrap card" style={{ padding: 0 }}>
        <table className="data">
          <thead>
            <tr>
              <SortableTh label="Candidate" sortKey="name" state={sort} />
              <SortableTh label="Branch" sortKey="branch" state={sort} />
              <SortableTh label="Panel" sortKey="panel" state={sort} title="Sorts Panel 1, Panel 2, … numerically" />
              <SortableTh label="Vertical / shift" sortKey="vertical" state={sort} />
              <SortableTh label="Final avg" sortKey="average" state={sort} />
              <th>Individual scores</th>
              <SortableTh label="Evaluations" sortKey="evaluations" state={sort} />
              <SortableTh label="Status" sortKey="status" state={sort} />
            </tr>
          </thead>
          <tbody>
            {sort.sorted.map((r) => (
              <Fragment key={r.candidate_id}>
                <tr>
                  <td>
                    <button
                      className="btn secondary small"
                      onClick={() => setExpanded(expanded === r.candidate_id ? null : r.candidate_id)}
                    >
                      {expanded === r.candidate_id ? '▾' : '▸'} {r.full_name}
                    </button>
                    {r.roll_number ? <span className="muted mono"> {r.roll_number}</span> : null}
                    {r.priority ? <span className="badge blue">P{r.priority}</span> : null}
                    <button
                      className="btn secondary small"
                      style={{ marginLeft: '0.4rem' }}
                      onClick={() => setProfileId(r.candidate_id)}
                    >
                      Full profile
                    </button>
                  </td>
                  <td>{r.branch}</td>
                  <td>{r.panel_name}</td>
                  <td>
                    {r.vertical_name ?? <span className="muted">—</span>}
                    {r.shift ? <div className="muted" style={{ fontSize: '0.75rem' }}>{r.shift}</div> : null}
                  </td>
                  <td>
                    {r.average_score === null ? (
                      <span className="muted">—</span>
                    ) : (
                      <>
                        <strong>{r.average_score.toFixed(2)}</strong>
                        {r.is_provisional && r.evaluation_count > 0 && (
                          <span className="badge warn" title="Panel evaluation not yet complete — provisional">
                            provisional
                          </span>
                        )}
                      </>
                    )}
                  </td>
                  <td className="mono" style={{ fontSize: '0.8rem' }}>
                    {r.judge_ratings.length > 0
                      ? r.judge_ratings.map((jr) => (jr.score === null ? '—' : Number(jr.score).toFixed(2))).join(' · ')
                      : <span className="muted">—</span>}
                  </td>
                  <td>
                    {r.evaluation_count}/{r.expected_evaluations}{' '}
                    <span
                      className={`badge ${
                        r.evaluation_status === 'complete' ? 'ok' : r.evaluation_status === 'in_progress' ? 'warn' : 'neutral'
                      }`}
                    >
                      {r.evaluation_status.replace('_', ' ')}
                    </span>
                  </td>
                  <td>
                    <span className="badge neutral">{r.interview_status.replace('_', ' ')}</span>{' '}
                    <span className="badge blue">{r.shortlisting_status}</span>
                  </td>
                </tr>
                {expanded === r.candidate_id && (
                  <tr>
                    <td colSpan={8}>
                      {r.judge_ratings.length === 0 ? (
                        <span className="muted">No evaluations yet — not counted as zero.</span>
                      ) : (
                        <table className="data" style={{ background: 'transparent' }}>
                          <thead>
                            <tr>
                              <th>Judge</th>
                              <th>Score</th>
                              <th>Version</th>
                              <th>Submitted</th>
                              <th></th>
                            </tr>
                          </thead>
                          <tbody>
                            {r.judge_ratings.map((jr) => (
                              <tr key={jr.evaluation_id}>
                                <td>{jr.judge_name || jr.judge_id}</td>
                                <td>{jr.score ?? '—'}</td>
                                <td>v{jr.version}</td>
                                <td>{new Date(jr.submitted_at).toLocaleString()}</td>
                                <td>
                                  <button
                                    className="btn danger small"
                                    disabled={deleting}
                                    onClick={() => setDeleteTarget({ rating: jr, candidate: r })}
                                  >
                                    Delete
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="empty">No candidates match the filters.</div>}
      </div>

      {profileId && <AdminCandidateProfile candidateId={profileId} onClose={() => setProfileId(null)} />}

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete this evaluation?"
        message={
          deleteTarget
            ? `${deleteTarget.rating.judge_name || deleteTarget.rating.judge_id}'s evaluation for ${deleteTarget.candidate.full_name} will be removed from the server and the candidate's results will be recalculated. This cannot be undone.`
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
