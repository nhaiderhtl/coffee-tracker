import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuthStore } from '../store/auth';
import { AppHeader } from '../components/AppHeader';
import { Icon, ICON_KEYS } from '../components/Icon';
import { SuggestInput } from '../components/SuggestInput';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Modal } from '../components/Modal';
import type { AdminCoffee, CoffeeClass } from '../types';

const BLANK = { id: '', name: '', caffeine: '', icon: 'coffee', class: '', score_caffeine: '' };
type FormState = typeof BLANK;

function toForm(c: AdminCoffee): FormState {
  return {
    id: c.id,
    name: c.name,
    caffeine: String(c.caffeine),
    icon: c.icon,
    class: c.class,
    score_caffeine: c.score_caffeine == null ? '' : String(c.score_caffeine),
  };
}

// Add or edit a single coffee, shown inside a Modal. `editing` holds the row
// being edited, or null for a new one — the id is only editable when creating
// (it's the primary key and is embedded in logged entries, so the server rejects
// a rename). `classes` feeds the category picker; a coffee must sit in one of
// them (server enforces it too). `defaultClass` seeds a new coffee's category.
function CoffeeForm({ editing, classes, defaultClass, onDone }: {
  editing: AdminCoffee | null;
  classes: CoffeeClass[];
  defaultClass: string;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>(
    editing ? toForm(editing) : { ...BLANK, class: defaultClass },
  );
  const [error, setError] = useState('');

  const set = (k: keyof FormState) => (v: string) => setForm(f => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name.trim(),
        caffeine: Number(form.caffeine),
        icon: form.icon.trim(),
        class: form.class,
        // Empty → null clears the competition override server-side.
        score_caffeine: form.score_caffeine === '' ? null : Number(form.score_caffeine),
      };
      return editing
        ? api.patch(`/admin/coffees/${editing.id}`, body)
        : api.post('/admin/coffees', { id: form.id.trim(), ...body });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-coffees'] });
      qc.invalidateQueries({ queryKey: ['coffees'] });
      onDone();
    },
    onError: (e: Error) => setError(e.message),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing && !/^[a-z0-9_]+$/.test(form.id.trim())) {
      setError('id must be lowercase letters, numbers and underscores');
      return;
    }
    if (!form.name.trim()) { setError('Name is required'); return; }
    if (!Number.isInteger(Number(form.caffeine)) || Number(form.caffeine) < 0) {
      setError('Caffeine must be a non-negative whole number');
      return;
    }
    if (!form.class) { setError('Pick a category'); return; }
    save.mutate();
  }

  return (
    <form className="admin-coffee-form" onSubmit={submit}>
      {!editing && (
        <label className="admin-field">
          <span>ID</span>
          <input className="search-input" value={form.id} onChange={e => set('id')(e.target.value)}
            placeholder="flat_white" autoComplete="off" spellCheck={false} autoFocus />
        </label>
      )}

      <label className="admin-field">
        <span>Name</span>
        <input className="search-input" value={form.name} onChange={e => set('name')(e.target.value)}
          placeholder="Flat White" autoComplete="off" autoFocus={!!editing} />
      </label>

      <label className="admin-field">
        <span>Caffeine (mg)</span>
        <input className="search-input" type="number" min="0" step="1" inputMode="numeric"
          value={form.caffeine} onChange={e => set('caffeine')(e.target.value)} placeholder="95" />
      </label>

      <label className="admin-field">
        <span>Icon</span>
        <div className="admin-field-with-preview">
          <SuggestInput value={form.icon} onChange={set('icon')} options={ICON_KEYS} placeholder="coffee" />
          <Icon name={form.icon} size={20} />
        </div>
      </label>

      <label className="admin-field">
        <span>Category</span>
        <select className="search-input" value={form.class} onChange={e => set('class')(e.target.value)}>
          {!form.class && <option value="" disabled>Select a category…</option>}
          {classes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>

      <label className="admin-field">
        <span>Competition score (mg)</span>
        <input className="search-input" type="number" min="0" step="1" inputMode="numeric"
          value={form.score_caffeine} onChange={e => set('score_caffeine')(e.target.value)}
          placeholder="Same as caffeine" />
      </label>

      {error && <div className="auth-error" style={{ marginTop: 8 }}>{error}</div>}
      <div className="confirm-actions" style={{ marginTop: 12 }}>
        <button type="submit" className="btn-primary" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : editing ? 'Save' : 'Add coffee'}
        </button>
        <button type="button" className="btn-secondary" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

function CoffeesTab({ coffees, classes, isLoading }: {
  coffees: AdminCoffee[];
  classes: CoffeeClass[];
  isLoading: boolean;
}) {
  const qc = useQueryClient();
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AdminCoffee | null>(null);
  const [deleting, setDeleting] = useState<AdminCoffee | null>(null);
  const [deleteError, setDeleteError] = useState('');

  // Group by category in category order; any coffee whose class isn't a known
  // category (shouldn't happen — creation enforces it) falls into a trailing
  // "Other" bucket so it's never hidden.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (c: AdminCoffee) => !q || c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q);
    const known = classes.map(cls => ({ id: cls.id, name: cls.name, items: coffees.filter(c => c.class === cls.id && match(c)) }));
    const orphans = coffees.filter(c => !classes.some(cls => cls.id === c.class) && match(c));
    if (orphans.length) known.push({ id: '__other__', name: 'Other', items: orphans });
    return known;
  }, [coffees, classes, query]);

  const searching = query.trim().length > 0;
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/coffees/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-coffees'] });
      qc.invalidateQueries({ queryKey: ['coffees'] });
      setDeleting(null); setDeleteError('');
    },
    onError: (e: Error) => setDeleteError(e.message),
  });

  function toggle(id: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const firstClass = classes[0]?.id ?? '';

  return (
    <>
      <div className="admin-toolbar">
        <input
          className="search-input"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={`Search ${coffees.length} drinks…`}
          autoComplete="off"
        />
        <button className="btn-primary admin-add-btn" onClick={() => { setEditing(null); setFormOpen(true); }}>
          <Icon name="plus" size={14} /> Add
        </button>
      </div>

      {isLoading && <div className="page-loading">Loading…</div>}

      <div className="card admin-acc-card">
        {groups.map(g => {
          // While searching, show only groups with hits and force them open.
          if (searching && g.items.length === 0) return null;
          const open = searching || expanded.has(g.id);
          return (
            <div className={`admin-acc${open ? ' open' : ''}`} key={g.id}>
              <button className="admin-acc-head" onClick={() => toggle(g.id)} aria-expanded={open}>
                <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} className="admin-acc-chev" />
                <span className="admin-acc-name">{g.name}</span>
                <span className="admin-acc-count">{g.items.length}</span>
              </button>
              {open && (
                <div className="admin-coffee-list">
                  {g.items.map(c => (
                    <div key={c.id} className="admin-coffee-row">
                      <Icon name={c.icon} size={20} className="admin-coffee-icon" />
                      <div className="admin-coffee-meta">
                        <span className="admin-coffee-name">{c.name}</span>
                        <span className="admin-coffee-sub">
                          {c.id} · {c.caffeine}mg
                          {c.score_caffeine != null && ` · scores ${c.score_caffeine}mg`}
                        </span>
                      </div>
                      <button className="btn-secondary admin-coffee-btn" onClick={() => { setEditing(c); setFormOpen(true); }}>Edit</button>
                      <button className="admin-coffee-del" aria-label={`Delete ${c.name}`}
                        onClick={() => { setDeleteError(''); setDeleting(c); }}>
                        <Icon name="trash" size={16} />
                      </button>
                    </div>
                  ))}
                  {g.items.length === 0 && <div className="empty-state">Nothing on tap in {g.name}.</div>}
                </div>
              )}
            </div>
          );
        })}
        {!isLoading && coffees.length === 0 && <div className="empty-state">The menu is decaf-initely empty.</div>}
      </div>

      {formOpen && (
        <Modal title={editing ? `Edit ${editing.name}` : 'Add a coffee'} onClose={() => setFormOpen(false)}>
          <CoffeeForm editing={editing} classes={classes} defaultClass={firstClass} onDone={() => setFormOpen(false)} />
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          message="Past logs keep their caffeine."
          confirmLabel="Delete"
          busy={del.isPending}
          error={deleteError || undefined}
          onConfirm={() => del.mutate(deleting.id)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  );
}

// Add or rename a category. Small enough to stay inline (2 fields); the id is
// fixed after creation (it's the key a coffee's class points at).
function CategoryForm({ editing, onDone }: { editing: CoffeeClass | null; onDone: () => void }) {
  const qc = useQueryClient();
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { setId(editing?.id ?? ''); setName(editing?.name ?? ''); setError(''); }, [editing]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['admin-coffee-classes'] });
    qc.invalidateQueries({ queryKey: ['coffee-classes'] });
  };

  const save = useMutation({
    mutationFn: () => (editing
      ? api.patch(`/admin/coffee-classes/${editing.id}`, { name: name.trim() })
      : api.post('/admin/coffee-classes', { id: id.trim(), name: name.trim() })),
    onSuccess: () => { invalidate(); if (!editing) { setId(''); setName(''); } onDone(); },
    onError: (e: Error) => setError(e.message),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing && !/^[a-z0-9_]+$/.test(id.trim())) {
      setError('id must be lowercase letters, numbers and underscores');
      return;
    }
    if (!name.trim()) { setError('Name is required'); return; }
    save.mutate();
  }

  return (
    <form className="admin-coffee-form" onSubmit={submit}>
      {!editing && (
        <label className="admin-field">
          <span>ID</span>
          <input className="search-input" value={id} onChange={e => setId(e.target.value)}
            placeholder="kombucha" autoComplete="off" spellCheck={false} />
        </label>
      )}
      <label className="admin-field">
        <span>Name</span>
        <input className="search-input" value={name} onChange={e => setName(e.target.value)}
          placeholder="Kombucha" autoComplete="off" />
      </label>
      {error && <div className="auth-error" style={{ marginTop: 8 }}>{error}</div>}
      <div className="confirm-actions" style={{ marginTop: 4 }}>
        <button type="submit" className="btn-primary" style={{ width: 'auto' }} disabled={save.isPending}>
          {save.isPending ? 'Saving…' : editing ? 'Rename' : 'Add category'}
        </button>
        {editing && <button type="button" className="btn-secondary" onClick={onDone}>Cancel</button>}
      </div>
    </form>
  );
}

function CategoriesTab({ classes, counts }: { classes: CoffeeClass[]; counts: Record<string, number> }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<CoffeeClass | null>(null);
  const [deleting, setDeleting] = useState<CoffeeClass | null>(null);
  const [deleteError, setDeleteError] = useState('');

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['admin-coffee-classes'] });
    qc.invalidateQueries({ queryKey: ['coffee-classes'] });
  };

  const move = useMutation({
    mutationFn: ({ id, direction }: { id: string; direction: 'up' | 'down' }) =>
      api.post(`/admin/coffee-classes/${id}/move`, { direction }),
    onSuccess: invalidate,
  });

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/coffee-classes/${id}`),
    onSuccess: () => { invalidate(); setDeleting(null); setDeleteError(''); },
    onError: (e: Error) => setDeleteError(e.message),
  });

  return (
    <div className="card">
      <div className="section-label">Categories ({classes.length})</div>
      <CategoryForm editing={editing} onDone={() => setEditing(null)} />
      <div className="admin-coffee-list" style={{ marginTop: 8 }}>
        {classes.map((c, i) => (
          <div key={c.id} className={`admin-coffee-row${editing?.id === c.id ? ' editing' : ''}`}>
            <div className="admin-coffee-meta">
              <span className="admin-coffee-name">{c.name}</span>
              <span className="admin-coffee-sub">{c.id} · {counts[c.id] ?? 0} {(counts[c.id] ?? 0) === 1 ? 'drink' : 'drinks'}</span>
            </div>
            <button className="admin-coffee-del" aria-label={`Move ${c.name} up`} disabled={i === 0 || move.isPending}
              onClick={() => move.mutate({ id: c.id, direction: 'up' })}>
              <Icon name="chevron-up" size={16} />
            </button>
            <button className="admin-coffee-del" aria-label={`Move ${c.name} down`} disabled={i === classes.length - 1 || move.isPending}
              onClick={() => move.mutate({ id: c.id, direction: 'down' })}>
              <Icon name="chevron-down" size={16} />
            </button>
            <button className="btn-secondary admin-coffee-btn" onClick={() => setEditing(c)}>Edit</button>
            <button className="admin-coffee-del" aria-label={`Delete ${c.name}`}
              onClick={() => { setDeleteError(''); setDeleting(c); }}>
              <Icon name="trash" size={16} />
            </button>
          </div>
        ))}
        {classes.length === 0 && <div className="empty-state">No blends sorted yet.</div>}
      </div>

      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          message="Only if no coffee uses it."
          confirmLabel="Delete"
          busy={del.isPending}
          error={deleteError || undefined}
          onConfirm={() => del.mutate(deleting.id)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

export function AdminCoffees() {
  const navigate = useNavigate();
  // `user` is null for a moment on a hard load / refresh while App fetches
  // /auth/me. Only bounce once we KNOW the loaded user isn't an admin — bouncing
  // on the null gap would kick an admin off their own deep link. The API still
  // enforces admin on every write regardless.
  const user = useAuthStore(s => s.user);
  const isAdmin = user?.is_admin === 1;
  const [tab, setTab] = useState<'coffees' | 'categories'>('coffees');

  useEffect(() => {
    if (user && !isAdmin) navigate('/profile', { replace: true });
  }, [user, isAdmin, navigate]);

  const { data: coffees = [], isLoading, error } = useQuery<AdminCoffee[]>({
    queryKey: ['admin-coffees'],
    queryFn: () => api.get<AdminCoffee[]>('/admin/coffees'),
    enabled: isAdmin,
  });

  const { data: classes = [] } = useQuery<CoffeeClass[]>({
    queryKey: ['admin-coffee-classes'],
    queryFn: () => api.get<CoffeeClass[]>('/admin/coffee-classes'),
    enabled: isAdmin,
  });

  // Per-category drink counts, for the Categories tab.
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of coffees) m[c.class] = (m[c.class] ?? 0) + 1;
    return m;
  }, [coffees]);

  // While the user is still loading, or a non-admin is mid-bounce, render the
  // shell so there's no flash of the full page.
  if (!isAdmin) {
    return (
      <div className="page">
        <AppHeader />
        {!user && <div className="page-loading">Loading…</div>}
      </div>
    );
  }

  return (
    <div className="page">
      <AppHeader />
      <div className="page-header">
        <h2>Coffee Catalog</h2>
      </div>

      <div className="tab-row">
        <button className={`tab-btn${tab === 'coffees' ? ' active' : ''}`} onClick={() => setTab('coffees')}>
          Coffees ({coffees.length})
        </button>
        <button className={`tab-btn${tab === 'categories' ? ' active' : ''}`} onClick={() => setTab('categories')}>
          Categories ({classes.length})
        </button>
      </div>

      <main className="stats-tab-body">
        {error && <div className="card error-card">{(error as Error).message}</div>}
        {tab === 'coffees'
          ? <CoffeesTab coffees={coffees} classes={classes} isLoading={isLoading} />
          : <CategoriesTab classes={classes} counts={counts} />}
      </main>
    </div>
  );
}
