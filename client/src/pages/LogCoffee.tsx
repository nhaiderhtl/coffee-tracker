import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../store/auth';
import { Icon } from '../components/Icon';
import {
  PastTimePicker, currentPastTime, resolvePastTime, useNow, type PastTime,
} from '../components/PastTimePicker';
import { getSkipSpacing } from '../devFlags';
import { api } from '../api/client';
import { prepareImageUpload } from '../lib/image';
import type { Coffee, CoffeeClass, CompetitionsResponse, Stats } from '../types';

type GroupSchedule = NonNullable<CompetitionsResponse['group']>;

// The civil date (YYYY-MM-DD) an instant falls on in the group's zone — the same
// day the server uses to decide whether a coffee is scored.
function civilDate(tz: string, ts: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(ts);
}

// Whether a coffee logged at `ts` lands on one of the group's off days (issue
// #18), mirroring server/src/competitions.js dayIsOff: 'paused' if inside the
// pause range, 'masked' if the weekday is switched off, else null. bit0 = Monday.
function offDayReason(s: GroupSchedule, ts: number): 'paused' | 'masked' | null {
  const d = civilDate(s.timezone, ts);
  if (s.pause_from && s.pause_to && d >= s.pause_from && d <= s.pause_to) return 'paused';
  const dow = new Date(`${d}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const mondayIdx = (dow + 6) % 7;
  if (!(s.active_weekdays & (1 << mondayIdx))) return 'masked';
  return null;
}

export function LogCoffee() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const token = useAuthStore(s => s.token);

  const {
    data: coffees = [], isPending: menuPending, isError: menuFailed, refetch: refetchMenu,
  } = useQuery<Coffee[]>({
    queryKey: ['coffees'],
    queryFn: () => api.get<Coffee[]>('/coffees'),
    staleTime: Infinity,
  });

  // Category names and group order come from the server now (was a hardcoded
  // CLASS_LABEL). A coffee whose class somehow isn't listed still shows, grouped
  // under its raw key after the known categories.
  const { data: classes = [] } = useQuery<CoffeeClass[]>({
    queryKey: ['coffee-classes'],
    queryFn: () => api.get<CoffeeClass[]>('/coffees/classes'),
    staleTime: Infinity,
  });

  // The caller's group schedule (issue #18) so we can warn, at log time, that a
  // coffee on an off day won't count — cached from the Compete page if visited.
  const { data: comp } = useQuery<CompetitionsResponse>({
    queryKey: ['competitions'],
    queryFn: () => api.get<CompetitionsResponse>('/competitions'),
    staleTime: 60_000,
  });

  // Which drinks the user has already had, so the menu can show what is still
  // unexplored (issue #85). Several achievements and badges count unique types,
  // and without this the menu gives no clue which ones are left. `by_type` is
  // already keyed by coffee id and counted server-side — no new endpoint.
  const { data: stats } = useQuery<Stats>({
    queryKey: ['stats'],
    queryFn: () => api.get<Stats>('/coffees/stats'),
  });
  const tried = stats?.by_type ?? {};
  const triedCount = coffees.filter(c => (tried[c.id] ?? 0) > 0).length;

  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  // What the user typed into the picker. The timestamp is derived from it on
  // every render rather than stored, so there is no second copy to fall out of
  // date — and `now` ticks, so a value can leave the 24h window on its own.
  const [pastTime, setPastTime] = useState<PastTime>(currentPastTime);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Two inputs, not one. A single `accept="image/*"` input hands the choice to
  // the platform, and on Android 13+ that means the system photo picker, which
  // has no camera at all — the shot-a-fresh-photo path just disappears. Asking
  // for each source explicitly is the only way to keep both reachable.
  const galleryRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  // Mirrors photoPreview so the URL can be revoked without reading state.
  const previewRef = useRef<string | null>(null);

  const now = useNow(30_000);
  const resolvedTime = resolvePastTime(pastTime, now);

  // A public coffee landing on the group's off day scores nothing — shown the
  // same way as the private-log warning. Private logs already carry their own
  // not-counted note, so this only fires for public ones.
  const offReason = comp?.group && resolvedTime.timestamp !== null
    ? offDayReason(comp.group, resolvedTime.timestamp) : null;

  // A *public* post must carry a photo or a description — mirrors the server's
  // POST /coffees/entries rule. A private entry needs only the coffee type.
  // Keep every label/hint here in sync with that rule; a disabled button with
  // no explanation is a bug (see VALUES.md 0.4).
  const hasPhoto = !!photo;
  const hasDescription = description.trim().length > 0;
  const meetsContentRule = !isPublic || hasPhoto || hasDescription;

  // Object URLs are entries in the document's blob URL store, which holds a
  // strong reference to the File. Dropping the string does not free the image —
  // only revoking does, and this is an SPA, so nothing unloads the document to
  // clear the store for us. Every URL created here is revoked through this one
  // setter (and on unmount below), so the photo can be swapped freely.
  //
  // Deliberately not done inside a state updater: React may invoke an updater
  // twice, which would mint a second URL and orphan the first.
  function setPreview(next: string | null) {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = next;
    setPhotoPreview(next);
  }

  // Abandoning the form (back out, navigate away, post and redirect) must not
  // strand the last preview. Revoke straight off the ref — no state update on
  // an unmounted component.
  useEffect(() => () => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = null;
  }, []);

  function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhoto(file);
    setPreview(URL.createObjectURL(file));
  }

  // Clearing the input first is what makes re-picking work when the user
  // chooses the very same file — an unchanged value fires no change event.
  function openPicker(ref: React.RefObject<HTMLInputElement | null>) {
    if (ref.current) ref.current.value = '';
    ref.current?.click();
  }

  function removePhoto() {
    setPhoto(null);
    setPreview(null);
    // Both inputs, or the cleared one still holds a stale file.
    if (galleryRef.current) galleryRef.current.value = '';
    if (cameraRef.current) cameraRef.current.value = '';
  }

  async function handleSubmit() {
    if (!selectedId) { setError('Please select a drink.'); return; }
    if (!meetsContentRule) { setError('Public posts need a photo or a description.'); return; }
    // No future logs, nothing older than 24h — the picker flags both inline, so
    // this only catches a submit that races the window's edge. Re-resolved
    // against a fresh Date.now() rather than the render's ticking clock, since
    // that is the instant the server will judge it by.
    // (See docs/time-and-timezones.md.)
    const { timestamp } = resolvePastTime(pastTime, Date.now());
    if (timestamp === null) {
      setError('Pick a time within the last 24 hours.');
      return;
    }
    setError(null);
    setSubmitting(true);

    const fd = new FormData();
    fd.append('coffeeId', selectedId);
    fd.append('timestamp', String(timestamp));
    fd.append('is_public', isPublic ? '1' : '0');
    if (description.trim()) fd.append('description', description.trim());
    // Downscale + WebP-encode the master before upload (issue #15); the
    // original never leaves the device and the server derives the sizes.
    if (photo) fd.append('photo', await prepareImageUpload(photo));
    // Debug switch from the Profile page. Ignored unless the server itself runs
    // with DEV_OVERRIDES=1 (see server/src/routes/coffees.js).
    if (getSkipSpacing()) fd.append('skip_spacing', '1');

    try {
      const res = await fetch('/api/coffees/entries', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Something went wrong.');
        setSubmitting(false);
        return;
      }
      // A new coffee can move every derived surface (unlocks, tasks, streaks,
      // casualties, rankings, Buzz), so invalidate all of them — not just the
      // feed — to keep every page consistent with the just-logged entry.
      for (const key of ['feed', 'entries', 'stats', 'streaks', 'goals',
        'badges', 'achievements', 'casualties', 'challenges', 'rankings',
        'energy']) {
        qc.invalidateQueries({ queryKey: [key] });
      }
      navigate('/');
    } catch {
      setError('Network error. Please try again.');
      setSubmitting(false);
    }
  }

  return (
    <div className="page log-page">
      {/* `capture` is the whole reason these are separate elements: it is an
          attribute, not an argument, so one input cannot offer both sources. */}
      <input
        ref={galleryRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handlePhotoChange}
      />
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={handlePhotoChange}
      />

      <header className="log-header-bar">
        <button className="log-back-btn" onClick={() => navigate('/')} aria-label="Close"><Icon name="close" /></button>
        <h2 className="log-title">New coffee</h2>
        <span />
      </header>

      <div className="log-details-step">
        {photoPreview ? (
          <div className="log-details-thumb-wrap">
            <img className="log-details-thumb" src={photoPreview} alt="Your coffee" />
            <div className="log-thumb-actions">
              <button className="log-thumb-btn" onClick={() => openPicker(cameraRef)}>
                <Icon name="camera" size={15} /> Camera
              </button>
              <button className="log-thumb-btn" onClick={() => openPicker(galleryRef)}>
                <Icon name="gallery" size={15} /> Gallery
              </button>
              <button className="log-thumb-btn danger" onClick={removePhoto}>
                <Icon name="trash" size={15} /> Remove
              </button>
            </div>
          </div>
        ) : (
          // A photo is optional — a description-only entry is valid — but both
          // ways of adding one stay a single tap from the form.
          <div className="log-photo-actions">
            <button className="log-photo-btn" onClick={() => openPicker(cameraRef)}>
              <Icon name="camera" size={18} />
              <span>Take photo</span>
            </button>
            <button className="log-photo-btn" onClick={() => openPicker(galleryRef)}>
              <Icon name="gallery" size={18} />
              <span>Choose photo</span>
            </button>
          </div>
        )}

        <div className="log-form">
          <div className="log-drink-head">
            <div className="section-label">Drink</div>
            {coffees.length > 0 && (
              <span className="log-tried-count">{triedCount}/{coffees.length} tried</span>
            )}
          </div>
          {/* The menu is the server's now, so it can be missing. An empty grid
              under "Pick a coffee type to continue" is a dead end that blames
              the user for a failed fetch — say what happened and offer a retry. */}
          {menuPending ? (
            <div className="log-menu-note">Loading the coffee menu…</div>
          ) : menuFailed || coffees.length === 0 ? (
            <div className="log-requirement-hint">
              Couldn’t load the coffee menu.{' '}
              <button className="log-menu-retry" onClick={() => refetchMenu()}>Try again</button>
            </div>
          ) : (
            <div className="coffee-classes">
              {(() => {
                // Render categories in the server's order first, then any class a
                // coffee uses that isn't a known category (shouldn't happen, but
                // never hide a drink because its category was removed).
                const present = [...new Set(coffees.map(c => c.class))];
                const known = classes.map(c => c.id).filter(id => present.includes(id));
                const orphan = present.filter(id => !classes.some(c => c.id === id));
                const ordered = [...known, ...orphan];
                const labelOf = (id: string) => classes.find(c => c.id === id)?.name ?? id;
                return ordered.map(cls => (
                <div className="coffee-class" key={cls}>
                  <div className="coffee-class-label">{labelOf(cls)}</div>
                  <div className="coffee-grid">
                    {coffees.filter(c => c.class === cls).map(c => {
                      const isTried = (tried[c.id] ?? 0) > 0;
                      return (
                        <button
                          key={c.id}
                          className={`coffee-btn${isTried ? ' tried' : ''}${selectedId === c.id ? ' selected' : ''}`}
                          onClick={() => setSelectedId(c.id)}
                          title={isTried ? `${c.name} — already tried` : `${c.name} — not tried yet`}
                        >
                          {/* Colour alone would not survive a colour-vision
                              deficiency, so the state carries a glyph too. */}
                          {isTried && <span className="cb-tried" aria-hidden="true"><Icon name="check" size={9} /></span>}
                          <span className="cb-icon"><Icon name={c.icon} size={24} /></span>
                          <span className="cb-name">{c.name}</span>
                          <span className="cb-mg">{c.caffeine}mg</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                ));
              })()}
            </div>
          )}

          <div className="field" style={{ marginTop: 16 }}>
            <label>Time</label>
            <PastTimePicker
              value={pastTime}
              resolved={resolvedTime}
              now={now}
              onChange={setPastTime}
            />
          </div>

          <div className="field">
            <label>
              Description{' '}
              <span className="field-hint">
                {hasPhoto || !isPublic ? '(optional)' : '(required unless you add a photo)'}
              </span>
            </label>
            <textarea
              className="log-textarea"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What made this coffee special?"
              rows={2}
              maxLength={280}
            />
          </div>

          <div className="log-share-row">
            <div>
              <div className="log-share-label">Share with everyone</div>
              <div className="log-share-sub">Visible in the public feed</div>
            </div>
            <button
              className={`log-toggle${isPublic ? ' on' : ''}`}
              onClick={() => setIsPublic(v => !v)}
              aria-pressed={isPublic}
            >
              <span className="log-toggle-knob" />
            </button>
          </div>

          {/* Only public entries are scored in a competition (VALUES 7 of
              docs/competitions-rating-v2.md), so a private log is worth zero
              rating points. The user has to be able to see that at the moment
              they log it, not discover it when a match settles. Shown only in
              the non-public state — the same line under a public entry would
              just be noise. Styled as a warning, like the public content rule
              below it, because it is the same class of "this won't do what you
              expect" notice. */}
          {!isPublic && (
            <div className="log-requirement-hint">Private logs don’t count toward rating.</div>
          )}
          {/* Off day (issue #18): a public coffee on a paused or switched-off day
              is not scored, just like a private one. Same warning styling. */}
          {isPublic && offReason && (
            <div className="log-requirement-hint">
              {offReason === 'paused' ? 'Paused day — won’t count toward rating.'
                : 'Day off — won’t count toward rating.'}
            </div>
          )}

          {error && <div className="auth-error">{error}</div>}

          {/* Only ask for a pick when there is something to pick from — with no
              menu the block above already explains why. */}
          {!selectedId && coffees.length > 0 && (
            <div className="log-requirement-hint">Pick a drink to continue.</div>
          )}
          {selectedId && !meetsContentRule && (
            <div className="log-requirement-hint">Add a photo or write a description to post publicly.</div>
          )}

          <button className="btn-primary" onClick={handleSubmit} disabled={submitting || !selectedId || !meetsContentRule || resolvedTime.timestamp === null}>
            {submitting ? 'Posting…' : 'Post coffee'}
          </button>
        </div>
      </div>
    </div>
  );
}
