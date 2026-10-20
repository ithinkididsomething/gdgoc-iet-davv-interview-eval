import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useOnline } from '../lib/net';
import { useSync } from '../lib/syncContext';
import { Icons } from './icons';
import { ThemeToggle } from './ThemeToggle';

type NavItem = {
  to: string;
  label: string;
  icon: keyof typeof Icons;
  end?: boolean;
  badge?: 'sync' | 'offline';
};

type NavGroup = { id: string; label: string; items: NavItem[] };

const JUDGE_NAV: NavGroup[] = [
  {
    id: 'workspace',
    label: 'Workspace',
    items: [
      { to: '/', label: 'Overview', icon: 'overview', end: true },
      { to: '/candidates', label: 'Candidates', icon: 'candidates' },
      { to: '/my-evaluations', label: 'My Evaluations', icon: 'evaluations' },
    ],
  },
  {
    id: 'operations',
    label: 'Operations',
    items: [
      { to: '/offline', label: 'Offline', icon: 'offline', badge: 'offline' },
      { to: '/sync', label: 'Sync', icon: 'sync', badge: 'sync' },
    ],
  },
];

const ADMIN_NAV: NavGroup[] = [
  {
    id: 'workspace',
    label: 'Workspace',
    items: [{ to: '/', label: 'Overview', icon: 'overview', end: true }],
  },
  {
    id: 'operations',
    label: 'Operations',
    items: [
      { to: '/admin/results', label: 'Results', icon: 'results' },
      { to: '/admin/candidates', label: 'Candidates', icon: 'candidates' },
      { to: '/admin/panels', label: 'Panels', icon: 'panels' },
      { to: '/admin/judges', label: 'Judges', icon: 'judges' },
      { to: '/admin/verticals', label: 'Verticals', icon: 'verticals' },
      { to: '/admin/rounds', label: 'Rounds', icon: 'rounds' },
      { to: '/admin/reports', label: 'Reports', icon: 'reports' },
      { to: '/sync', label: 'Sync', icon: 'sync', badge: 'sync' },
    ],
  },
];

const CRUMBS: Record<string, string> = {
  '/': 'Overview',
  '/candidates': 'Candidates',
  '/my-evaluations': 'My Evaluations',
  '/offline': 'Offline',
  '/sync': 'Sync',
  '/settings': 'Settings',
  '/verify': 'Verify panel',
  '/admin': 'Overview',
  '/admin/results': 'Results',
  '/admin/candidates': 'Candidates',
  '/admin/panels': 'Panels',
  '/admin/judges': 'Judges',
  '/admin/verticals': 'Verticals',
  '/admin/rounds': 'Rounds',
  '/admin/reports': 'Reports',
};

function initials(name?: string | null) {
  if (!name?.trim()) return '?';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
}

function crumbFor(pathname: string) {
  if (CRUMBS[pathname]) return CRUMBS[pathname];
  if (pathname.includes('/evaluate')) return 'Evaluate';
  return 'Workspace';
}

export function NetSyncIndicators() {
  const online = useOnline();
  const { pending, conflicts, errors, running } = useSync();
  const queued = pending + errors;
  return (
    <>
      <span className={`badge ${online ? 'ok' : 'warn'}`} title={online ? 'Network interface is up' : 'Device is offline'}>
        {online ? 'Online' : 'Offline'}
      </span>
      {running ? (
        <span className="badge blue">
          <span className="spinner" style={{ width: 10, height: 10, borderWidth: 2 }} /> Syncing
        </span>
      ) : queued > 0 || conflicts > 0 ? (
        <span className={`badge ${conflicts > 0 ? 'err' : 'warn'}`} title={`${queued} waiting, ${conflicts} conflicts`}>
          {queued} to sync{conflicts > 0 ? ` · ${conflicts} conflict${conflicts > 1 ? 's' : ''}` : ''}
        </span>
      ) : (
        <span className="badge ok">Synced</span>
      )}
    </>
  );
}

function SidebarNav({
  groups,
  onNavigate,
}: {
  groups: NavGroup[];
  onNavigate?: () => void;
}) {
  const online = useOnline();
  const { pending, conflicts, errors } = useSync();
  const queued = pending + errors;

  return (
    <nav className="sidebar-nav" aria-label="Primary">
      {groups.map((group) => (
        <div className="nav-group" key={group.id}>
          <div className="nav-group-label">{group.label}</div>
          {group.items.map((item) => {
            const Icon = Icons[item.icon];
            const showSync = item.badge === 'sync' && (queued > 0 || conflicts > 0);
            const showOffline = item.badge === 'offline' && !online;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                data-tooltip={item.label}
                title={item.label}
                onClick={onNavigate}
              >
                <Icon size={20} />
                <span className="nav-label">{item.label}</span>
                {showSync ? (
                  <span className={`nav-badge${conflicts > 0 ? ' err' : ''}`} aria-label={`${queued} waiting to sync`}>
                    {queued || conflicts}
                  </span>
                ) : showOffline ? (
                  <span className="nav-dot warn" aria-label="Offline" />
                ) : null}
              </NavLink>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { profile, signOut, status } = useAuth();
  const { pending, conflicts, errors, running, lastReport } = useSync();
  const online = useOnline();
  const navigate = useNavigate();
  const location = useLocation();
  const isAdmin = profile?.role === 'admin';
  const groups = isAdmin ? ADMIN_NAV : JUDGE_NAV;

  const [navOpen, setNavOpen] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const [headerUser, setHeaderUser] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');

  const navId = useId();
  const notesId = useId();
  const userMenuId = useId();
  const sidebarRef = useRef<HTMLElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setNavOpen(false);
    setUserMenu(false);
    setHeaderUser(false);
    setNotesOpen(false);
    setSearchOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    document.body.classList.toggle('nav-open', navOpen);
    return () => document.body.classList.remove('nav-open');
  }, [navOpen]);

  useEffect(() => {
    if (!navOpen) return;
    closeBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);

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

  const submitSearch = (e: FormEvent) => {
    e.preventDefault();
    const dest = isAdmin ? '/admin/candidates' : '/candidates';
    const q = query.trim();
    navigate(q ? `${dest}?q=${encodeURIComponent(q)}` : dest);
    setSearchOpen(false);
  };

  const queued = pending + errors;
  const crumb = crumbFor(location.pathname);

  return (
    <div className="layout">
      {navOpen ? (
        <button type="button" className="overlay" aria-label="Close navigation" onClick={() => setNavOpen(false)} />
      ) : null}

      <aside
        ref={sidebarRef}
        id={navId}
        className={`sidebar${navOpen ? ' open' : ''}`}
        aria-label="Application"
      >
        <Link to="/" className="sidebar-brand" onClick={() => setNavOpen(false)}>
          <img className="brand-mark-img" src="/gdg-mark.png" alt="Google Developer Group IET DAVV" />
          <span className="brand-text">
            <span className="brand-name">GDGOC Interviews</span>
            <span className="brand-sub">IET DAVV</span>
          </span>
        </Link>

        <button
          type="button"
          className="sidebar-user"
          aria-expanded={userMenu}
          aria-controls={userMenuId}
          data-tooltip={profile?.full_name || 'Account'}
          onClick={() => setUserMenu((v) => !v)}
        >
          <span className="avatar" aria-hidden="true">
            {initials(profile?.full_name)}
          </span>
          <span className="user-meta">
            <span className="user-name">{profile?.full_name || 'Signed in'}</span>
            <span className="user-role">
              {profile?.role}
              {status === 'offline' ? ' · offline' : ''}
            </span>
          </span>
          <Icons.chevronDown className="chevron" size={16} />
        </button>
        {userMenu ? (
          <div id={userMenuId} className="user-menu" role="menu">
            <p>{profile?.email}</p>
            <Link to="/settings" role="menuitem" onClick={() => setUserMenu(false)}>
              Account settings
            </Link>
          </div>
        ) : null}

        <hr className="sidebar-divider" />

        <SidebarNav groups={groups} onNavigate={() => setNavOpen(false)} />

        <div className="sidebar-footer">
          <NavLink
            to="/settings"
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            data-tooltip="Settings"
            title="Settings"
            onClick={() => setNavOpen(false)}
          >
            <Icons.settings size={20} />
            <span className="nav-label">Settings</span>
          </NavLink>
          <button
            type="button"
            className="sign-out-btn"
            onClick={() => void handleLogout()}
            data-tooltip="Sign out"
            title="Sign out"
          >
            <Icons.signOut size={20} />
            <span className="sign-out-label">Sign out</span>
          </button>
        </div>
      </aside>

      <div className="shell">
        <header className="app-header">
          <div className="header-left">
            <button
              ref={closeBtnRef}
              type="button"
              className="menu-btn"
              aria-label={navOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={navOpen}
              aria-controls={navId}
              onClick={() => setNavOpen((v) => !v)}
            >
              {navOpen ? <Icons.close size={20} /> : <Icons.menu size={20} />}
            </button>
            <nav className="breadcrumb" aria-label="Breadcrumb">
              <span>Workspace</span>
              <Icons.chevronRight size={14} />
              <span className="current">{crumb}</span>
            </nav>
          </div>

          <div className="header-right">
            <form className={`header-search${searchOpen ? ' expanded' : ''}`} onSubmit={submitSearch} role="search">
              <Icons.search size={16} />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search candidates…"
                aria-label="Search candidates"
              />
              <button type="submit" className="visually-hidden">
                Search
              </button>
            </form>
            <button
              type="button"
              className="icon-btn header-search-toggle"
              aria-label="Search"
              title="Search candidates"
              onClick={() => setSearchOpen((v) => !v)}
            >
              <Icons.search size={18} />
            </button>

            <div style={{ position: 'relative' }}>
              <button
                type="button"
                className="icon-btn"
                aria-label="Notifications"
                aria-expanded={notesOpen}
                aria-controls={notesId}
                title="Notifications"
                onClick={() => {
                  setNotesOpen((v) => !v);
                  setHeaderUser(false);
                }}
              >
                <Icons.bell size={18} />
                {queued > 0 || conflicts > 0 || !online ? <span className="pulse-dot" /> : null}
              </button>
              {notesOpen ? (
                <div id={notesId} className="popover" role="dialog" aria-label="Notifications">
                  <div className="popover-title">Status</div>
                  <Link className="popover-item" to="/sync" onClick={() => setNotesOpen(false)}>
                    <span>
                      {running
                        ? 'Synchronization in progress'
                        : queued > 0
                          ? `${queued} evaluation${queued === 1 ? '' : 's'} waiting to sync`
                          : 'All evaluations are synced'}
                      <span className="muted">
                        {online ? 'Network available' : 'You are offline'}
                        {conflicts > 0 ? ` · ${conflicts} conflict${conflicts > 1 ? 's' : ''}` : ''}
                      </span>
                    </span>
                  </Link>
                  {lastReport ? (
                    <Link className="popover-item" to="/sync" onClick={() => setNotesOpen(false)}>
                      <span>
                        Last sync report
                        <span className="muted">{lastReport.message}</span>
                      </span>
                    </Link>
                  ) : null}
                </div>
              ) : null}
            </div>

            <ThemeToggle />

            <div style={{ position: 'relative' }}>
              <button
                type="button"
                className="header-user"
                aria-label="Account menu"
                aria-expanded={headerUser}
                onClick={() => {
                  setHeaderUser((v) => !v);
                  setNotesOpen(false);
                }}
              >
                <span className="avatar" aria-hidden="true">
                  {initials(profile?.full_name)}
                </span>
                <span className="user-name">{profile?.full_name}</span>
              </button>
              {headerUser ? (
                <div className="popover" role="menu">
                  <p className="popover-title">{profile?.full_name}</p>
                  <p style={{ margin: 0, padding: '0 10px 8px', fontSize: 12 }} className="muted">
                    {profile?.email}
                  </p>
                  <Link className="popover-item" to="/settings" onClick={() => setHeaderUser(false)}>
                    Settings
                  </Link>
                  <button type="button" className="popover-item" onClick={() => void handleLogout()}>
                    Sign out
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        <main className="main">{children}</main>
      </div>
    </div>
  );
}
