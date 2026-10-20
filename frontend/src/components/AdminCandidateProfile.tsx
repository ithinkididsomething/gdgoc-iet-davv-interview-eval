import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { CandidateProfile } from './eval/CandidateProfile';
import type { Candidate, EvaluationWithScores, Panel, ResultRow, Vertical } from '../lib/types';

interface ProfileScore {
  criterion_id: string;
  score: number;
  feedback?: string;
  criterion_name: string;
  max_score: number | null;
}

interface ProfileEvaluation extends EvaluationWithScores {
  preferred_vertical_name: string | null;
  scores: ProfileScore[];
}

interface ProfileData {
  candidate: Candidate;
  panel: Panel | null;
  panel_members: { judge_id: string; judge_name: string; verified_at: string | null }[];
  vertical: Vertical | null;
  result: ResultRow | null;
  evaluations: ProfileEvaluation[];
}

function prettyLabel(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function AdminCandidateProfile({
  candidateId,
  onClose,
}: {
  candidateId: string;
  onClose: () => void;
}) {
  const { getToken } = useAuth();
  const [data, setData] = useState<ProfileData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const token = await getToken();
      if (!token) return;
      try {
        const res = await api<ProfileData>(`/admin/candidates/${candidateId}/profile`, { token });
        if (!cancelled) setData(res);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load profile');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [candidateId, getToken]);

  return (
    <div
      className="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Applicant profile"
      onClick={onClose}
    >
      <div className="dialog wide" onClick={(e) => e.stopPropagation()}>
        <div className="profile-modal-head">
          <div>
            <h3>{data?.candidate.full_name ?? 'Applicant profile'}</h3>
            {data && (
              <p className="muted">
                {[
                  data.candidate.roll_number || data.candidate.application_id,
                  data.candidate.branch,
                  data.panel?.name,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            )}
          </div>
          <button className="btn secondary small" onClick={onClose}>
            Close
          </button>
        </div>
        {error && <div className="alert error mt">{error}</div>}
        {!data && !error && (
          <div className="empty">
            <span className="spinner" /> Loading profile.
          </div>
        )}
        {data && (
          <>
            <div className="btn-row mt" style={{ flexWrap: 'wrap' }}>
              <span className="badge neutral">Interview: {prettyLabel(data.candidate.interview_status)}</span>
              <span className="badge blue">Shortlisting: {prettyLabel(data.candidate.shortlisting_status)}</span>
              {data.candidate.archived_at && <span className="badge err">Archived</span>}
              <span className="badge neutral">{data.panel?.name ?? 'No panel'}</span>
              <span className="badge neutral">{data.vertical?.name ?? 'Unassigned vertical'}</span>
              {data.candidate.shift && <span className="badge neutral">{data.candidate.shift}</span>}
              {data.candidate.priority ? <span className="badge blue">P{data.candidate.priority}</span> : null}
            </div>

            <CandidateProfile candidate={data.candidate} verticalName={data.vertical?.name} />

            <div className="grid cols-2 mt">
              <div className="card">
                <h4 style={{ marginTop: 0 }}>Panel</h4>
                <p className="muted" style={{ marginTop: 0 }}>
                  Expected evaluations: {data.panel?.expected_evaluations ?? '—'}
                </p>
                {data.panel_members.length === 0 ? (
                  <span className="muted">No judges assigned.</span>
                ) : (
                  <ul className="link-list">
                    {data.panel_members.map((m) => (
                      <li key={m.judge_id}>
                        {m.judge_name}{' '}
                        <span className="muted">
                          {m.verified_at
                            ? `verified ${new Date(m.verified_at).toLocaleDateString()}`
                            : 'not verified'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="card">
                <h4 style={{ marginTop: 0 }}>Result</h4>
                {data.result ? (
                  <div className="profile-grid">
                    <div>
                      <span className="label">Final average</span>
                      <span>
                        {data.result.average_score === null
                          ? '—'
                          : data.result.average_score.toFixed(2)}
                      </span>
                    </div>
                    <div>
                      <span className="label">Evaluations</span>
                      <span>
                        {data.result.evaluation_count}/{data.result.expected_evaluations}
                      </span>
                    </div>
                    <div>
                      <span className="label">Status</span>
                      <span>
                        {prettyLabel(data.result.evaluation_status)}
                        {data.result.is_provisional ? ' (provisional)' : ''}
                      </span>
                    </div>
                    <div>
                      <span className="label">Provisional</span>
                      <span>{data.result.is_provisional ? 'Yes' : 'No'}</span>
                    </div>
                  </div>
                ) : (
                  <span className="muted">No result row yet.</span>
                )}
              </div>
            </div>

            <h4 className="mt">Evaluations ({data.evaluations.length})</h4>
            {data.evaluations.length === 0 && (
              <div className="empty">No judge has submitted an evaluation for this applicant.</div>
            )}
            {data.evaluations.map((e) => (
              <div className="card mt" key={e.id}>
                <div className="profile-eval-head">
                  <strong>{e.judge_name ?? e.judge_id}</strong>
                  <span className="muted">
                    {e.round_name ?? e.round_id} · v{e.version} · {new Date(e.submitted_at).toLocaleString()}
                  </span>
                </div>
                <div className="profile-grid mt">
                  <div>
                    <span className="label">Overall</span>
                    <span>{e.overall_score ?? '—'}</span>
                  </div>
                  <div>
                    <span className="label">Status</span>
                    <span>{prettyLabel(e.status)}</span>
                  </div>
                  <div>
                    <span className="label">Preferred vertical</span>
                    <span>{e.preferred_vertical_name ?? '—'}</span>
                  </div>
                </div>
                {e.feedback?.trim() && (
                  <div className="mt">
                    <span className="profile-note-label">Written remark</span>
                    <div className="profile-note">{e.feedback}</div>
                  </div>
                )}
                <div className="table-wrap mt">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Criterion</th>
                        <th>Score</th>
                        <th>Remark</th>
                      </tr>
                    </thead>
                    <tbody>
                      {e.scores.map((s) => (
                        <tr key={s.criterion_id}>
                          <td>{s.criterion_name}</td>
                          <td>
                            {s.score}
                            {s.max_score !== null ? ` / ${s.max_score}` : ''}
                          </td>
                          <td>{s.feedback?.trim() || <span className="muted">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
