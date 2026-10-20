import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { getLastSyncAt } from '../lib/sync';
import { useSync } from '../lib/syncContext';
import { useEffect, useState } from 'react';
import { getMeta } from '../lib/idb';
import { PageHeader } from '../components/PageHeader';
import { Stat } from '../components/Ui';
import { useOnline } from '../lib/net';

export function Dashboard() {
  const { profile, panels, status, isOfflineSession } = useAuth();
  const { pending, conflicts, errors, synced, lastReport, syncNow, running } = useSync();
  const online = useOnline();
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [prepared, setPrepared] = useState(false);
  const isAdmin = profile?.role === 'admin';
  const firstName = profile?.full_name?.split(' ')[0] || 'there';

  useEffect(() => {
    void getLastSyncAt().then(setLastSyncAt);
    void getMeta<boolean>('offline_prepared').then((v) => setPrepared(!!v));
  }, [pending, synced]);

  const waiting = pending + errors;
  const pipelineMax = Math.max(panels.length, waiting, synced, conflicts, 1);

  return (
    <>
      <PageHeader
        title={`Welcome, ${firstName}`}
        description={
          isAdmin
            ? 'Review recruitment operations, manage panels, and export results.'
            : 'Track your interview workload, prepare for offline sessions, and keep evaluations in sync.'
        }
        actions={
          isAdmin ? (
            <Link className="btn" to="/admin/results">
              View results
            </Link>
          ) : (
            <Link className="btn" to={panels.length ? '/candidates' : '/verify'}>
              {panels.length ? 'Open candidates' : 'Verify panel'}
            </Link>
          )
        }
      />

      {isOfflineSession && (
        <div className="alert warn">
          You are using a locally stored offline session, not a fresh server sign-in. Synchronization
          will require signing in again once you are online.
        </div>
      )}
      {status === 'online' && lastReport && (
        <div className={`alert ${lastReport.errors || lastReport.conflicts ? 'warn' : 'success'}`}>
          {lastReport.message}
        </div>
      )}

      <section className="section">
        <div className="grid cols-4">
          <Stat value={panels.length} label={`Panel${panels.length === 1 ? '' : 's'} assigned`} tone="blue" />
          {!isAdmin && (
            <>
              <Stat value={waiting} label="Evaluations waiting to sync" tone="yellow" />
              <Stat value={synced} label="Synchronized locally" tone="green" />
              <Stat value={conflicts} label="Conflicts to resolve" tone="red" />
            </>
          )}
          {isAdmin && (
            <Stat label="Full management access" tone="blue">
              Admin
            </Stat>
          )}
        </div>
      </section>

      {isAdmin ? (
        <div className="grid cols-2">
          <section className="card">
            <h3>Manage</h3>
            <div className="panel-list">
              <Link to="/admin/results">Results &amp; export</Link>
              <Link to="/admin/candidates">Candidates, workbook &amp; CSV import</Link>
              <Link to="/admin/panels">Panels, codes &amp; judges</Link>
              <Link to="/admin/verticals">Verticals &amp; worksheet mapping</Link>
              <Link to="/admin/rounds">Rounds &amp; criteria</Link>
              <Link to="/admin/reports">Reports, exports &amp; spreadsheet sync</Link>
            </div>
          </section>
          <section className="card">
            <h3>Recent activity</h3>
            <ul className="activity-list">
              <li>
                <span className={`activity-dot ${online ? 'ok' : 'warn'}`} />
                <span>
                  {online ? 'Network is available.' : 'This device is offline.'}
                  <span className="muted" style={{ display: 'block' }}>
                    Connection status
                  </span>
                </span>
              </li>
              <li>
                <span className="activity-dot" />
                <span>
                  {lastSyncAt
                    ? `Last successful sync ${new Date(lastSyncAt).toLocaleString()}`
                    : 'No successful sync on this device yet.'}
                </span>
              </li>
              {lastReport ? (
                <li>
                  <span className={`activity-dot ${lastReport.errors || lastReport.conflicts ? 'warn' : 'ok'}`} />
                  <span>{lastReport.message}</span>
                </li>
              ) : null}
            </ul>
          </section>
        </div>
      ) : (
        <div className="grid cols-2">
          <section className="card">
            <h3>Candidate pipeline</h3>
            <div className="pipeline">
              <div className="pipeline-row">
                <span>Panels</span>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: `${(panels.length / pipelineMax) * 100}%` }} />
                </div>
                <span className="bar-value">{panels.length}</span>
              </div>
              <div className="pipeline-row">
                <span>Waiting</span>
                <div className="bar-track">
                  <div className="bar-fill yellow" style={{ width: `${(waiting / pipelineMax) * 100}%` }} />
                </div>
                <span className="bar-value">{waiting}</span>
              </div>
              <div className="pipeline-row">
                <span>Synced</span>
                <div className="bar-track">
                  <div className="bar-fill green" style={{ width: `${(synced / pipelineMax) * 100}%` }} />
                </div>
                <span className="bar-value">{synced}</span>
              </div>
              <div className="pipeline-row">
                <span>Conflicts</span>
                <div className="bar-track">
                  <div className="bar-fill red" style={{ width: `${(conflicts / pipelineMax) * 100}%` }} />
                </div>
                <span className="bar-value">{conflicts}</span>
              </div>
            </div>
          </section>

          <section className="card">
            <h3>Upcoming interviews</h3>
            {panels.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                You have no verified panel yet. <Link to="/verify">Verify your panel code</Link> to get
                started.
              </p>
            ) : (
              <div className="panel-list">
                {panels.map((p) => (
                  <Link key={p.id} to="/candidates">
                    <span>
                      <strong>{p.name}</strong>
                      <span className="muted" style={{ display: 'block', fontSize: 12 }}>
                        {[p.shift, p.is_active ? 'Active' : 'Inactive'].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span className="badge blue">Open</span>
                  </Link>
                ))}
              </div>
            )}
          </section>

          <section className="card">
            <h3>Offline readiness</h3>
            <p>
              {prepared ? (
                <span className="badge ok">Prepared for offline interviews</span>
              ) : (
                <span className="badge warn">Not prepared yet</span>
              )}
            </p>
            <p className="muted">
              {lastSyncAt
                ? `Last successful sync: ${new Date(lastSyncAt).toLocaleString()}`
                : 'Never synchronized on this device.'}
            </p>
            <div className="btn-row">
              <Link className="btn secondary" to="/offline">
                Prepare / re-check
              </Link>
              <button
                className="btn secondary"
                onClick={() => void syncNow()}
                disabled={running || status !== 'online'}
              >
                {running ? 'Syncing…' : 'Sync now'}
              </button>
            </div>
          </section>

          <section className="card">
            <h3>Recent activity</h3>
            <ul className="activity-list">
              <li>
                <span className={`activity-dot ${online ? 'ok' : 'warn'}`} />
                <span>
                  {online ? 'Network is available.' : 'This device is offline.'}
                  <span className="muted" style={{ display: 'block' }}>
                    {waiting > 0
                      ? `${waiting} evaluation${waiting === 1 ? '' : 's'} queued`
                      : 'Nothing waiting to upload'}
                  </span>
                </span>
              </li>
              <li>
                <span className={`activity-dot ${prepared ? 'ok' : 'warn'}`} />
                <span>
                  {prepared ? 'This device is prepared for offline interviews.' : 'Offline preparation has not been run.'}
                </span>
              </li>
              <li>
                <span className="activity-dot" />
                <span>
                  {lastSyncAt
                    ? `Last successful sync ${new Date(lastSyncAt).toLocaleString()}`
                    : 'No successful sync on this device yet.'}
                </span>
              </li>
              {conflicts > 0 ? (
                <li>
                  <span className="activity-dot err" />
                  <span>
                    {conflicts} conflict{conflicts === 1 ? '' : 's'} need review.{' '}
                    <Link to="/sync">Open sync</Link>
                  </span>
                </li>
              ) : null}
            </ul>
          </section>
        </div>
      )}
    </>
  );
}
