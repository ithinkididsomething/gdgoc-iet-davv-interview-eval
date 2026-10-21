import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, downloadCsv } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ProgressBar, Stat } from '../components/Ui';
import type { SheetConnectionStatus, Vertical } from '../lib/types';

interface Overview {
  totals: {
    applicants: number;
    evaluated: number;
    complete: number;
    provisional: number;
    shortlisted: number;
    avg_of_averages: string | null;
  };
  by_vertical: { vertical: string; applicants: number; evaluated: number; provisional: number; avg_of_averages: string | null }[];
  export_types: string[];
  export_formats: string[];
}

type ExportType = 'summary' | 'individual' | 'criterion' | 'vertical';
const TYPE_LABELS: Record<ExportType, string> = {
  summary: 'Summary (one row per applicant)',
  individual: 'Individual scores (one row per judge rating)',
  criterion: 'Criterion breakdown (+ written feedback)',
  vertical: 'Vertical rollup',
};

interface PullSummary {
  pulled: { worksheet: string; created: number; updated: number; skipped: number; errors: number }[];
  pushed: { id: string; status: string; detail?: string }[];
  skipped: string[];
  connection_ok: boolean;
  error?: string;
}

interface ExportSummary {
  written: { worksheet: string; rows: number; created: boolean }[];
  skipped: string[];
  connection_ok: boolean;
  error?: string;
}

export function AdminReports() {
  const { getToken } = useAuth();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [status, setStatus] = useState<SheetConnectionStatus | null>(null);
  const [verticals, setVerticals] = useState<Vertical[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncResult, setSyncResult] = useState<{ pull: PullSummary; push: PullSummary } | null>(null);
  const [exportResult, setExportResult] = useState<ExportSummary | null>(null);
  const [sheetId, setSheetId] = useState('');

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    try {
      const [o, s, v] = await Promise.all([
        api<Overview>('/reports/overview', { token }),
        api<SheetConnectionStatus>('/sheets/connection', { token }),
        api<{ verticals: Vertical[] }>('/verticals', { token }),
      ]);
      setOverview(o);
      setStatus(s);
      setVerticals(v.verticals);
      setSheetId(s.spreadsheet_id);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load reports');
    }
  }, [getToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const download = async (type: ExportType, format: 'csv' | 'xlsx') => {
    try {
      const token = await getToken();
      if (!token) return;
      await downloadCsv(`/reports/export?type=${type}&format=${format}`, token, `gdgoc-${type}.${format}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed');
    }
  };

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) return;
      await api('/sheets/connection', {
        method: 'PUT',
        token,
        body: JSON.stringify({ spreadsheet_id: sheetId.trim(), title: '' }),
      });
      setNotice('Spreadsheet connected. Map worksheets to verticals on the Verticals screen.');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Connect failed');
    } finally {
      setBusy(false);
    }
  };

  const writeApplicants = async () => {
    setBusy(true);
    setError(null);
    setSyncResult(null);
    setExportResult(null);
    try {
      const token = await getToken();
      if (!token) return;
      const res = await api<ExportSummary>('/sheets/export', { method: 'POST', token });
      setExportResult(res);
      const rows = res.written.reduce((n, w) => n + w.rows, 0);
      setNotice(`Wrote ${rows} applicants to ${res.written.length} tabs.`);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Writing applicants failed');
    } finally {
      setBusy(false);
    }
  };

  const runSync = async (direction: 'pull' | 'push' | 'both') => {
    setBusy(true);
    setError(null);
    setSyncResult(null);
    try {
      const token = await getToken();
      if (!token) return;
      const path = direction === 'both' ? '/sheets/sync' : direction === 'pull' ? '/sheets/pull' : '/sheets/push';
      const res =
        direction === 'both'
          ? await api<{ pull: PullSummary; push: PullSummary }>(path, { method: 'POST', token })
          : ({ pull: direction === 'pull' ? await api<PullSummary>(path, { method: 'POST', token }) : emptySummary(),
              push: direction === 'push' ? await api<PullSummary>(path, { method: 'POST', token }) : emptySummary() } as {
              pull: PullSummary;
              push: PullSummary;
            });
      setSyncResult(res);
      setNotice('Sync run finished.');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Sync failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>Reports &amp; exports</h1>
      <p className="muted">Generate recruitment exports and synchronize evaluation data with Google Sheets.</p>
      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert success">{notice}</div>}

      {overview && (
        <>
          <div className="grid cols-4 mt">
            <Stat value={overview.totals.applicants} label="Applicants" tone="blue" />
            <Stat value={overview.totals.complete} label="Fully evaluated" tone="green" />
            <Stat
              value={overview.totals.provisional}
              label="Provisional (partial panel)"
              tone="yellow"
            />
            <Stat label="Average of averages" tone="blue">
              {overview.totals.avg_of_averages ?? '—'}
            </Stat>
          </div>

          <div className="card mt">
            <div className="btn-row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <h3 style={{ margin: 0 }}>Evaluation progress</h3>
              <span className="muted">
                {overview.totals.complete} of {overview.totals.applicants} fully evaluated
              </span>
            </div>
            <ProgressBar
              value={overview.totals.complete}
              max={overview.totals.applicants}
              tone="green"
              label="Applicants fully evaluated"
            />
          </div>

          <div className="card mt">
            <h3>Per-vertical rollup</h3>
            <div className="bar-chart mb">
              {overview.by_vertical.map((v) => {
                const pct = v.applicants > 0 ? (v.evaluated / v.applicants) * 100 : 0;
                return (
                  <div className="bar-row" key={v.vertical}>
                    <span className="nowrap">{v.vertical}</span>
                    <div className="bar-track">
                      <div className="bar-fill" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="bar-value">
                      {v.evaluated}/{v.applicants}
                    </span>
                  </div>
                );
              })}
            </div>
            <table className="data">
              <thead>
                <tr>
                  <th>Vertical</th>
                  <th>Applicants</th>
                  <th>Evaluated</th>
                  <th>Provisional</th>
                  <th>Avg of averages</th>
                </tr>
              </thead>
              <tbody>
                {overview.by_vertical.map((v) => (
                  <tr key={v.vertical}>
                    <td>{v.vertical}</td>
                    <td>{v.applicants}</td>
                    <td>{v.evaluated}</td>
                    <td>{v.provisional}</td>
                    <td>{v.avg_of_averages ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card mt">
            <h3>Exports</h3>
            <p className="muted">Four report types, each available as CSV or XLSX.</p>
            <div className="table-wrap" style={{ padding: 0 }}>
              <table className="data">
                <tbody>
                  {(Object.keys(TYPE_LABELS) as ExportType[]).map((t) => (
                    <tr key={t}>
                      <td>{TYPE_LABELS[t]}</td>
                      <td style={{ width: 220 }}>
                        <div className="btn-row">
                          <button className="btn secondary small" onClick={() => void download(t, 'csv')}>
                            CSV
                          </button>
                          <button className="btn secondary small" onClick={() => void download(t, 'xlsx')}>
                            XLSX
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <div className="card mt">
        <h3>Spreadsheet sync</h3>
        {!status?.configured ? (
          <>
            <p className="muted">
              Google Sheets sync runs server-side with a service account. Paste the spreadsheet
              link (or just its ID) — the sheet must be shared with the service-account email.
            </p>
            <label className="field">
              <span>Spreadsheet link or ID</span>
              <input
                value={sheetId}
                onChange={(e) => setSheetId(e.target.value)}
                placeholder="https://docs.google.com/spreadsheets/d/…/edit"
              />
            </label>
            <button className="btn" disabled={busy || !sheetId.trim()} onClick={() => void connect()}>
              Connect
            </button>
          </>
        ) : (
          <>
            <p>
              Connected:{' '}
              <a href={status.url} target="_blank" rel="noreferrer noopener" className="mono">
                {status.spreadsheet_id}
              </a>{' '}
              <span className={`badge ${status.connection?.last_sync_status === 'ok' ? 'ok' : 'neutral'}`}>
                last sync: {status.connection?.last_sync_status ?? 'never'}
              </span>
            </p>
            {verticals.filter((v) => v.worksheet).length > 0 ? (
              <p className="muted">
                Mapped worksheets:{' '}
                {verticals
                  .filter((v) => v.worksheet)
                  .map((v) => `${v.name} → “${v.worksheet}”`)
                  .join(' · ')}
              </p>
            ) : (
              <p className="warn">No vertical has a worksheet mapped yet — pull will skip them.</p>
            )}
            <div className="btn-row">
              <button className="btn secondary" disabled={busy} onClick={() => void writeApplicants()}>
                Write applicants to sheet
              </button>
              <button className="btn secondary" disabled={busy} onClick={() => void runSync('pull')}>
                Pull applicants
              </button>
              <button className="btn secondary" disabled={busy} onClick={() => void runSync('push')}>
                Push evaluations
              </button>
              <button className="btn" disabled={busy} onClick={() => void runSync('both')}>
                {busy ? 'Syncing…' : 'Sync both ways'}
              </button>
            </div>
          </>
        )}

        {exportResult && (
          <div className="mt">
            <h4>Applicants written</h4>
            <ul>
              {exportResult.connection_ok === false && (
                <li className="error-text">{exportResult.error ?? 'Not configured'}</li>
              )}
              {exportResult.written.map((w) => (
                <li key={w.worksheet}>
                  <strong>{w.worksheet}</strong>: {w.rows} applicants{w.created ? ' (tab created)' : ''}
                </li>
              ))}
              {exportResult.skipped.map((s) => (
                <li key={s} className="muted">
                  {s}
                </li>
              ))}
            </ul>
          </div>
        )}

        {syncResult && (
          <div className="mt">
            <h4>Pull</h4>
            <ul>
              {syncResult.pull.connection_ok === false && (
                <li className="error-text">{syncResult.pull.error ?? 'Not configured'}</li>
              )}
              {syncResult.pull.pulled.map((p) => (
                <li key={p.worksheet}>
                  <strong>{p.worksheet}</strong>: {p.created} created, {p.updated} updated,{' '}
                  {p.skipped} skipped, {p.errors} errors
                </li>
              ))}
              {syncResult.pull.skipped.map((s) => (
                <li key={s} className="muted">
                  {s}
                </li>
              ))}
            </ul>
            <h4>Push</h4>
            <ul>
              {syncResult.push.connection_ok === false && (
                <li className="error-text">{syncResult.push.error ?? 'Not configured'}</li>
              )}
              {syncResult.push.pushed.map((p) => (
                <li key={p.id}>
                  <span className={`badge ${p.status === 'done' ? 'ok' : 'err'}`}>{p.status}</span>{' '}
                  {p.detail ?? ''}
                </li>
              ))}
              {syncResult.push.pushed.length === 0 && <li className="muted">Queue empty.</li>}
            </ul>
          </div>
        )}
      </div>
    </>
  );
}

function emptySummary(): PullSummary {
  return { pulled: [], pushed: [], skipped: [], connection_ok: true };
}
