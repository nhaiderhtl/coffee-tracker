import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuthStore } from '../store/auth';
import { AppHeader } from '../components/AppHeader';
import { Icon } from '../components/Icon';

interface AdminUser {
  id: string;
  username: string;
  avatar: string;
  is_admin: 0 | 1;
  is_super_admin: 0 | 1;
  created_at: number;
}

function AdminActions({ u }: { u: AdminUser }) {
  const qc = useQueryClient();
  const meIsSuper = useAuthStore(s => s.user?.is_super_admin === 1);
  const [pw, setPw] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { setPw(''); setMsg(''); setError(''); }, [u.id]);

  const resetMutation = useMutation({
    mutationFn: (password: string) => api.post(`/admin/users/${u.id}/reset-password`, { password }),
    onSuccess: () => {
      setPw(''); setError(''); setMsg('Password set');
      setTimeout(() => setMsg(''), 3000);
    },
    onError: (e: Error) => { setMsg(''); setError(e.message); },
  });

  const adminMutation = useMutation({
    mutationFn: (is_admin: boolean) => api.post(`/admin/users/${u.id}/admin`, { is_admin }),
    onSuccess: () => { setError(''); qc.invalidateQueries({ queryKey: ['admin-user', u.username] }); },
    onError: (e: Error) => setError(e.message),
  });

  function submitReset(e: React.FormEvent) {
    e.preventDefault();
    if (pw.length === 0) { setError('Enter a new password.'); return; }
    resetMutation.mutate(pw);
  }

  const targetIsSuper = u.is_super_admin === 1;
  const targetIsAdmin = u.is_admin === 1;
  const canManage = !targetIsSuper && (targetIsAdmin ? meIsSuper : true);

  return (
    <div className="card">
      <div className="admin-user-head">
        <div className="admin-user-id">
          <span className="admin-user-avatar">{u.avatar}</span>
          <span className="admin-user-name">{u.username}</span>
          {targetIsSuper
            ? <span className="admin-tag">Primary admin</span>
            : targetIsAdmin ? <span className="admin-tag">Admin</span> : null}
        </div>
        {canManage && (
          <button
            className="btn-secondary"
            onClick={() => adminMutation.mutate(!u.is_admin)}
            disabled={adminMutation.isPending}
          >
            {targetIsAdmin ? 'Remove admin' : 'Make admin'}
          </button>
        )}
      </div>

      {canManage ? (
        <>
          <div className="section-label" style={{ marginTop: 16 }}>Reset password</div>
          <form onSubmit={submitReset} className="search-row">
            <input
              type="text"
              className="search-input"
              value={pw}
              onChange={e => setPw(e.target.value)}
              placeholder="New password"
              autoComplete="off"
            />
            <button type="submit" className="btn-primary" style={{ flexShrink: 0, width: 'auto' }} disabled={resetMutation.isPending}>
              {resetMutation.isPending ? 'Setting…' : 'Set'}
            </button>
          </form>
        </>
      ) : (
        <div className="empty-state" style={{ marginTop: 12, textAlign: 'left' }}>
          {targetIsSuper ? 'Protected admin — cannot be modified.' : 'Only the primary admin can manage other admins.'}
        </div>
      )}
      {msg && <div className="pw-success" style={{ marginTop: 8 }}>{msg}</div>}
      {error && <div className="auth-error" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}

function UserManagementSection() {
  const [searchInput, setSearchInput] = useState('');
  const [activeUsername, setActiveUsername] = useState('');

  const { data, isLoading, error } = useQuery<AdminUser>({
    queryKey: ['admin-user', activeUsername],
    queryFn: () => api.get<AdminUser>(`/admin/users/${activeUsername}`),
    enabled: !!activeUsername,
    retry: false,
  });

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = searchInput.trim();
    if (q) setActiveUsername(q);
  }

  return (
    <>
      <div className="card">
        <div className="section-label">User management</div>
        <form onSubmit={handleSearch} className="search-row">
          <input
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder="Find a user by username…"
            className="search-input"
          />
          <button type="submit" className="btn-primary" style={{ flexShrink: 0, width: 'auto' }}>Find</button>
        </form>
      </div>

      {isLoading && <div className="page-loading">Searching…</div>}
      {error && <div className="card error-card">{(error as Error).message}</div>}
      {data && <AdminActions u={data} />}
    </>
  );
}

export function AdminPanel() {
  const user = useAuthStore(s => s.user);
  const navigate = useNavigate();

  useEffect(() => {
    if (user && !user.is_admin) navigate('/profile', { replace: true });
  }, [user, navigate]);

  if (!user || !user.is_admin) return null;

  return (
    <div className="page">
      <AppHeader />
      <div className="page-header">
        <h2>Admin panel</h2>
      </div>
      <main className="page-content">
        <div className="card">
          <div className="section-label">Catalog</div>
          <button className="card profile-link-card" style={{ marginTop: 8 }} onClick={() => navigate('/admin/coffees')}>
            <span className="profile-link-icon"><Icon name="coffee" size={18} /></span>
            <span className="profile-link-label">Coffee catalog</span>
            <Icon name="arrow-right" size={14} />
          </button>
        </div>

        <UserManagementSection />
      </main>
    </div>
  );
}
