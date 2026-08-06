import { useEffect, type JSX } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from './api/client';
import { useAuthStore } from './store/auth';
import { useSSE } from './hooks/useSSE';
// Animated caffeine background disabled for now — kept in the tree for later.
// import { BgCanvas } from './components/BgCanvas';
import { BottomNav } from './components/BottomNav';
import { Auth } from './pages/Auth';
import { Feed } from './pages/Feed';
import { Saved } from './pages/Saved';
import { MyPosts } from './pages/MyPosts';
import { LogCoffee } from './pages/LogCoffee';
import { Stats } from './pages/Stats';
import { Badges } from './pages/Badges';
import { Milestones } from './pages/Milestones';
import { Challenges } from './pages/Challenges';
import { Compete } from './pages/Compete';
import { Compare } from './pages/Compare';
import { Profile } from './pages/Profile';
import { UserProfile } from './pages/UserProfile';
import { AdminCoffees } from './pages/AdminCoffees';
import { AdminMatches } from './pages/AdminMatches';
import { AdminPanel } from './pages/AdminPanel';
import { Notifications } from './pages/Notifications';
import { NotificationToaster } from './components/NotificationToaster';
import { RevealProvider } from './notifications/RevealProvider';
import type { User } from './types';

function RequireAuth({ children }: { children: JSX.Element }) {
  const token = useAuthStore(s => s.token);
  if (!token) return <Navigate to="/auth" replace />;
  return children;
}

export function App() {
  const token = useAuthStore(s => s.token);
  const user = useAuthStore(s => s.user);
  const setAuth = useAuthStore(s => s.setAuth);
  const logout = useAuthStore(s => s.logout);
  const location = useLocation();

  const { data: meData, isError: meError } = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<User>('/auth/me'),
    enabled: !!token && !user,
    retry: false,
  });

  // Adopt the fetched user; on any failure (invalid/expired token, deleted user)
  // clear the session so the app can't render half-logged-in. RequireAuth then
  // redirects to /auth.
  useEffect(() => {
    if (meData && token) setAuth(meData, token);
  }, [meData, token, setAuth]);
  useEffect(() => {
    if (meError) logout(); // logout() clears the query cache itself.
  }, [meError, logout]);

  // Keep the stored IANA timezone in sync with the current browser zone (the
  // user may have travelled). Fire-and-forget on the next interaction; the
  // server evaluates civil-time logic in this zone. See docs/time-and-timezones.md.
  useEffect(() => {
    if (!user || !token) return;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && user.timezone && user.timezone !== tz) {
      api.patch<User>('/auth/me', { timezone: tz }).then(u => setAuth(u, token)).catch(() => {});
    }
  }, [user, token, setAuth]);

  useSSE();

  const isAuth = location.pathname === '/auth';

  return (
    <RevealProvider active={!!token && !isAuth}>
      {/* Animated caffeine background disabled for now — see BgCanvas. */}
      <div id="app-wrap">
        <Routes>
          <Route path="/auth" element={<Auth />} />
          <Route path="/" element={<RequireAuth><Feed /></RequireAuth>} />
          <Route path="/mine" element={<RequireAuth><MyPosts /></RequireAuth>} />
          {/* Saved lost its nav slot to /mine and now lives under Profile. */}
          <Route path="/saved" element={<RequireAuth><Saved /></RequireAuth>} />
          <Route path="/log" element={<RequireAuth><LogCoffee /></RequireAuth>} />
          {/* Stats lost its bottom-nav slot to Compete; Profile links here. */}
          <Route path="/stats" element={<RequireAuth><Stats /></RequireAuth>} />
          {/* Badges and Milestones left the Stats tab bar for their own pages,
              reached from Profile (issue #51). */}
          <Route path="/badges" element={<RequireAuth><Badges /></RequireAuth>} />
          <Route path="/milestones" element={<RequireAuth><Milestones /></RequireAuth>} />
          {/* Community challenges are cooperative, not competitive — they left
              Compete for their own page again (issue #63). */}
          <Route path="/challenges" element={<RequireAuth><Challenges /></RequireAuth>} />
          {/* Scope + section live in the path (/compete/group/ranking) so a
              refresh or shared link lands on the same tab. Bare /compete
              canonicalises to the resolved default once data loads. */}
          <Route path="/compete" element={<RequireAuth><Compete /></RequireAuth>} />
          <Route path="/compete/:scope" element={<RequireAuth><Compete /></RequireAuth>} />
          <Route path="/compete/:scope/:section" element={<RequireAuth><Compete /></RequireAuth>} />
          <Route path="/compare" element={<RequireAuth><Compare /></RequireAuth>} />
          <Route path="/compare/:username" element={<RequireAuth><Compare /></RequireAuth>} />
          <Route path="/profile" element={<RequireAuth><Profile /></RequireAuth>} />
          {/* Public profile of any user (issue #73), reached from their name /
              avatar anywhere. Compare folds in inline here. */}
          <Route path="/u/:username" element={<RequireAuth><UserProfile /></RequireAuth>} />
          {/* /compare/:username still resolves for old links, but every in-app
              path to another user now lands on their profile first. */}
          {/* Admin panel (issue #68). AdminPanel and AdminCoffees both redirect
              non-admins; the API enforces admin on every write regardless. */}
          <Route path="/admin" element={<RequireAuth><AdminPanel /></RequireAuth>} />
          <Route path="/admin/coffees" element={<RequireAuth><AdminCoffees /></RequireAuth>} />
          {/* Admin match review + invalidation (super-admin only). AdminMatches
              redirects non-super-admins; the API enforces super-admin on the
              invalidate write regardless. */}
          <Route path="/admin/matches" element={<RequireAuth><AdminMatches /></RequireAuth>} />
          <Route path="/notifications" element={<RequireAuth><Notifications /></RequireAuth>} />
          <Route path="/goals" element={<Navigate to="/stats" replace />} />
          <Route path="/achievements" element={<Navigate to="/badges" replace />} />
          <Route path="/rankings" element={<Navigate to="/stats" replace />} />
          {/* The stale Compete tab path, kept so old links still land on the
              challenges (issue #63 moved them back out of Compete). */}
          <Route path="/compete/global/challenges" element={<Navigate to="/challenges" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        {token && !isAuth && <BottomNav />}
      </div>
      {token && !isAuth && <NotificationToaster />}
    </RevealProvider>
  );
}

export default App;
