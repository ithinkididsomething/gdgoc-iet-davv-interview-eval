import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useOfflinePrep } from '../lib/offlinePrepContext';
import { useSync } from '../lib/syncContext';
import { Stat } from '../components/Ui';

export function Dashboard() {
  const { profile, panels, status, isOfflineSession } = useAuth();
  const {
    pending,
    conflicts,
    errors,
    synced,
    lastReport,
    lastSyncAt,
    syncNow,
    running,
  } = useSync();
  const { preparing, ready, error: prepError, report: prepReport } = useOfflinePrep();
  const isAdmin = profile?.role === 'admin';

  return (
    <>
      <h1>Welcome, {profile?.full_name?.split(' ')[0] || 'there'}</h1>
      <p className="muted">
        Review your panels, keep offline data ready, and move candidates through the interview process.
      </p>
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

      <div className="grid cols-4 mt">
        <Stat value={panels.length} label={`Panel${panels.length === 1 ? '' : 's'} assigned`} tone="blue" />
        {!isAdmin && (
          <>
            <Stat value={pending + errors} label="Evaluations waiting to sync" tone="yellow" />
            <Stat value={synced} label="Synchronized locally" tone="green" />
            <Stat value={conflicts} label="Conflicts to resolve" tone="red" />
          </>
        )}
        {isAdmin && <Stat label="Full management access" tone="blue">Admin</Stat>}
      </div>

      {isAdmin ? (
        <div className="grid cols-2 mt">
          <div className="card">
            <h3>Manage</h3>
            <p><Link to="/admin/results">Results &amp; export</Link></p>
            <p><Link to="/admin/candidates">Candidates, workbook &amp; CSV import</Link></p>
            <p><Link to="/admin/panels">Panels, codes &amp; judges</Link></p>
            <p><Link to="/admin/verticals">Verticals &amp; worksheet mapping</Link></p>
            <p><Link to="/admin/rounds">Rounds &amp; criteria</Link></p>
            <p><Link to="/admin/reports">Reports, exports &amp; spreadsheet sync</Link></p>
          </div>
        </div>
      ) : (
        <div className="grid cols-2 mt">
          <div className="card">
            <h3>Interviews</h3>
            {panels.length === 0 ? (
              <p className="muted">
                You have no verified panel yet. <Link to="/verify">Verify your panel code</Link> to
                get started.
              </p>
            ) : (
              <>
                <p>
                  <Link to="/candidates">Open candidate list →</Link>
                </p>
                <p>
                  <Link to="/my-evaluations">My evaluation history →</Link>
                </p>
              </>
            )}
          </div>
          <div className="card">
            <h3>Offline readiness</h3>
            <p>
              {preparing ? (
                <span className="badge blue">
                  <span className="spinner" style={{ width: 10, height: 10, borderWidth: 2 }} />{' '}
                  Preparing automatically
                </span>
              ) : ready ? (
                <span className="badge ok">Offline data ready</span>
              ) : (
                <span className="badge warn">
                  {prepError ? 'Waiting to retry' : 'Preparing automatically'}
                </span>
              )}
            </p>
            <p className="muted">
              Candidate lists and open rounds are saved automatically while you are online.
            </p>
            <p className="muted">
              {lastSyncAt
                ? `Last successful sync: ${new Date(lastSyncAt).toLocaleString()}`
                : 'Never synchronized on this device.'}
            </p>
            {prepError && <div className="alert warn">{prepError}</div>}
            {prepReport && !preparing && <div className="alert success">{prepReport}</div>}
            <div className="btn-row">
              <Link className="btn secondary" to="/offline">
                View offline status
              </Link>
              <button className="btn secondary" onClick={() => void syncNow()} disabled={running || status !== 'online'}>
                {running ? 'Syncing.' : 'Sync now'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
