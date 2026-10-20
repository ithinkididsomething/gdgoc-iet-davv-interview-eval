import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthShell } from '../components/Ui';
import { useAuth } from '../lib/auth';
import { DEMO_MODE } from '../lib/config';

export function Login() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState(DEMO_MODE ? 'admin@demo.local' : '');
  const [password, setPassword] = useState(DEMO_MODE ? 'demo1234' : '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Sign in" subtitle="GDGOC IET DAVV interview evaluation">
      {DEMO_MODE && (
        <div className="alert info">
          Demo mode — admin: <span className="mono">admin@demo.local</span> /{' '}
          <span className="mono">demo1234</span>
          <br />
          Judge: <span className="mono">judge@demo.local</span> / <span className="mono">demo1234</span>
        </div>
      )}
      {error && <div className="alert error">{error}</div>}
      <form onSubmit={submit}>
        <label className="field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
        </label>
        <button className="btn" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="mt muted">
        New judge? <Link to="/register">Create an account</Link>
      </p>
    </AuthShell>
  );
}
