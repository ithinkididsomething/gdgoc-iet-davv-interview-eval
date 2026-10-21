import { Fragment, useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ConfirmDialog } from '../components/Ui';
import { SortableTh, useSort } from '../components/Sortable';
import type { Panel, PanelMember } from '../lib/types';

interface PanelCode {
  id: string;
  label: string;
  is_active: boolean;
  failed_attempts: number;
  locked_until: string | null;
  expires_at: string | null;
  code_preview: string;
  created_at: string;
}

type PanelRow = Panel & { members: PanelMember[] };

export function AdminPanels() {
  const { getToken } = useAuth();
  const [panels, setPanels] = useState<PanelRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [codesPanel, setCodesPanel] = useState<PanelRow | null>(null);
  const [codes, setCodes] = useState<PanelCode[]>([]);
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [codeLabel, setCodeLabel] = useState('');
  const [judgeEmail, setJudgeEmail] = useState('');
  const [users, setUsers] = useState<{ id: string; email: string; full_name: string; role: string }[]>([]);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<{ panel: PanelRow; member: PanelMember } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<PanelRow | null>(null);

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const p = await api<{ panels: PanelRow[] }>('/panels', { token });
    setPanels(p.panels);
    const u = await api<{ users: { id: string; email: string; full_name: string; role: string }[] }>(
      '/admin/users',
      { token },
    );
    setUsers(u.users.filter((x) => x.role === 'judge'));
  }, [getToken]);

  useEffect(() => {
    void load().catch((e) => setError(String(e.message ?? e)));
  }, [load]);

  const getCodeSortValue = useCallback((c: PanelCode, key: string): unknown => {
    switch (key) {
      case 'preview':
        return c.code_preview;
      case 'label':
        return c.label;
      case 'status':
        return c.locked_until && new Date(c.locked_until) > new Date()
          ? 'locked'
          : c.is_active
            ? 'active'
            : 'inactive';
      case 'attempts':
        return c.failed_attempts;
      default:
        return '';
    }
  }, []);
  const codeSort = useSort(codes, getCodeSortValue, 'preview');

  const createPanel = async () => {
    const token = await getToken();
    if (!token || !newName.trim()) return;
    try {
      await api('/panels', {
        method: 'POST',
        token,
        body: JSON.stringify({ name: newName.trim() }),
      });
      setNewName('');
      setNotice('Panel created.');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to create panel');
    }
  };

  const openCodes = async (panel: PanelRow) => {
    setCodesPanel(panel);
    setPlaintext(null);
    const token = await getToken();
    if (!token) return;
    const res = await api<{ codes: PanelCode[] }>(`/panels/${panel.id}/codes`, { token });
    setCodes(res.codes);
  };

  const createCode = async (rotate: boolean) => {
    if (!codesPanel) return;
    const token = await getToken();
    if (!token) return;
    try {
      const res = await api<{ plaintext_code: string }>(
        `/panels/${codesPanel.id}/codes${rotate ? '/rotate' : ''}`,
        {
          method: 'POST',
          token,
          body: JSON.stringify({ label: codeLabel }),
        },
      );
      setPlaintext(res.plaintext_code);
      setCodeLabel('');
      setConfirmRotate(false);
      setNotice(
        rotate
          ? 'Code rotated. Previous codes are deactivated.'
          : 'Code created. Share it securely with judges.',
      );
      await openCodes(codesPanel);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to create code');
    }
  };

  const toggleCode = async (code: PanelCode, isActive: boolean) => {
    const token = await getToken();
    if (!token) return;
    await api(`/panel-codes/${code.id}`, {
      method: 'PATCH',
      token,
      body: JSON.stringify({ is_active: isActive }),
    });
    if (codesPanel) await openCodes(codesPanel);
  };

  const assignJudge = async (panel: PanelRow) => {
    const token = await getToken();
    if (!token) return;
    const user = users.find((u) => u.email.toLowerCase() === judgeEmail.trim().toLowerCase());
    if (!user) {
      setError('No judge with that email has registered yet.');
      return;
    }
    try {
      await api(`/panels/${panel.id}/members`, {
        method: 'POST',
        token,
        body: JSON.stringify({ judge_id: user.id }),
      });
      setJudgeEmail('');
      setNotice(`${user.full_name} assigned to ${panel.name}.`);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Assignment failed');
    }
  };

  const removeMember = async () => {
    if (!confirmRemove) return;
    const token = await getToken();
    if (!token) return;
    await api(`/panels/${confirmRemove.panel.id}/members/${confirmRemove.member.judge_id}`, {
      method: 'DELETE',
      token,
    });
    setNotice('Judge removed from panel. Their existing evaluations are kept.');
    setConfirmRemove(null);
    await load();
  };

  const deletePanel = async () => {
    if (!confirmDelete) return;
    const token = await getToken();
    if (!token) return;
    try {
      await api(`/panels/${confirmDelete.id}`, { method: 'DELETE', token });
      if (codesPanel?.id === confirmDelete.id) setCodesPanel(null);
      setNotice(`${confirmDelete.name} was permanently deleted.`);
      setConfirmDelete(null);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to delete panel');
    }
  };

  return (
    <>
      <h1>Panels &amp; verification codes</h1>
      <p className="muted">Create panels, assign interviewers, and share secure verification codes.</p>
      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert success">{notice}</div>}

      <div className="card">
        <h3>New panel</h3>
        <div className="filters">
          <div>
            <label>Panel name</label>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} />
          </div>
          <button className="btn" onClick={() => void createPanel()} disabled={!newName.trim()}>
            Create panel
          </button>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Evaluations required per candidate automatically match the number of judges assigned to the panel.
        </p>
      </div>

      {panels.map((panel) => (
        <Fragment key={panel.id}>
          <div className="card">
            <div className="head" style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
              <h3 style={{ margin: 0 }}>{panel.name}</h3>
              <span className={`badge ${panel.is_active ? 'ok' : 'err'}`}>
                {panel.is_active ? 'active' : 'inactive'}
              </span>
            </div>
            <p className="muted">
              Total evaluations per candidate: {panel.members.length} (one per panel judge)
            </p>
            <ul>
              {panel.members.map((m) => (
                <li key={m.judge_id}>
                  {m.judge_name || m.judge_id}{' '}
                  {m.verified_at ? <span className="badge ok">verified</span> : <span className="badge blue">assigned</span>}{' '}
                  <button
                    className="btn danger small"
                    onClick={() => setConfirmRemove({ panel, member: m })}
                  >
                    Remove
                  </button>
                </li>
              ))}
              {panel.members.length === 0 && <li className="muted">No judges assigned.</li>}
            </ul>
            <div className="filters">
              <div style={{ flex: 1 }}>
                <label>Assign registered judge by email</label>
                <input
                  value={judgeEmail}
                  onChange={(e) => setJudgeEmail(e.target.value)}
                  placeholder="judge@example.com"
                  list="judge-emails"
                />
                <datalist id="judge-emails">
                  {users.map((u) => (
                    <option key={u.id} value={u.email}>
                      {u.full_name}
                    </option>
                  ))}
                </datalist>
              </div>
              <button className="btn secondary" onClick={() => void assignJudge(panel)}>
                Assign
              </button>
              <button className="btn secondary" onClick={() => void openCodes(panel)}>
                Verification codes
              </button>
              <button
                className="btn secondary"
                onClick={() => {
                  void (async () => {
                    const token = await getToken();
                    if (!token) return;
                    await api(`/panels/${panel.id}`, {
                      method: 'PATCH',
                      token,
                      body: JSON.stringify({ is_active: !panel.is_active }),
                    });
                    await load();
                  })().catch((e) => setError(e instanceof Error ? e.message : 'Update failed'));
                }}
              >
                {panel.is_active ? 'Deactivate' : 'Activate'}
              </button>
              <button className="btn danger" onClick={() => setConfirmDelete(panel)}>
                Delete panel
              </button>
            </div>
          </div>

          {codesPanel?.id === panel.id && (
            <div className="card">
              <h3>Codes — {codesPanel.name}</h3>
              {plaintext && (
                <div className="alert warn">
                  This code is shown <strong>once</strong>. Give it to the judges for this panel:{' '}
                  <strong className="mono" style={{ letterSpacing: '0.1em' }}>{plaintext}</strong>
                </div>
              )}
              <div className="filters">
                <div>
                  <label>Label (optional)</label>
                  <input value={codeLabel} onChange={(e) => setCodeLabel(e.target.value)} />
                </div>
                <button className="btn" onClick={() => void createCode(false)}>
                  New code
                </button>
                <button className="btn danger" onClick={() => setConfirmRotate(true)}>
                  Rotate (revoke all current)
                </button>
                <button className="btn secondary" onClick={() => setCodesPanel(null)}>
                  Close
                </button>
              </div>
              <div className="table-wrap mt">
                <table className="data">
                  <thead>
                    <tr>
                      <SortableTh label="Preview" sortKey="preview" state={codeSort} />
                      <SortableTh label="Label" sortKey="label" state={codeSort} />
                      <SortableTh label="Status" sortKey="status" state={codeSort} />
                      <SortableTh label="Failed attempts" sortKey="attempts" state={codeSort} />
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {codeSort.sorted.map((c) => (
                      <tr key={c.id}>
                        <td className="mono">{c.code_preview || '••••'}</td>
                        <td>{c.label || '—'}</td>
                        <td>
                          {c.locked_until && new Date(c.locked_until) > new Date() ? (
                            <span className="badge err">locked until {new Date(c.locked_until).toLocaleTimeString()}</span>
                          ) : c.is_active ? (
                            <span className="badge ok">active</span>
                          ) : (
                            <span className="badge neutral">inactive</span>
                          )}
                        </td>
                        <td>{c.failed_attempts}</td>
                        <td>
                          <button className="btn secondary small" onClick={() => void toggleCode(c, !c.is_active)}>
                            {c.is_active ? 'Deactivate' : 'Activate'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {codes.length === 0 && <div className="empty">No codes yet — create one.</div>}
              </div>
            </div>
          )}
        </Fragment>
      ))}

      <ConfirmDialog
        open={confirmRotate}
        danger
        title="Rotate panel code?"
        message="All current active codes for this panel will stop working immediately. A new code will be generated."
        confirmLabel="Rotate"
        onCancel={() => setConfirmRotate(false)}
        onConfirm={() => void createCode(true)}
      />
      <ConfirmDialog
        open={!!confirmRemove}
        danger
        title="Remove judge from panel?"
        message="They will no longer see this panel's candidates or be able to submit evaluations for it. Existing evaluations are kept."
        confirmLabel="Remove"
        onCancel={() => setConfirmRemove(null)}
        onConfirm={() => void removeMember()}
      />
      <ConfirmDialog
        open={!!confirmDelete}
        danger
        title={`Delete ${confirmDelete?.name ?? 'panel'} permanently?`}
        message="This permanently deletes the panel, its verification codes, assigned judges, and every candidate inside it along with their evaluations. This cannot be undone."
        confirmLabel="Delete permanently"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => void deletePanel()}
      />
    </>
  );
}
