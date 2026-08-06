import { Link, useNavigate } from 'react-router-dom';
import { useThemeStore } from '../store/theme';
import { useNotifications } from '../hooks/useNotifications';
import { AppLogo } from './AppLogo';
import { Icon } from './Icon';

// Single app header shared by every main page so the top bar looks identical
// everywhere: brand on the left, actions on the right. Profile lives in the
// bottom nav. The bell lives here so it is global with no per-page wiring —
// AppHeader renders on every main page (issue #32). The brand is a Link to the
// feed (issue #79) — a real <a> rather than an onClick so middle-click and
// open-in-new-tab behave like any other link.
export function AppHeader() {
  const { isDark, toggleDark } = useThemeStore();
  const navigate = useNavigate();
  const { data } = useNotifications();
  const unread = data?.unread_count ?? 0;

  return (
    <header className="app-header">
      <Link to="/" className="header-brand" aria-label="Coffee Tracker home">
        <AppLogo className="logo" alt="Coffee Tracker" />
        <div>
          <h1>Coffee Tracker</h1>
          <div className="date">{new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</div>
        </div>
      </Link>
      <div className="header-actions">
        <button
          className="header-btn notif-bell"
          onClick={() => navigate('/notifications')}
          title="Notifications"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        >
          <Icon name="bell" />
          {unread > 0 && (
            <span className="notif-badge" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>
          )}
        </button>
        <a
          className="header-btn"
          href="https://github.com/JakobHuemer/coffee-tracker"
          target="_blank"
          rel="noopener noreferrer"
          title="View on GitHub"
          aria-label="View project on GitHub"
        >
          <Icon name="github" />
        </a>
        <button
          className="header-btn"
          onClick={toggleDark}
          title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-label="Toggle theme"
        >
          {isDark ? <Icon name="sun" /> : <Icon name="moon" />}
        </button>
      </div>
    </header>
  );
}
