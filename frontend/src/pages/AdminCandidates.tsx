import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, downloadCsv, ApiError, API_URL } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageHeader } from '../components/PageHeader';
import { ConfirmDialog } from '../components/Ui';
import { AdminCandidateProfile } from '../components/AdminCandidateProfile';
import { SortableTh, useSort } from '../components/Sortable';
import type { Candidate, Panel } from '../lib/types';

interface ImportSheetAudit {
  sheet: string;
  rows: number;
  applicantRows: number;
  usedAsSource: boolean;
  headers: string[];
  reason?: string;
}

export function AdminCandidates() {
  const { getToken } = useAuth();
  const [params] = useSearchParams();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [panels, setPanels] = useState<Panel[]>([]);
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [branch, setBranch] = useState('');
  const [panelId, setPanelId] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<Partial<Candidate> | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<Candidate | null>(null);
  const [csvText, setCsvText] = useState('');
  const [importResult, setImportResult] = useState<unknown>(null);
  const [workbookFile, setWorkbookFile] = useState<File | null>(null);
  const [workbookPreview, setWorkbookPreview] = useState<{
    sheets: ImportSheetAudit[];
    applicant_count: number;
    errors: { sheet: string; row: number; reason: string }[];
    intra_file_duplicates: number;
  } | null>(null);
  const [workbookResult, setWorkbookResult] = useState<unknown>(null);
  const [workbookBusy, setWorkbookBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const qs = new URLSearchParams();
    if (search) qs.set('search', search);
    if (branch) qs.set('branch', branch);
    if (panelId) qs.set('panelId', panelId);
    if (includeArchived) qs.set('includeArchived', 'true');
    const res = await api<{ candidates: Candidate[] }>(`/candidates?${qs}`, { token });
    setCandidates(res.candidates);
    const p = await api<{ panels: Panel[] }>('/panels', { token });
    setPanels(p.panels);
  }, [getToken, search, branch, panelId, includeArchived]);

  useEffect(() => {
    const q = params.get('q');
    if (q != null) setSearch(q);
  }, [params]);

  useEffect(() => {
    const t = setTimeout(() => void load().catch((e) => setError(String(e.message ?? e))), 250);
    return () => clearTimeout(t);
  }, [load]);

  const panelName = useCallback(
    (id: string) => panels.find((p) => p.id === id)?.name ?? '',
    [panels],
  );
  const getSortValue = useCallback(
    (c: Candidate, key: string): unknown => {
      switch (key) {
        case 'name':
          return c.full_name;
        case 'branch':
          return c.branch;
        case 'application':
          return c.application_id;
        case 'panel':
          return panelName(c.panel_id);
        case 'status':
          return c.interview_status;
        default:
          return '';
      }
    },
    [panelName],
  );
  const sort = useSort(candidates, getSortValue, 'name');

  const save = async () => {
    if (!editing) return;
    setError(null);
    const token = await getToken();
    if (!token) return;
    try {
      const body = {
        full_name: editing.full_name,
        branch: editing.branch ?? '',
        application_id: editing.application_id || null,
        panel_id: editing.panel_id,
        interview_status: editing.interview_status,
        shortlisting_status: editing.shortlisting_status,
      };
      if (editing.id) {
        await api(`/candidates/${editing.id}`, { method: 'PATCH', token, body: JSON.stringify(body) });
      } else {
        await api('/candidates', { method: 'POST', token, body: JSON.stringify(body) });
      }
      setEditing(null);
      setNotice('Candidate saved.');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Save failed');
    }
  };

  const doArchive = async (candidate: Candidate, archived: boolean) => {
    const token = await getToken();
    if (!token) return;
    await api(`/candidates/${candidate.id}/archive`, {
      method: 'POST',
      token,
      body: JSON.stringify({ archived }),
    });
    setConfirmArchive(null);
    setNotice(archived ? 'Candidate archived.' : 'Candidate restored.');
    await load();
  };

  const doImport = async () => {
    setError(null);
    setImportResult(null);
    const token = await getToken();
    if (!token) return;
    try {
      const res = await api<unknown>('/candidates/import', {
        method: 'POST',
        token,
        body: JSON.stringify({ csv: csvText }),
      });
      setImportResult(res);
      const r = res as { imported: number };
      setNotice(`Import finished: ${r.imported} imported.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed');
    }
  };

  // --- workbook import (per-vertical worksheets) ---
  const uploadWorkbook = async (dryRun: boolean) => {
    if (!workbookFile) return;
    setWorkbookBusy(true);
    setError(null);
    setWorkbookResult(null);
    try {
      const token = await getToken();
      if (!token) return;
      const body = new FormData();
      body.append('file', workbookFile);
      const res = await fetch(
        `${API_URL}/api/admin/applicants/import${dryRun ? '?dry_run=true' : ''}`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body },
      );
      const data = await res.json();
      if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? 'Import failed');
      if (dryRun) {
        setWorkbookPreview(data);
      } else {
        setWorkbookResult(data);
        setWorkbookPreview(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
        setWorkbookFile(null);
        setNotice(
          `Workbook imported: ${data.created} created, ${data.updated} updated, ${data.skipped_duplicates} duplicates skipped.`,
        );
        await load();
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Workbook import failed');
    } finally {
      setWorkbookBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Candidates"
        description="Search, import, and maintain applicant records for interview panels."
        actions={
          <button
            className="btn"
            onClick={() => setEditing({ panel_id: panels[0]?.id ?? '', branch: '' })}
            disabled={panels.length === 0}
          >
            Add candidate
          </button>
        }
      />
      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert success">{notice}</div>}

      <div className="card">
        <div className="filters">
          <div>
            <label>Search</label>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or application ID" />
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
          <label style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
              style={{ width: 'auto' }}
            />
            Show archived
          </label>
          <button
            className="btn"
            onClick={() => setEditing({ panel_id: panels[0]?.id ?? '', branch: '' })}
            disabled={panels.length === 0}
          >
            Add candidate
          </button>
          <button
            className="btn secondary"
            onClick={() => {
              void (async () => {
                const token = await getToken();
                if (token) await downloadCsv('/candidates/import/template.csv', token, 'candidates-template.csv');
              })().catch((e) => setError(e instanceof Error ? e.message : 'Download failed'));
            }}
          >
            Download CSV template
          </button>
        </div>
      </div>

      {editing && (
        <div className="card">
          <h3>{editing.id ? 'Edit candidate' : 'New candidate'}</h3>
          <div className="grid cols-2">
            <label className="field">
              <span>Full name</span>
              <input
                value={editing.full_name ?? ''}
                onChange={(e) => setEditing({ ...editing, full_name: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Branch</span>
              <input value={editing.branch ?? ''} onChange={(e) => setEditing({ ...editing, branch: e.target.value })} />
            </label>
            <label className="field">
              <span>Application ID (optional, unique)</span>
              <input
                value={editing.application_id ?? ''}
                onChange={(e) => setEditing({ ...editing, application_id: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Panel</span>
              <select
                value={editing.panel_id ?? ''}
                onChange={(e) => setEditing({ ...editing, panel_id: e.target.value })}
              >
                {panels.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Interview status</span>
              <select
                value={editing.interview_status ?? 'pending'}
                onChange={(e) => setEditing({ ...editing, interview_status: e.target.value as Candidate['interview_status'] })}
              >
                <option value="pending">Pending</option>
                <option value="in_progress">In progress</option>
                <option value="completed">Completed</option>
                <option value="no_show">No show</option>
              </select>
            </label>
            <label className="field">
              <span>Shortlisting status</span>
              <select
                value={editing.shortlisting_status ?? 'pending'}
                onChange={(e) => setEditing({ ...editing, shortlisting_status: e.target.value as Candidate['shortlisting_status'] })}
              >
                <option value="pending">Pending</option>
                <option value="shortlisted">Shortlisted</option>
                <option value="waitlisted">Waitlisted</option>
                <option value="rejected">Rejected</option>
              </select>
            </label>
          </div>
          <div className="btn-row">
            <button className="btn" onClick={() => void save()} disabled={!editing.full_name?.trim()}>
              Save
            </button>
            <button className="btn secondary" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="table-wrap card" style={{ padding: 0 }}>
        <table className="data">
          <thead>
            <tr>
              <SortableTh label="Name" sortKey="name" state={sort} />
              <SortableTh label="Branch" sortKey="branch" state={sort} />
              <SortableTh label="Application" sortKey="application" state={sort} />
              <SortableTh label="Panel" sortKey="panel" state={sort} title="Sorts Panel 1, Panel 2, … numerically" />
              <SortableTh label="Status" sortKey="status" state={sort} />
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sort.sorted.map((c) => (
              <tr key={c.id} style={c.archived_at ? { opacity: 0.55 } : undefined}>
                <td>
                  <button className="btn secondary small" onClick={() => setProfileId(c.id)}>
                    {c.full_name}
                  </button>
                </td>
                <td>{c.branch}</td>
                <td className="mono">{c.application_id ?? '—'}</td>
                <td>{panels.find((p) => p.id === c.panel_id)?.name ?? c.panel_id}</td>
                <td>
                  <span className="badge neutral">{c.interview_status.replace('_', ' ')}</span>{' '}
                  <span className="badge blue">{c.shortlisting_status}</span>
                  {c.archived_at && <span className="badge err">archived</span>}
                </td>
                <td>
                  <div className="btn-row">
                    <button className="btn secondary small" onClick={() => setEditing(c)}>
                      Edit
                    </button>
                    {c.archived_at ? (
                      <button className="btn secondary small" onClick={() => void doArchive(c, false)}>
                        Restore
                      </button>
                    ) : (
                      <button className="btn danger small" onClick={() => setConfirmArchive(c)}>
                        Archive
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {candidates.length === 0 && <div className="empty">No candidates found.</div>}
      </div>

      <div className="card mt">
        <h3>Workbook import (.xlsx / .xls / .csv)</h3>
        <p className="muted">
          Every worksheet is inspected — applicant sheets are detected by their header row (name /
          roll / email columns), other sheets are reported with a reason instead of being silently
          skipped. Re-imports upsert by roll number / email, so existing evaluations are kept.
        </p>
        <div className="filters">
          <div style={{ flex: 1 }}>
            <label>Workbook file</label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(e) => {
                setWorkbookFile(e.target.files?.[0] ?? null);
                setWorkbookPreview(null);
                setWorkbookResult(null);
              }}
            />
          </div>
          <button
            className="btn secondary"
            disabled={!workbookFile || workbookBusy}
            onClick={() => void uploadWorkbook(true)}
          >
            Preview
          </button>
          <button
            className="btn"
            disabled={!workbookFile || workbookBusy}
            onClick={() => void uploadWorkbook(false)}
          >
            {workbookBusy ? 'Working…' : 'Import'}
          </button>
        </div>

        {workbookPreview && (
          <div className="mt">
            <h4>
              Preview — {workbookPreview.applicant_count} applicant row
              {workbookPreview.applicant_count === 1 ? '' : 's'}
              {workbookPreview.intra_file_duplicates > 0 &&
                ` (${workbookPreview.intra_file_duplicates} duplicate rows inside the file)`}
            </h4>
            <table className="data">
              <thead>
                <tr>
                  <th>Sheet</th>
                  <th>Rows</th>
                  <th>Applicant rows</th>
                  <th>Used</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {workbookPreview.sheets.map((s) => (
                  <tr key={s.sheet}>
                    <td>{s.sheet}</td>
                    <td>{s.rows}</td>
                    <td>{s.applicantRows}</td>
                    <td>
                      <span className={`badge ${s.usedAsSource ? 'ok' : 'neutral'}`}>
                        {s.usedAsSource ? 'source' : 'skipped'}
                      </span>
                    </td>
                    <td className="muted">{s.reason ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {workbookPreview.errors.length > 0 && (
              <details className="mt">
                <summary>{workbookPreview.errors.length} row error(s)</summary>
                <ul>
                  {workbookPreview.errors.map((e, i) => (
                    <li key={i}>
                      {e.sheet} row {e.row}: {e.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}

        {workbookResult ? (
          <pre className="mono mt" style={{ whiteSpace: 'pre-wrap', fontSize: '0.82rem' }}>
            {JSON.stringify(workbookResult, null, 2)}
          </pre>
        ) : null}
      </div>

      <div className="card mt">
        <h3>CSV import</h3>
        <p className="muted">
          Columns: <code>full_name, branch, application_id, panel</code>. Panel by name or ID.
          Duplicate application IDs are skipped; errors are reported per row.
        </p>
        <textarea
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
          placeholder={'full_name,branch,application_id,panel\nAda Lovelace,CSE,APP-001,Panel A'}
          style={{ minHeight: 120 }}
        />
        <div className="btn-row mt">
          <button className="btn" onClick={() => void doImport()} disabled={!csvText.trim()}>
            Import
          </button>
        </div>
        {importResult ? (
          <pre className="mono mt" style={{ whiteSpace: 'pre-wrap', fontSize: '0.82rem' }}>
            {JSON.stringify(importResult, null, 2)}
          </pre>
        ) : null}
      </div>

      <ConfirmDialog
        open={!!confirmArchive}
        danger
        title="Archive candidate?"
        message={`${confirmArchive?.full_name ?? 'This candidate'} will be hidden from judges' lists. Existing evaluations are kept.`}
        confirmLabel="Archive"
        onCancel={() => setConfirmArchive(null)}
        onConfirm={() => confirmArchive && void doArchive(confirmArchive, true)}
      />

      {profileId && <AdminCandidateProfile candidateId={profileId} onClose={() => setProfileId(null)} />}
    </>
  );
}
