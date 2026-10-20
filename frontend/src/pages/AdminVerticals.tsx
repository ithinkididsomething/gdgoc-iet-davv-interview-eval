import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageHeader } from '../components/PageHeader';
import { SortableTh, useSort } from '../components/Sortable';
import type { Vertical } from '../lib/types';

interface SheetTab {
  title: string;
  index: number;
  rowCount: number;
  columnCount: number;
}

/**
 * Vertical configuration: names, sort order, active flag and the
 * vertical ↔ spreadsheet-worksheet mapping used by two-way sync.
 */
export function AdminVerticals() {
  const { getToken } = useAuth();
  const [verticals, setVerticals] = useState<Vertical[]>([]);
  const [tabs, setTabs] = useState<SheetTab[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState({ key: '', name: '', worksheet: '' });

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    try {
      const res = await api<{ verticals: Vertical[] }>('/verticals', { token });
      setVerticals(res.verticals);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load verticals');
    }
    try {
      const res = await api<{ tabs: SheetTab[] }>('/sheets/tabs', { token });
      setTabs(res.tabs);
    } catch {
      setTabs([]); // sheets not configured — worksheet input stays free text
    }
  }, [getToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const getSortValue = useCallback((v: Vertical, key: string): unknown => {
    switch (key) {
      case 'order':
        return v.sort_order;
      case 'key':
        return v.key;
      case 'name':
        return v.name;
      case 'worksheet':
        return v.worksheet;
      case 'active':
        return v.is_active;
      default:
        return '';
    }
  }, []);
  const sort = useSort(verticals, getSortValue);

  const patch = async (id: string, body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) return;
      await api(`/verticals/${id}`, { method: 'PATCH', token, body: JSON.stringify(body) });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Update failed');
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) return;
      await api('/verticals', {
        method: 'POST',
        token,
        body: JSON.stringify({
          key: creating.key.trim(),
          name: creating.name.trim(),
          worksheet: creating.worksheet.trim() || null,
        }),
      });
      setNotice(`Vertical “${creating.name}” created.`);
      setCreating({ key: '', name: '', worksheet: '' });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Verticals"
        description="Recruitment verticals drive candidate grouping, filters, and worksheet mapping for spreadsheet sync."
      />
      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert success">{notice}</div>}

      <div className="table-wrap card" style={{ padding: 0 }}>
        <table className="data">
          <thead>
            <tr>
              <SortableTh label="#" sortKey="order" state={sort} title="Configured sort order" />
              <SortableTh label="Key" sortKey="key" state={sort} />
              <SortableTh label="Name" sortKey="name" state={sort} />
              <SortableTh label="Worksheet (sync)" sortKey="worksheet" state={sort} />
              <SortableTh label="Active" sortKey="active" state={sort} />
            </tr>
          </thead>
          <tbody>
            {sort.sorted.map((v, i) => (
              <tr key={v.id}>
                <td>{i + 1}</td>
                <td className="mono">{v.key}</td>
                <td>
                  <input
                    value={v.name}
                    disabled={busy}
                    onChange={(e) =>
                      setVerticals((list) => list.map((x) => (x.id === v.id ? { ...x, name: e.target.value } : x)))
                    }
                    onBlur={() => v.name.trim() && void patch(v.id, { name: v.name.trim() })}
                    style={{ width: '100%' }}
                  />
                </td>
                <td>
                  {tabs.length > 0 ? (
                    <select
                      value={v.worksheet ?? ''}
                      disabled={busy}
                      onChange={(e) => void patch(v.id, { worksheet: e.target.value || null })}
                    >
                      <option value="">— none —</option>
                      {tabs.map((t) => (
                        <option key={t.title} value={t.title}>
                          {t.title}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={v.worksheet ?? ''}
                      placeholder="tab name or sheet link"
                      title="A tab name in the connected spreadsheet, or a full Google Sheets link (optionally with #gid=…)"
                      disabled={busy}
                      onChange={(e) =>
                        setVerticals((list) =>
                          list.map((x) => (x.id === v.id ? { ...x, worksheet: e.target.value } : x)),
                        )
                      }
                      onBlur={() => void patch(v.id, { worksheet: v.worksheet || null })}
                    />
                  )}
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={v.is_active}
                    disabled={busy}
                    onChange={(e) => void patch(v.id, { is_active: e.target.checked })}
                    style={{ width: 'auto' }}
                  />
                </td>
              </tr>
            ))}
            {verticals.length === 0 && (
              <tr>
                <td colSpan={5} className="muted" style={{ padding: '1rem' }}>
                  No verticals yet — seed them from the migration or add one below.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card mt">
        <h3>Add vertical</h3>
        <div className="filters">
          <div>
            <label>Key</label>
            <input
              value={creating.key}
              onChange={(e) => setCreating({ ...creating, key: e.target.value })}
              placeholder="sponsorship"
            />
          </div>
          <div>
            <label>Name</label>
            <input
              value={creating.name}
              onChange={(e) => setCreating({ ...creating, name: e.target.value })}
              placeholder="Sponsorship"
            />
          </div>
          <div>
            <label>Worksheet</label>
            <input
              value={creating.worksheet}
              onChange={(e) => setCreating({ ...creating, worksheet: e.target.value })}
              placeholder="Sponsorship"
              list="worksheet-list"
            />
            <datalist id="worksheet-list">
              {tabs.map((t) => (
                <option key={t.title} value={t.title} />
              ))}
            </datalist>
          </div>
          <button
            className="btn"
            disabled={busy || !creating.key.trim() || !creating.name.trim()}
            onClick={() => void create()}
          >
            Add
          </button>
        </div>
      </div>
    </>
  );
}
