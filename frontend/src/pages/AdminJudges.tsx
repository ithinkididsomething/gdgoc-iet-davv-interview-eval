import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ConfirmDialog } from '../components/Ui';
import { SortableTh, useSort } from '../components/Sortable';

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  role: 'judge' | 'admin';
  is_active: boolean;
  created_at: string;
  panels: string[];
}

export function AdminJudges() {
  const { getToken, profile } = useAuth();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ user: UserRow; action: 'role' | 'active' } | null>(null);

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const res = await api<{ users: UserRow[] }>('/admin/users', { token });
    setUsers(res.users);
  }, [getToken]);

  useEffect(() => {
    void load().catch((e) => setError(String(e.message ?? e)));
  }, [load]);

  const getSortValue = useCallback((u: UserRow, key: string): unknown => {
    switch (key) {
      case 'name':
        return u.full_name;
      case 'email':
        return u.email;
      case 'role':
        return u.role;
      case 'panels':
        return u.panels.join(', ');
      case 'status':
        return u.is_active;
      default:
        return '';
    }
  }, []);
  const sort = useSort(users, getSortValue, 'name');

  const changeRole = async (user: UserRow) => {
    const token = await getToken();
    if (!token) return;
    try {
      await api(`/admin/users/${user.id}/role`, {
        method: 'PATCH',
        token,
        body: JSON.stringify({ role: user.role === 'admin' ? 'judge' : 'admin' }),
      });
      setNotice('Role updated.');
      setConfirm(null);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Role change failed');
      setConfirm(null);
    }
  };

  const toggleActive = async (user: UserRow) => {
    const token = await getToken();
    if (!token) return;
    try {
      await api(`/admin/users/${user.id}/active`, {
        method: 'PATCH',
        token,
        body: JSON.stringify({ is_active: !user.is_active }),
      });
      setNotice(user.is_active ? 'Account deactivated.' : 'Account activated.');
      setConfirm(null);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Update failed');
      setConfirm(null);
    }
  };

  return (
    <>
      <h1>Judges &amp; accounts</h1>
      <p className="muted">
        Judge accounts are created through the registration page. Promote an account to administrator
        here — never share the admin credentials. Deactivating a judge blocks their API access
        immediately (their stored evaluations are kept).
      </p>
      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert success">{notice}</div>}
      <div className="table-wrap card" style={{ padding: 0 }}>
        <table className="data wide-table">
          <thead>
            <tr>
              <SortableTh label="Name" sortKey="name" state={sort} />
              <SortableTh label="Email" sortKey="email" state={sort} />
              <SortableTh label="Role" sortKey="role" state={sort} />
              <SortableTh label="Panels" sortKey="panels" state={sort} />
              <SortableTh label="Status" sortKey="status" state={sort} />
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sort.sorted.map((u) => (
              <tr key={u.id}>
                <td>{u.full_name}</td>
                <td>{u.email}</td>
                <td>
                  <span className={`badge ${u.role === 'admin' ? 'blue' : 'neutral'}`}>{u.role}</span>
                </td>
                <td>{u.panels.join(', ') || '—'}</td>
                <td>
                  <span className={`badge ${u.is_active ? 'ok' : 'err'}`}>
                    {u.is_active ? 'active' : 'deactivated'}
                  </span>
                </td>
                <td>
                  <div className="btn-row">
                    {u.id !== profile?.id && (
                      <>
                        <button
                          className="btn secondary small"
                          onClick={() => setConfirm({ user: u, action: 'role' })}
                        >
                          {u.role === 'admin' ? 'Make judge' : 'Make admin'}
                        </button>
                        <button
                          className={`btn small ${u.is_active ? 'danger' : 'secondary'}`}
                          onClick={() => setConfirm({ user: u, action: 'active' })}
                        >
                          {u.is_active ? 'Deactivate' : 'Activate'}
                        </button>
                      </>
                    )}
                    {u.id === profile?.id && <span className="muted">you</span>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ConfirmDialog
        open={!!confirm}
        danger
        title={confirm?.action === 'role' ? 'Change role?' : confirm?.user.is_active ? 'Deactivate account?' : 'Activate account?'}
        message={
          confirm?.action === 'role'
            ? `Change role for ${confirm?.user.full_name}?`
            : confirm?.user.is_active
              ? `${confirm?.user.full_name} will lose access immediately.`
              : `${confirm?.user.full_name} will regain access.`
        }
        confirmLabel="Confirm"
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (!confirm) return;
          if (confirm.action === 'role') void changeRole(confirm.user);
          else void toggleActive(confirm.user);
        }}
      />
    </>
  );
}
