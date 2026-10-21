import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { SortableTh, useSort } from '../components/Sortable';
import type { Criterion, Round } from '../lib/types';

export function AdminRounds() {
  const { getToken } = useAuth();
  const [rounds, setRounds] = useState<Round[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [criteria, setCriteria] = useState<Criterion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newRound, setNewRound] = useState({ name: '', allow_edit_after_submit: true });
  const [newCriterion, setNewCriterion] = useState({
    name: '',
    description: '',
    min_score: 1,
    max_score: 10,
    weight: 1,
  });

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const res = await api<{ rounds: Round[] }>('/rounds', { token });
    setRounds(res.rounds);
    if (!selected && res.rounds.length > 0) setSelected(res.rounds[0].id);
  }, [getToken, selected]);

  useEffect(() => {
    void load().catch((e) => setError(String(e.message ?? e)));
  }, [load]);

  useEffect(() => {
    void (async () => {
      if (!selected) return;
      const token = await getToken();
      if (!token) return;
      const res = await api<{ criteria: Criterion[] }>(`/rounds/${selected}/criteria`, { token });
      setCriteria(res.criteria);
    })();
  }, [selected, getToken, notice]);

  const roundSortValue = useCallback((r: Round, key: string): unknown => {
    switch (key) {
      case 'name':
        return r.name;
      case 'open':
        return r.is_open;
      case 'edits':
        return r.allow_edit_after_submit;
      case 'closes':
        return r.closes_at;
      default:
        return '';
    }
  }, []);
  const criterionSortValue = useCallback((c: Criterion, key: string): unknown => {
    switch (key) {
      case 'name':
        return c.name;
      case 'range':
        return c.min_score;
      case 'weight':
        return c.weight;
      case 'active':
        return c.is_active;
      default:
        return '';
    }
  }, []);
  const roundSort = useSort(rounds, roundSortValue, 'name');
  const criterionSort = useSort(criteria, criterionSortValue);

  const createRound = async () => {
    const token = await getToken();
    if (!token || !newRound.name.trim()) return;
    try {
      await api('/rounds', {
        method: 'POST',
        token,
        body: JSON.stringify({
          name: newRound.name.trim(),
          is_open: true,
          allow_edit_after_submit: newRound.allow_edit_after_submit,
        }),
      });
      setNewRound({ name: '', allow_edit_after_submit: true });
      setNotice('Round created.');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to create round');
    }
  };

  const patchRound = async (id: string, patch: Partial<Round>) => {
    const token = await getToken();
    if (!token) return;
    await api(`/rounds/${id}`, { method: 'PATCH', token, body: JSON.stringify(patch) });
    setNotice('Round updated.');
    await load();
  };

  const deleteRound = async (r: Round) => {
    const token = await getToken();
    if (!token) return;
    if (!window.confirm(`Delete round "${r.name}"? Its criteria will be removed permanently.`)) return;
    try {
      try {
        await api(`/rounds/${r.id}`, { method: 'DELETE', token });
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 409) throw e;
        if (!window.confirm(`${e.message}\n\nDelete the round and those evaluations permanently?`)) return;
        await api(`/rounds/${r.id}?force=true`, { method: 'DELETE', token });
      }
      setError(null);
      setNotice('Round deleted.');
      if (selected === r.id) {
        setSelected('');
        setCriteria([]);
      }
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to delete round');
    }
  };

  const createCriterion = async () => {
    const token = await getToken();
    if (!token || !selected || !newCriterion.name.trim()) return;
    try {
      await api(`/rounds/${selected}/criteria`, {
        method: 'POST',
        token,
        body: JSON.stringify({ ...newCriterion, sort_order: criteria.length }),
      });
      setNewCriterion({ name: '', description: '', min_score: 1, max_score: 10, weight: 1 });
      setNotice('Criterion added.');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to add criterion');
    }
  };

  const toggleCriterion = async (c: Criterion) => {
    const token = await getToken();
    if (!token) return;
    try {
      const res = await api<{ criterion: Criterion }>(`/criteria/${c.id}`, {
        method: 'PATCH',
        token,
        body: JSON.stringify({ is_active: !c.is_active }),
      });
      setCriteria((prev) => prev.map((x) => (x.id === c.id ? res.criterion : x)));
      setError(null);
      setNotice(res.criterion.is_active ? 'Criterion enabled.' : 'Criterion disabled.');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to update criterion');
    }
  };

  const deleteCriterion = async (c: Criterion) => {
    const token = await getToken();
    if (!token) return;
    if (!window.confirm(`Delete criterion "${c.name}"?`)) return;
    try {
      try {
        await api(`/criteria/${c.id}`, { method: 'DELETE', token });
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 409) throw e;
        if (!window.confirm(`${e.message}\n\nDelete it and its recorded scores permanently?`)) return;
        await api(`/criteria/${c.id}?force=true`, { method: 'DELETE', token });
      }
      setError(null);
      setNotice('Criterion deleted.');
      setCriteria((prev) => prev.filter((x) => x.id !== c.id));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to delete criterion');
    }
  };

  return (
    <>
      <h1>Rounds &amp; criteria</h1>
      <p className="muted">
        Configure the evaluation rubric before interviews. If a round has active criteria, the overall
        score is the weighted mean of criterion scores. If it has none, judges enter a single overall
        score (1–10). Edits after submission are only possible when explicitly enabled per round.
      </p>
      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert success">{notice}</div>}

      <div className="card">
        <h3>New round</h3>
        <div className="filters form-line">
          <div className="field-grow">
            <label>Round name</label>
            <input
              value={newRound.name}
              onChange={(e) => setNewRound({ ...newRound, name: e.target.value })}
            />
          </div>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={newRound.allow_edit_after_submit}
              onChange={(e) => setNewRound({ ...newRound, allow_edit_after_submit: e.target.checked })}
            />
            Allow judges to edit after submit
          </label>
          <button className="btn" onClick={() => void createRound()} disabled={!newRound.name.trim()}>
            Create round
          </button>
        </div>
      </div>

      <div className="card">
        <h3>Existing rounds</h3>
        <div className="table-wrap">
          <table className="data wide-table">
            <thead>
              <tr>
                <SortableTh label="Name" sortKey="name" state={roundSort} />
                <SortableTh label="Open" sortKey="open" state={roundSort} />
                <SortableTh label="Edits allowed" sortKey="edits" state={roundSort} />
                <SortableTh label="Closes" sortKey="closes" state={roundSort} />
                <th className="actions-head">Actions</th>
              </tr>
            </thead>
            <tbody>
              {roundSort.sorted.map((r) => (
                <tr key={r.id}>
                  <td>
                    <button
                      className="btn secondary small"
                      onClick={() => setSelected(r.id)}
                      style={selected === r.id ? { borderColor: 'var(--blue)' } : undefined}
                    >
                      {r.name}
                    </button>
                  </td>
                  <td>
                    <button
                      className={`btn small ${r.is_open ? 'secondary' : ''}`}
                      onClick={() => void patchRound(r.id, { is_open: !r.is_open })}
                    >
                      {r.is_open ? 'Open' : 'Closed'}
                    </button>
                  </td>
                  <td>{r.allow_edit_after_submit ? 'Yes' : 'No'}</td>
                  <td className="muted">
                    {r.closes_at ? new Date(r.closes_at).toLocaleString() : <span className="muted">Not scheduled</span>}
                  </td>
                  <td className="actions-cell">
                    <button className="btn danger small" onClick={() => void deleteRound(r)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rounds.length === 0 && <div className="empty">No rounds yet.</div>}
        </div>
      </div>

      {selected && (
        <div className="card">
          <h3>Criteria for selected round</h3>
          <div className="table-wrap">
            <table className="data wide-table">
              <thead>
                <tr>
                  <SortableTh label="Name" sortKey="name" state={criterionSort} />
                  <SortableTh label="Range" sortKey="range" state={criterionSort} />
                  <SortableTh label="Weight" sortKey="weight" state={criterionSort} />
                  <SortableTh label="Active" sortKey="active" state={criterionSort} />
                  <th className="actions-head">Actions</th>
                </tr>
              </thead>
              <tbody>
                {criterionSort.sorted.map((c) => (
                  <tr key={c.id} style={!c.is_active ? { opacity: 0.5 } : undefined}>
                    <td>
                      {c.name}
                      {c.description && <div className="muted">{c.description}</div>}
                    </td>
                    <td>
                      {c.min_score}–{c.max_score}
                    </td>
                    <td>{c.weight}</td>
                    <td className="actions-cell">
                      <button className="btn secondary small" onClick={() => void toggleCriterion(c)}>
                        {c.is_active ? 'Disable' : 'Enable'}
                      </button>
                    </td>
                    <td className="actions-cell">
                      <button className="btn danger small" onClick={() => void deleteCriterion(c)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {criteria.length === 0 && (
              <div className="empty">No criteria — judges will submit a single overall score.</div>
            )}
          </div>
          <div className="criterion-form mt">
            <div className="field field-name">
              <label>Criterion name</label>
              <input
                value={newCriterion.name}
                onChange={(e) => setNewCriterion({ ...newCriterion, name: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Min</label>
              <input
                type="number"
                value={newCriterion.min_score}
                onChange={(e) => setNewCriterion({ ...newCriterion, min_score: Number(e.target.value) })}
              />
            </div>
            <div className="field">
              <label>Max</label>
              <input
                type="number"
                value={newCriterion.max_score}
                onChange={(e) => setNewCriterion({ ...newCriterion, max_score: Number(e.target.value) })}
              />
            </div>
            <div className="field">
              <label>Weight</label>
              <input
                type="number"
                step="0.1"
                min="0.1"
                value={newCriterion.weight}
                onChange={(e) => setNewCriterion({ ...newCriterion, weight: Number(e.target.value) })}
              />
            </div>
            <button className="btn" onClick={() => void createCriterion()} disabled={!newCriterion.name.trim()}>
              Add criterion
            </button>
            <div className="field field-description">
              <label>Description</label>
              <textarea
                rows={2}
                maxLength={500}
                value={newCriterion.description}
                onChange={(e) => setNewCriterion({ ...newCriterion, description: e.target.value })}
                placeholder="What judges should look for (optional)"
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
