import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useOnline } from '../lib/net';
import { useSync } from '../lib/syncContext';
import { useTheme } from '../lib/theme';
import { Icon, type IconName } from './Icon';
import { ThemeToggle } from './ThemeToggle';

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

type NavItem = {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

function SideNavLink({ item, onNavigate }: { item: NavItem; onNavigate: () => void }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) => `side-nav-link${isActive ? ' active' : ''}`}
      title={item.label}
      data-label={item.label}
      onClick={onNavigate}
    >
      <span className="side-nav-icon">
        <Icon name={item.icon} />
      </span>
      <span className="nav-label">{item.label}</span>
    </NavLink>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { profile, panels, signOut, status } = useAuth();
  const { pending, conflicts } = useSync();
  const { theme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const isAdmin = profile?.role === 'admin';

  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('gdgoc.sidebar.collapsed') === '1';
    } catch {
      return false;
    }
  });
  const [navOpen, setNavOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);

  const sidebarRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);
  const accountButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem('gdgoc.sidebar.collapsed', collapsed ? '1' : '0');
    } catch {
      return;
    }
  }, [collapsed]);

  useEffect(() => {
    setNavOpen(false);
    setAccountOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const media = window.matchMedia('(min-width: 901px)');
    const handleChange = () => {
      if (media.matches) {
        setNavOpen(false);
        setAccountOpen(false);
      }
    };
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    if (!navOpen) return;
    document.body.classList.add('sidebar-open');
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 20);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setNavOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        sidebarRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.classList.remove('sidebar-open');
      document.removeEventListener('keydown', handleKeyDown);
      window.clearTimeout(focusTimer);
      if (window.matchMedia('(max-width: 900px)').matches) menuButtonRef.current?.focus();
    };
  }, [navOpen]);

  useEffect(() => {
    if (!accountOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!accountRef.current?.contains(event.target as Node)) setAccountOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setAccountOpen(false);
        accountButtonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [accountOpen]);

  const handleLogout = async () => {
    if (
      (pending > 0 || conflicts > 0) &&
      !window.confirm(
        'You have evaluations that are not synchronized. Logging out on this device will clear local data, including queued evaluations. Continue?',
      )
    ) {
      return;
    }
    setAccountOpen(false);
    await signOut();
    navigate('/login');
  };

  const closeNavigation = () => {
    setNavOpen(false);
    setAccountOpen(false);
  };

  const roleLabel = isAdmin ? 'Administrator' : 'Interviewer';
  const panelLabel = !isAdmin && panels.length > 0 ? `${panels.length} panel${panels.length === 1 ? '' : 's'}` : null;
  const sessionLabel = status === 'offline' ? 'Offline session' : null;
  const accountMeta = [roleLabel, panelLabel, sessionLabel].filter(Boolean).join(' · ');
  const accountTitle = `${profile?.full_name ?? 'Account'} — ${accountMeta}`;

  const groups: NavGroup[] = isAdmin
    ? [
        {
          label: 'Workspace',
          items: [
            { to: '/', label: 'Overview', icon: 'home', end: true },
            { to: '/admin/candidates', label: 'Candidates', icon: 'users' },
            { to: '/admin/results', label: 'Results & evaluations', icon: 'clipboard' },
          ],
        },
        {
          label: 'Management',
          items: [
            { to: '/admin/judges', label: 'Interviewers', icon: 'user-check' },
            { to: '/admin/panels', label: 'Panels & codes', icon: 'panels' },
            { to: '/admin/rounds', label: 'Rounds & criteria', icon: 'layers' },
            { to: '/admin/verticals', label: 'Verticals', icon: 'briefcase' },
          ],
        },
        {
          label: 'Insights',
          items: [{ to: '/admin/reports', label: 'Reports & sheets', icon: 'chart' }],
        },
        {
          label: 'This device',
          items: [
            { to: '/offline', label: 'Offline access', icon: 'cloud-off' },
            { to: '/sync', label: 'Sync status', icon: 'sync' },
          ],
        },
      ]
    : [
        {
          label: 'Workspace',
          items: [
            { to: '/', label: 'Overview', icon: 'home', end: true },
            { to: '/candidates', label: 'My candidates', icon: 'users' },
            { to: '/my-evaluations', label: 'My evaluations', icon: 'clipboard' },
            ...(panels.length === 0
              ? [{ to: '/verify', label: 'Verify panel', icon: 'shield-check' as IconName }]
              : []),
          ],
        },
        {
          label: 'This device',
          items: [
            { to: '/offline', label: 'Offline access', icon: 'cloud-off' },
            { to: '/sync', label: 'Sync status', icon: 'sync' },
          ],
        },
      ];

  return (
    <div className={`layout${collapsed ? ' is-collapsed' : ''}${navOpen ? ' nav-open' : ''}`}>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>

      <aside id="app-sidebar" ref={sidebarRef} className="app-sidebar" aria-label="Primary navigation">
        <div className="sidebar-head">
          <Link to="/" className="sidebar-brand" aria-label="GDG On Campus IET DAVV — Overview" onClick={closeNavigation}>
            <img
              className="brand-full"
              src={theme === 'dark' ? '/gdg-logo-dark.png' : '/gdg-logo.png'}
              alt="Google Developer Group IET DAVV"
            />
            <img className="brand-mark-img" src="/gdg-mark.png" alt="" />
            <span className="brand-caption">Recruitment 2026</span>
          </Link>
          <button
            type="button"
            className="sidebar-collapse"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <Icon name="chevron-left" size={18} />
          </button>
          <button
            ref={closeButtonRef}
            type="button"
            className="sidebar-close"
            onClick={() => setNavOpen(false)}
            aria-label="Close navigation"
          >
            <Icon name="close" size={20} />
          </button>
        </div>

        <div className="sidebar-scroll">
          <nav className="side-nav" aria-label="Sections">
            {groups.map((group) => (
              <div className="nav-group" key={group.label}>
                <p className="nav-section-label">{group.label}</p>
                {group.items.map((item) => (
                  <SideNavLink key={item.to} item={item} onNavigate={closeNavigation} />
                ))}
              </div>
            ))}
          </nav>
        </div>

        <div className="sidebar-footer">
          <div className="sidebar-status" aria-label="Connection and synchronization status">
            <span className="sidebar-status-label">Workspace status</span>
            <div className="sidebar-status-badges">
              <NetSyncIndicators />
            </div>
          </div>

          <div className="sidebar-tools">
            <ThemeToggle />
            <span className="sidebar-tools-label">Appearance</span>
          </div>

          <div className="sidebar-account" ref={accountRef}>
            {accountOpen && (
              <div className="account-popover" role="menu" aria-label="Account actions">
                <div className="account-popover-head">
                  <span className="avatar" aria-hidden="true">
                    {profile?.full_name?.trim().charAt(0).toUpperCase() || 'A'}
                  </span>
                  <span>
                    <strong>{profile?.full_name ?? 'Account'}</strong>
                    <span className="account-popover-meta">{accountMeta}</span>
                  </span>
                </div>
                <button type="button" className="account-action" role="menuitem" onClick={() => void handleLogout()}>
                  <Icon name="logout" size={18} />
                  <span>Log out</span>
                </button>
              </div>
            )}
            <button
              ref={accountButtonRef}
              type="button"
              className="account-trigger"
              onClick={() => setAccountOpen((value) => !value)}
              aria-haspopup="menu"
              aria-expanded={accountOpen}
              aria-label={accountTitle}
              title={accountTitle}
            >
              <span className="avatar" aria-hidden="true">
                {profile?.full_name?.trim().charAt(0).toUpperCase() || 'A'}
              </span>
              <span className="account-copy">
                <strong>{profile?.full_name ?? 'Account'}</strong>
                <span>{accountMeta}</span>
              </span>
              <Icon name="chevron-up" size={16} className="account-chevron" />
            </button>
          </div>
        </div>
      </aside>

      <button
        type="button"
        className="sidebar-scrim"
        onClick={() => setNavOpen(false)}
        tabIndex={-1}
        aria-hidden="true"
      />

      <main className="main" id="main-content">
        <div className="workspace-inner">
          <button
            ref={menuButtonRef}
            type="button"
            className="mobile-nav-trigger"
            onClick={() => setNavOpen(true)}
            aria-controls="app-sidebar"
            aria-expanded={navOpen}
          >
            <Icon name="menu" size={19} />
            <span>Menu</span>
          </button>
          {children}
        </div>
      </main>
    </div>
  );
}
