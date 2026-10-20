import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  listCachedCandidates,
  listCachedCriteria,
  listCachedRounds,
  listOutbox,
  putOutboxItem,
  setMeta,
} from '../lib/idb';
import { useOnline } from '../lib/net';
import { scheduleSheetSync } from '../lib/sheetSync';
import { meanOf, displayScore } from '../lib/rubric';
import { useSync } from '../lib/syncContext';
import type { Candidate, Criterion, EvaluationWithScores, OutboxItem, Round, Vertical } from '../lib/types';
import { StarRating } from '../components/eval/StarRating';
import { ConfirmDialog, ProgressBar } from '../components/Ui';
import { CandidateProfile } from '../components/eval/CandidateProfile';

export function Evaluate() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { getToken, panels } = useAuth();
  const online = useOnline();
  const { syncNow } = useSync();

  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [rounds, setRounds] = useState<Round[]>([]);
  const [verticals, setVerticals] = useState<Vertical[]>([]);
  const [roundId, setRoundId] = useState('');
  const [criteria, setCriteria] = useState<Criterion[]>([]);
  const [scores, setScores] = useState<Record<string, number | null>>({});
  const [overall, setOverall] = useState('');
  const [feedback, setFeedback] = useState('');
  const [existingLocal, setExistingLocal] = useState<OutboxItem | null>(null);
  const [serverEvalId, setServerEvalId] = useState<string | null>(null);
  const [preferredVertical, setPreferredVertical] = useState('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'err' | 'info' | 'warn'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [savingLocal, setSavingLocal] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const loadCandidate = useCallback(async () => {
    if (!id) return;
    if (online) {
      try {
        const token = await getToken();
        if (token) {
          const res = await api<{ candidate: Candidate }>(`/candidates/${id}`, { token });
          setCandidate(res.candidate);
          return;
        }
      } catch {
        /* fall back to cache */
      }
    }
    const cached = await listCachedCandidates(panels.map((p) => p.id));
    setCandidate(cached.find((c) => c.id === id) ?? null);
  }, [id, online, getToken, panels]);

  useEffect(() => {
    void loadCandidate();
  }, [loadCandidate]);

  useEffect(() => {
    void (async () => {
      let rs: Round[] = [];
      if (online) {
        try {
          const token = await getToken();
          if (token) {
            const res = await api<{ rounds: Round[] }>('/rounds', { token });
            rs = res.rounds;
          }
        } catch {
          /* cache */
        }
      }
      if (rs.length === 0) rs = await listCachedRounds();
      const open = rs.filter((r) => r.is_open);
      setRounds(open);
      if (open.length > 0 && !roundId) setRoundId(open[0].id);
    })();
  }, [online, getToken, roundId]);

  useEffect(() => {
    void (async () => {
      if (!roundId) {
        setCriteria([]);
        return;
      }
      let cs: Criterion[] = [];
      if (online) {
        try {
          const token = await getToken();
          if (token) {
            const res = await api<{ criteria: Criterion[] }>(`/rounds/${roundId}/criteria`, { token });
            cs = res.criteria.filter((c) => c.is_active);
          }
        } catch {
          /* cache */
        }
      }
      if (cs.length === 0) cs = (await listCachedCriteria(roundId)).filter((c) => c.is_active);
      setCriteria(cs);
    })();
  }, [roundId, online, getToken]);

  useEffect(() => {
    void (async () => {
      if (!online) return;
      try {
        const token = await getToken();
        if (!token) return;
        const res = await api<{ verticals: Vertical[] }>('/verticals', { token });
        setVerticals(res.verticals);
      } catch {
        /* verticals are cosmetic here */
      }
    })();
  }, [online, getToken]);

  // Existing unsynced local evaluation for this candidate+round
  useEffect(() => {
    void (async () => {
      const list = await listOutbox();
      const match = list.find(
        (o) => o.candidate_id === id && o.round_id === roundId && o.status !== 'synced',
      );
      setExistingLocal(match ?? null);
      if (match) {
        setFeedback(match.feedback);
        setPreferredVertical(match.preferred_vertical_id ?? '');
        if (match.overall_score !== null) setOverall(String(match.overall_score));
        const s: Record<string, number | null> = {};
        for (const [k, v] of Object.entries(match.scores)) s[k] = v;
        setScores(s);
      } else {
        setFeedback('');
        setPreferredVertical('');
        setOverall('');
        setScores({});
      }
    })();
  }, [id, roundId]);

  // Prefill from this judge's already-submitted evaluation so it can be edited.
  useEffect(() => {
    if (!online || !id || !roundId || existingLocal) return;
    let cancelled = false;
    void (async () => {
      try {
        const token = await getToken();
        if (!token) return;
        const list = await listOutbox();
        if (list.some((o) => o.candidate_id === id && o.round_id === roundId && o.status !== 'synced')) return;
        const res = await api<{ evaluations: EvaluationWithScores[] }>(
          `/evaluations?candidateId=${encodeURIComponent(id)}`,
          { token },
        );
        const mine = res.evaluations.find((e) => e.round_id === roundId);
        if (!mine || cancelled) return;
        setServerEvalId(mine.id);
        setFeedback(mine.feedback ?? '');
        setPreferredVertical(mine.preferred_vertical_id ?? '');
        const s: Record<string, number | null> = {};
        for (const row of mine.scores) s[row.criterion_id] = row.score;
        setScores(s);
        if (mine.overall_score !== null) setOverall(String(mine.overall_score));
      } catch {
        /* editing is best-effort; fall back to a fresh form */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [online, id, roundId, existingLocal, getToken]);

  const individual = useMemo(() => {
    const rated = criteria.map((c) => scores[c.id]).filter((s): s is number => typeof s === 'number');
    return meanOf(rated);
  }, [criteria, scores]);

  const validate = (): string | null => {
    if (!roundId) return 'Select an interview round';
    if (criteria.length > 0) {
      for (const c of criteria) {
        const n = scores[c.id];
        if (typeof n !== 'number') return `Rate every criterion — starting with: ${c.name}`;
        if (n < c.min_score || n > c.max_score) {
          return `${c.name} must be between ${c.min_score} and ${c.max_score}`;
        }
      }
    } else {
      const n = Number(overall);
      if (!overall || Number.isNaN(n) || n < 1 || n > 10) return 'Overall score between 1 and 10 is required';
    }
    return null;
  };

  const buildPayload = (itemId: string): OutboxItem => {
    const round = rounds.find((r) => r.id === roundId);
    const sc: Record<string, number> = {};
    for (const c of criteria) {
      const v = scores[c.id];
      if (typeof v === 'number') sc[c.id] = v;
    }
    const numericScores = Object.values(sc);
    const computedOverall =
      criteria.length > 0
        ? Math.round((numericScores.reduce((a, b) => a + b, 0) / numericScores.length) * 100) / 100
        : Number(overall);
    return {
      id: itemId,
      candidate_id: id!,
      candidate_name: candidate?.full_name ?? '',
      round_id: roundId,
      round_name: round?.name ?? '',
      panel_id: candidate?.panel_id ?? '',
      feedback: feedback.trim(),
      overall_score: computedOverall,
      scores: sc,
      criterion_feedbacks: {},
      preferred_vertical_id: preferredVertical || null,
      client_created_at: new Date().toISOString(),
      status: 'pending',
      attempts: existingLocal?.attempts ?? 0,
    };
  };

  const saveLocally = async (itemId: string) => {
    setSavingLocal(true);
    try {
      const item = buildPayload(itemId);
      await putOutboxItem(item);
      await setMeta('last_local_save_at', new Date().toISOString());
      setExistingLocal(item);
      setMessage({ kind: 'ok', text: 'Saved on this device. It will upload when connected.' });
    } finally {
      setSavingLocal(false);
    }
  };

  const doSubmit = async () => {
    setBusy(true);
    setMessage(null);
    const itemId = existingLocal?.id ?? serverEvalId ?? crypto.randomUUID();
    try {
      if (!online) {
        await saveLocally(itemId);
        return;
      }
      const token = await getToken();
      if (!token) {
        await saveLocally(itemId);
        setMessage({ kind: 'warn', text: 'Session expired — evaluation saved locally. Sign in again to sync.' });
        return;
      }
      const payload = buildPayload(itemId);
      try {
        const res = await api<{ status: string; evaluation: { id: string } }>('/evaluations', {
          method: 'POST',
          token,
          body: JSON.stringify({
            id: payload.id,
            candidate_id: payload.candidate_id,
            round_id: payload.round_id,
            feedback: payload.feedback,
            overall_score: criteria.length === 0 ? payload.overall_score : null,
            scores: payload.scores,
            criterion_feedbacks: payload.criterion_feedbacks,
            preferred_vertical_id: payload.preferred_vertical_id ?? null,
            client_created_at: payload.client_created_at,
            replace_existing:
              serverEvalId !== null ||
              (rounds.find((r) => r.id === roundId)?.allow_edit_after_submit ?? false),
          }),
        });
        if (res.status === 'ok') {
          scheduleSheetSync(getToken);
          setMessage({
            kind: 'ok',
            text: serverEvalId
              ? 'Evaluation updated and saved on the server.'
              : 'Evaluation submitted and saved on the server.',
          });
          if (existingLocal) {
            await putOutboxItem({ ...payload, status: 'synced' });
            setExistingLocal(null);
          }
          void syncNow();
          setTimeout(() => navigate('/my-evaluations'), 900);
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          setMessage({
            kind: 'err',
            text: `${err.message} Your local edits (if any) remain on this device.`,
          });
          await saveLocally(itemId);
          return;
        }
        await saveLocally(itemId);
        if (err instanceof ApiError && err.details) {
          const details = err.details as Record<string, string>;
          setMessage({
            kind: 'err',
            text: `Saved locally. Server rejected the scores: ${Object.values(details).join('; ')}`,
          });
        } else {
          setMessage({
            kind: 'warn',
            text: `Could not reach the server (${err instanceof Error ? err.message : 'error'}). Evaluation saved locally.`,
          });
        }
      }
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const problem = validate();
    if (problem) {
      setMessage({ kind: 'err', text: problem });
      return;
    }
    // Confirmation step before the official submission is locked in.
    setConfirmOpen(true);
  };

  if (!candidate) {
    return (
      <div className="empty">
        <span className="spinner" /> Loading candidate…
      </div>
    );
  }

  const ratedCount = criteria.filter((c) => typeof scores[c.id] === 'number').length;

  const confirmSummary =
    criteria.length > 0
      ? `${candidate.full_name}: individual score ${displayScore(individual)} (${criteria.length} criteria, 1–10 stars)`
      : `${candidate.full_name}: overall score ${overall}`;

  return (
    <>
      <header className="page-header">
        <div className="page-header-copy">
          <h1>{candidate.full_name}</h1>
          <p className="page-desc">
            {candidate.branch}
            {candidate.roll_number ? ` · ${candidate.roll_number}` : ''}
            {candidate.application_id ? ` · ${candidate.application_id}` : ''}
          </p>
          <p className="btn-row" style={{ marginTop: 8 }}>
            <span className="badge neutral">{candidate.interview_status.replace('_', ' ')}</span>
            {candidate.priority ? <span className="badge blue">Priority {candidate.priority}</span> : null}
          </p>
        </div>
        <div className="page-actions">
          <Link className="btn secondary" to="/candidates">
            Back to candidates
          </Link>
        </div>
      </header>

      <CandidateProfile
        candidate={candidate}
        verticalName={verticals.find((v) => v.id === candidate.vertical_id)?.name ?? null}
      />

      {message && (
        <div
          className={`alert ${
            message.kind === 'ok' ? 'success' : message.kind === 'warn' ? 'warn' : message.kind === 'info' ? 'info' : 'error'
          }`}
        >
          {message.text}
        </div>
      )}

      <form className="card" onSubmit={onSubmit}>
        <label className="field">
          <span>Interview round</span>
          <select value={roundId} onChange={(e) => setRoundId(e.target.value)} required>
            {rounds.length === 0 && <option value="">No open rounds</option>}
            {rounds.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
                {r.allow_edit_after_submit ? ' (edits allowed)' : ''}
              </option>
            ))}
          </select>
        </label>

        {criteria.length > 0 ? (
          <div>
            <div className="btn-row" style={{ alignItems: 'baseline', justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0 }}>Rubric (1–10 stars)</h3>
              <span className="badge blue" data-testid="individual-score">
                Individual score: {displayScore(individual)}
              </span>
            </div>
            <div className="btn-row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
              <div style={{ flex: 1 }}>
                <ProgressBar
                  value={ratedCount}
                  max={criteria.length}
                  tone={ratedCount === criteria.length ? 'green' : 'blue'}
                  label="Criteria rated"
                />
              </div>
              <span className="muted nowrap">
                {ratedCount} of {criteria.length} rated
              </span>
            </div>
            {criteria.map((c) => (
              <div className="score-row" key={c.id}>
                <div style={{ flex: 1 }}>
                  <strong>{c.name}</strong>
                  {c.description && <div className="muted">{c.description}</div>}
                  <StarRating
                    value={scores[c.id] ?? null}
                    onChange={(v) => setScores((s) => ({ ...s, [c.id]: v }))}
                    label={c.name}
                  />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <label className="field">
            <span>Overall score (1–10)</span>
            <input
              type="number"
              min={1}
              max={10}
              step="any"
              value={overall}
              onChange={(e) => setOverall(e.target.value)}
              required
            />
          </label>
        )}

        <label className="field mt">
          <span>Preferred vertical (based on interview)</span>
          <select value={preferredVertical} onChange={(e) => setPreferredVertical(e.target.value)}>
            <option value="">No preference</option>
            {verticals.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>

        <label className="field mt">
          <span>Overall written feedback</span>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            maxLength={5000}
            placeholder="Strengths, concerns, recommendation"
          />
        </label>

        <div className="btn-row">
          <button className="btn" disabled={busy || savingLocal || rounds.length === 0}>
            {busy ? 'Submitting…' : online ? 'Submit evaluation' : 'Save evaluation (offline)'}
          </button>
          {online && (
            <button
              type="button"
              className="btn secondary"
              disabled={savingLocal || busy}
              onClick={() => void saveLocally(existingLocal?.id ?? crypto.randomUUID())}
            >
              {savingLocal ? 'Saving…' : 'Save to device only'}
            </button>
          )}
          {existingLocal && (
            <span className="badge warn">
              Unsynced copy on this device ({existingLocal.status})
            </span>
          )}
        </div>
      </form>

      <ConfirmDialog
        open={confirmOpen}
        title="Submit evaluation?"
        message={`${confirmSummary}. ${
          rounds.find((r) => r.id === roundId)?.allow_edit_after_submit
            ? 'This round allows later edits.'
            : 'This cannot be changed after submission unless edits are enabled for the round.'
        }`}
        confirmLabel="Submit"
        onConfirm={() => void doSubmit()}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
