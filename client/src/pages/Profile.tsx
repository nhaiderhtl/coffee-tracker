import { useState, useRef } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuthStore } from '../store/auth';
import { AppHeader } from '../components/AppHeader';
import { Icon } from '../components/Icon';
import { BadgeRow } from '../components/Badge';
import { ProfileCard } from '../components/ProfileCard';
import { BuzzWidget } from '../components/BuzzWidget';
import { PhotoLightbox } from '../components/PhotoLightbox';
import { ResponsiveImage } from '../components/ResponsiveImage';
import { prepareImageUpload } from '../lib/image';
import { getSkipSpacing, setSkipSpacing } from '../devFlags';
import type { User, Badge, ImageField } from '../types';
import { byUnlockedThenRarity } from '../rarity';

interface PhotoEntry {
  id: string;
  coffee_id: string;
  logged_at: number;
  photo_url: string | null;
  image?: ImageField | null;
  description: string | null;
}

function GalleryCard() {
  const [lightbox, setLightbox] = useState<PhotoEntry | null>(null);
  const { data: photos = [], isLoading } = useQuery<PhotoEntry[]>({
    queryKey: ['my-photos'],
    queryFn: () => api.get('/coffees/photos'),
  });

  return (
    <>
      <div className="card">
        <div className="section-label">Gallery</div>
        {isLoading && <div className="gallery-loading">Loading…</div>}
        {!isLoading && photos.length === 0 && (
          <div className="profile-placeholder-body">No photos yet — snap one when you post your next coffee.</div>
        )}
        {photos.length > 0 && (
          <div className="gallery-grid">
            {photos.map(p => (
              <button key={p.id} className="gallery-thumb" onClick={() => setLightbox(p)} aria-label={p.coffee_id}>
                <ResponsiveImage image={p.image} fallback={p.photo_url} alt={p.coffee_id} loading="lazy" sizes="160px" />
              </button>
            ))}
          </div>
        )}
      </div>

      {lightbox && (
        <PhotoLightbox
          image={lightbox.image}
          fallback={lightbox.photo_url}
          alt={lightbox.coffee_id}
          onClose={() => setLightbox(null)}
        >
          <div className="gallery-lightbox-meta">
            <span className="gallery-lightbox-coffee">{lightbox.coffee_id.replace(/_/g, ' ')}</span>
            <span className="gallery-lightbox-date">{new Date(lightbox.logged_at).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })}</span>
          </div>
          {lightbox.description && <p className="gallery-lightbox-desc">{lightbox.description}</p>}
        </PhotoLightbox>
      )}
    </>
  );
}

// Debug switches, rendered only when the server actually honours them (it must
// run with DEV_OVERRIDES=1). On a normal production server this card does not
// exist, so there is never a toggle here that quietly does nothing.
function DebugCard() {
  const { data } = useQuery<{ spacing_override: boolean }>({
    queryKey: ['dev-flags'],
    queryFn: () => api.get('/coffees/dev-flags'),
    staleTime: Infinity,
  });
  const [skipSpacing, setSkipSpacingState] = useState(getSkipSpacing);

  if (!data?.spacing_override) return null;

  function toggle() {
    const next = !skipSpacing;
    setSkipSpacing(next);
    setSkipSpacingState(next);
  }

  return (
    <div className="card">
      <div className="section-label">Debug</div>
      <div className="log-share-row">
        <div>
          <div className="log-share-label">Ignore the 5-minute spacing rule</div>
          <div className="log-share-sub">
            Log coffees closer than 5 minutes apart. Dev servers only — stored in this browser.
          </div>
        </div>
        <button
          className={`log-toggle${skipSpacing ? ' on' : ''}`}
          onClick={toggle}
          aria-pressed={skipSpacing}
          aria-label="Ignore the 5-minute spacing rule"
        >
          <span className="log-toggle-knob" />
        </button>
      </div>
    </div>
  );
}

function ChangePasswordCard() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const mutation = useMutation({
    mutationFn: (body: { currentPassword: string; password: string }) => api.patch('/auth/me', body),
    onSuccess: () => {
      setSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirm('');
      setTimeout(() => setSuccess(false), 3000);
    },
    onError: (e: Error) => setError(e.message),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSuccess(false);
    if (currentPassword.length === 0) { setError('Enter your current password.'); return; }
    if (newPassword.length === 0) { setError('Password cannot be empty.'); return; }
    if (newPassword !== confirm) { setError('Passwords do not match.'); return; }
    mutation.mutate({ currentPassword, password: newPassword });
  }

  return (
    <div className="card">
      <div className="section-label">Change Password</div>
      <form onSubmit={handleSubmit} className="create-form">
        <div className="field">
          <label>Current password</label>
          <input
            type="password"
            value={currentPassword}
            onChange={e => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
            placeholder="Current password"
          />
        </div>
        <div className="field">
          <label>New password</label>
          <input
            type="password"
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            autoComplete="new-password"
            placeholder="New password"
          />
        </div>
        <div className="field">
          <label>Confirm new password</label>
          <input
            type="password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            autoComplete="new-password"
            placeholder="Repeat new password"
          />
        </div>
        {error && <div className="auth-error">{error}</div>}
        {success && <div className="pw-success">Password updated successfully.</div>}
        <button type="submit" className="btn-primary" disabled={mutation.isPending}>
          {mutation.isPending ? 'Saving…' : 'Reset password'}
        </button>
      </form>
    </div>
  );
}


function DeleteAccountSection({ onDeleted }: { onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: () => api.delete('/auth/me'),
    onSuccess: onDeleted,
    onError: (e: Error) => setError(e.message),
  });

  if (!confirming) {
    return (
      <button className="btn-danger" style={{ marginTop: 8 }} onClick={() => setConfirming(true)}>
        Delete Account
      </button>
    );
  }

  return (
    <div className="delete-confirm">
      <p className="delete-confirm-msg">This will permanently delete your account and all your data. This cannot be undone.</p>
      {error && <div className="auth-error">{error}</div>}
      <div className="delete-confirm-actions">
        <button className="btn-danger" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
          {mutation.isPending ? 'Deleting…' : 'Yes, delete my account'}
        </button>
        <button className="btn-secondary" onClick={() => { setConfirming(false); setError(''); }}>Cancel</button>
      </div>
    </div>
  );
}

const AVATARS = ['☕', '🥛', '🧋', '🍫', '🍨', '🍵', '⚡', '🔥', '💀', '🏆', '🎯', '👑', '🤖', '👍', '😎', '🐸', '🦊', '🐼', '🚀', '🌟'];

export function Profile() {
  const { user, setAuth, logout } = useAuthStore();
  const navigate = useNavigate();
  const [editMode, setEditMode] = useState(false);
  const [newUsername, setNewUsername] = useState(user?.username || '');
  const [selectedAvatar, setSelectedAvatar] = useState(user?.avatar || '☕');
  const [error, setError] = useState('');
  const [photoError, setPhotoError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: badges = [] } = useQuery<Badge[]>({ queryKey: ['badges'], queryFn: () => api.get('/badges') });
  // Every badge you have earned, rarest first — shown in full on your profile.
  // There is no picking a subset; unlock it and it shows.
  const earnedBadges = badges.filter(b => b.unlocked).sort(byUnlockedThenRarity);

  const updateMutation = useMutation({
    mutationFn: (body: { username?: string; avatar?: string }) =>
      api.patch<User>('/auth/me', body),
    onSuccess: (updated) => {
      setAuth(updated, localStorage.getItem('token')!);
      setEditMode(false);
    },
    onError: (e: Error) => setError(e.message),
  });

  const photoMutation = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      // Downscale + WebP-encode before upload (issue #15) — the original never
      // leaves the device.
      form.append('photo', await prepareImageUpload(file));
      return api.patchForm<User>('/auth/me/photo', form);
    },
    onSuccess: (updated) => {
      setAuth(updated, localStorage.getItem('token')!);
      setPhotoError('');
    },
    onError: (e: Error) => setPhotoError(e.message),
  });

  const removePhotoMutation = useMutation({
    mutationFn: () => api.delete<User>('/auth/me/photo'),
    onSuccess: (updated) => {
      setAuth(updated, localStorage.getItem('token')!);
      setPhotoError('');
    },
    onError: (e: Error) => setPhotoError(e.message),
  });

  function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) photoMutation.mutate(file);
    e.target.value = '';
  }

  function handleSave() {
    setError('');
    const body: { username?: string; avatar?: string } = {};
    if (newUsername !== user?.username) body.username = newUsername;
    if (selectedAvatar !== user?.avatar) body.avatar = selectedAvatar;
    if (Object.keys(body).length === 0) { setEditMode(false); return; }
    updateMutation.mutate(body);
  }

  // Seed the edit form from the live user each time editing opens, so the form
  // never shows stale values — an async-loaded user, or an edit abandoned via
  // Cancel, would otherwise leave the fields diverged from the displayed data.
  function startEdit() {
    setNewUsername(user?.username ?? '');
    setSelectedAvatar(user?.avatar ?? '☕');
    setError('');
    setEditMode(true);
  }

  // Own-profile avatar slot: the photo with its change/remove controls. Shared
  // by the view card and the edit form.
  const photoArea = (
    <div className="profile-photo-area">
      <div className="profile-avatar-wrap">
        {user?.profile_image || user?.profile_photo_url
          ? <ResponsiveImage image={user.profile_image} fallback={user.profile_photo_url} alt="Profile" className="profile-avatar-img" sizes="96px" />
          : <div className="profile-avatar">{user?.avatar}</div>}
        <button
          className="profile-avatar-upload-btn"
          onClick={() => fileInputRef.current?.click()}
          title="Change photo"
          disabled={photoMutation.isPending}
          aria-label="Change photo"
        ><Icon name="camera" /></button>
        <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handlePhotoChange} />
      </div>
      {(user?.profile_image || user?.profile_photo_url) && (
        <button
          className="profile-remove-photo"
          onClick={() => removePhotoMutation.mutate()}
          disabled={removePhotoMutation.isPending}
        >{removePhotoMutation.isPending ? 'Removing…' : 'Remove photo'}</button>
      )}
      {photoError && <div className="auth-error" style={{ fontSize: '0.75rem', marginTop: 2 }}>{photoError}</div>}
    </div>
  );

  return (
    <div className="page">
      <AppHeader />
      {/* No "Profile / Your account" title — the card is obviously your profile,
          same call as the public profile page. */}
      <main>
        {/* The avatar-with-upload is the own-profile's custom avatar slot, reused
            in both the view card and the edit form. */}
        {editMode ? (
          <div className="card profile-card">
            <div className="profile-card-body">
              {photoArea}
              <div className="edit-section">
                <div className="avatar-picker">
                  {AVATARS.map(a => (
                    <button key={a} className={`avatar-opt${selectedAvatar === a ? ' selected' : ''}`} onClick={() => setSelectedAvatar(a)}>
                      {a}
                    </button>
                  ))}
                </div>

                <div className="field" style={{ marginTop: 12 }}>
                  <label>Username</label>
                  <input value={newUsername} onChange={e => setNewUsername(e.target.value)} />
                </div>

                {error && <div className="auth-error">{error}</div>}
                <div className="edit-actions">
                  <button className="btn-primary" onClick={handleSave} disabled={updateMutation.isPending}>Save</button>
                  <button className="btn-secondary" onClick={() => setEditMode(false)}>Cancel</button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <ProfileCard
            avatar={photoArea}
            name={user?.username}
            badges={earnedBadges.length > 0
              ? <BadgeRow badges={earnedBadges} size={34} className="profile-head-badges" withInfo />
              : undefined}
            meta={<>Member since {user ? new Date(user.created_at).toLocaleDateString() : '—'}</>}
            actions={<button className="btn-secondary" onClick={startEdit}>Edit Profile</button>}
          />
        )}

        <BuzzWidget />

        {/* Stats gave up its bottom-nav slot to Compete; like Saved posts, it
            is reached from here now. */}
        <button className="card profile-link-card" onClick={() => navigate('/stats')}>
          <span className="profile-link-icon"><Icon name="chart" size={18} /></span>
          <span className="profile-link-label">Stats</span>
          <Icon name="arrow-right" size={14} />
        </button>

        {/* Badges and Milestones left the Stats tab bar and are their own pages
            reached from here now (issue #51). */}
        <button className="card profile-link-card" onClick={() => navigate('/badges')}>
          <span className="profile-link-icon"><Icon name="medal" size={18} /></span>
          <span className="profile-link-label">Badges</span>
          <Icon name="arrow-right" size={14} />
        </button>

        <button className="card profile-link-card" onClick={() => navigate('/milestones')}>
          <span className="profile-link-icon"><Icon name="target" size={18} /></span>
          <span className="profile-link-label">Milestones</span>
          <Icon name="arrow-right" size={14} />
        </button>

        {/* Saved gave up its bottom-nav slot to "Yours"; this is now the only
            way in. */}
        <button className="card profile-link-card" onClick={() => navigate('/saved')}>
          <span className="profile-link-icon"><Icon name="bookmark-o" size={18} /></span>
          <span className="profile-link-label">Saved posts</span>
          <Icon name="arrow-right" size={14} />
        </button>

        <GalleryCard />

        <ChangePasswordCard />

        {user?.is_admin ? (
          <button className="card profile-link-card" onClick={() => navigate('/admin')}>
            <span className="profile-link-icon"><Icon name="shield" size={18} /></span>
            <span className="profile-link-label">Admin panel</span>
            <Icon name="arrow-right" size={14} />
          </button>
        ) : null}

        <DebugCard />

        <div className="card account-actions-card">
          <button className="btn-secondary" onClick={() => { logout(); navigate('/auth'); }}>Sign Out</button>
          <DeleteAccountSection onDeleted={() => { logout(); navigate('/auth'); }} />
        </div>
      </main>
    </div>
  );
}
