import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { ThemeToggle } from '../components/ThemeToggle';
import { useAuth } from '../lib/auth';
import { getLastSyncAt } from '../lib/sync';
import { useSync } from '../lib/syncContext';
import { useTheme } from '../lib/theme';

export function Settings() {
  const { profile, panels, status, signOut, isOfflineSession } = useAuth();
  const { pending, conflicts } = useSync();
  const { theme } = useTheme();
  const navigate = useNavigate();
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);

  useEffect(() => {
    void getLastSyncAt().then(setLastSyncAt);
  }, []);

  const handleLogout = async () => {
    if (
      (pending > 0 || conflicts > 0) &&
      !window.confirm(
        'You have evaluations that are not synchronized. Logging out on this device will clear local data, including queued evaluations. Continue?',
      )
    ) {
      return;
    }
    await signOut();
    navigate('/login');
  };

  return (
    <>
      <PageHeader
        title="Settings"
        description="Account, appearance, and session details for this device. Nothing here changes evaluation data."
      />

      <div className="settings-grid">
        <section className="card">
          <h3>Profile</h3>
          <p className="muted">Signed-in interviewer details from the current session.</p>
          <div className="profile-grid" style={{ marginTop: 16 }}>
            <div>
              <span className="label">Name</span>
              <span>{profile?.full_name || '—'}</span>
            </div>
            <div>
              <span className="label">Email</span>
              <span>{profile?.email || '—'}</span>
            </div>
            <div>
              <span className="label">Role</span>
              <span style={{ textTransform: 'capitalize' }}>{profile?.role || '—'}</span>
            </div>
            <div>
              <span className="label">Assigned panels</span>
              <span>{panels.length === 0 ? 'None' : panels.map((p) => p.name).join(', ')}</span>
            </div>
          </div>
        </section>

        <section className="card">
          <h3>Appearance</h3>
          <p className="muted">Theme is stored on this device only.</p>
          <div className="btn-row mt" style={{ justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Colour mode</div>
              <div className="muted" style={{ fontSize: 13 }}>
                Currently {theme === 'dark' ? 'dark' : 'light'}
              </div>
            </div>
            <ThemeToggle />
          </div>
        </section>

        <section className="card">
          <h3>Session</h3>
          <p className="muted">Connection and local synchronization state.</p>
          <div className="profile-grid" style={{ marginTop: 16 }}>
            <div>
              <span className="label">Session type</span>
              <span>
                {isOfflineSession ? (
                  <span className="badge warn">Offline session</span>
                ) : status === 'online' ? (
                  <span className="badge ok">Online</span>
                ) : (
                  <span className="badge neutral">{status}</span>
                )}
              </span>
            </div>
            <div>
              <span className="label">Last successful sync</span>
              <span>{lastSyncAt ? new Date(lastSyncAt).toLocaleString() : 'Never on this device'}</span>
            </div>
            <div>
              <span className="label">Queued evaluations</span>
              <span>{pending}</span>
            </div>
            <div>
              <span className="label">Conflicts</span>
              <span>{conflicts}</span>
            </div>
          </div>
        </section>

        <section className="card">
          <h3>Sign out</h3>
          <p className="muted">
            Signing out wipes locally cached candidates and queued evaluations on this browser.
          </p>
          <div className="btn-row mt">
            <button type="button" className="btn danger" onClick={() => void handleLogout()}>
              Sign out
            </button>
          </div>
        </section>
      </div>
    </>
  );
}
