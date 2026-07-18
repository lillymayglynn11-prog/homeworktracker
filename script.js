/* ══════════════════════════════════════════════════════════════════════════
   RevTrack — script.js
   A complete client-side revision tracker. No frameworks, no build step.

   Architecture (top to bottom):
     1.  Constants & tiny DOM helpers
     2.  Europe/London time engine (DST-safe, timestamp based)
     3.  Formatting helpers
     4.  Store        — load/save/normalise localStorage state
     5.  Stats        — derived aggregates, rebuilt on every data change
     6.  Toast        — notifications with undo actions
     7.  Sound        — WebAudio-synthesised notification tones
     8.  Theme        — light/dark/system + graph palettes
     9.  Modal        — dialog system with focus trap + confirm()
     10. Mutations    — the only functions that change session data
     11. Session form — add / edit / duplicate / delete modal
     12. Timer        — drift-free stopwatch persisted across reloads
     13. Charts       — Chart.js wrappers themed from CSS variables
     14. Dashboard    — greeting, today/week/month cards, graphs, recents
     15. Calendar     — weekly planner with drag-to-move blocks
     16. Statistics   — tiles, extra charts, heatmap, subject table
     17. Setup        — subjects CRUD/reorder, targets, appearance, data IO
     18. Search       — instant global search
     19. Shortcuts    — keyboard control
     20. Router/clock — view switching and the 1-second heartbeat
   ══════════════════════════════════════════════════════════════════════════ */
(() => {
'use strict';

/* ═══ 1. Constants & DOM helpers ═════════════════════════════════════════ */

const STORAGE_KEY = 'revtrack.v1';
const TZ = 'Europe/London';
const HOUR_H = 56;               // px per hour in the calendar (matches --hour-h)
const RING_CIRC = 326.7;         // 2πr for the r=52 timer ring
const MAX_SESSION_SEC = 24 * 3600;

const WD_LONG  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const WD_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const WD_MIN   = ['Su','Mo','Tu','We','Th','Fr','Sa'];
const MONTHS       = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** Pleasant defaults offered for new subjects, cycled in order. */
const SUBJECT_COLORS = ['#5457e0','#e0447c','#0f9488','#d97b06','#3b82d6','#8b5cf6','#16a34a','#dc4b4b','#0891b2','#a16207'];

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(tag, cls) { const n = document.createElement(tag); if (cls) n.className = cls; return n; }
function uid() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9); }
function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
function pad2(n) { return String(n).padStart(2, '0'); }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** '#rrggbb' → 'rgba(r,g,b,a)'. Falls back to the indigo accent on bad input. */
function hexToRgba(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return `rgba(84,87,224,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/* ═══ 2. Europe/London time engine ═══════════════════════════════════════
   All calendar maths is done against the Europe/London wall clock, whatever
   timezone the device is in. Sessions are stored as UTC epoch milliseconds
   (so the timer can never drift), and converted to London wall time only
   for display and day-bucketing. `londonEpoch` inverts the conversion with
   an iterative correction that is safe across DST changes.               */

const _partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
});
const _fullDateFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
});

/** London wall-clock parts for an epoch ms. */
function londonParts(ms) {
  const o = {};
  for (const p of _partsFmt.formatToParts(ms)) if (p.type !== 'literal') o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: (+o.hour) % 24, mi: +o.minute, s: +o.second };
}

function dateKeyOf(ms) { const p = londonParts(ms); return `${p.y}-${pad2(p.mo)}-${pad2(p.d)}`; }
function todayKey() { return dateKeyOf(Date.now()); }
function keyParts(key) { const [y, m, d] = key.split('-').map(Number); return { y, m, d }; }

/** Pure calendar-date arithmetic on a 'YYYY-MM-DD' key (timezone-free). */
function addDaysKey(key, n) {
  const { y, m, d } = keyParts(key);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** 0 = Sunday … 6 = Saturday for a date key. */
function weekdayOfKey(key) {
  const { y, m, d } = keyParts(key);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Epoch ms for a London wall time (iterative DST correction, ≤3 passes). */
function londonEpoch(y, mo, d, h = 0, mi = 0, s = 0) {
  const target = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = londonParts(guess);
    const got = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    const diff = target - got;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

function epochFromKeyTime(key, hhmm) {
  const { y, m, d } = keyParts(key);
  const [h, mi] = String(hhmm || '00:00').split(':').map(Number);
  return londonEpoch(y, m, d, h || 0, mi || 0, 0);
}

/** Minutes since London midnight (fractional). */
function minutesIntoDay(ms) { const p = londonParts(ms); return p.h * 60 + p.mi + p.s / 60; }

function weekStartOf(key) {
  const fdw = Store.data.settings.firstDayOfWeek;
  return addDaysKey(key, -((weekdayOfKey(key) - fdw + 7) % 7));
}

/* ═══ 3. Formatting ══════════════════════════════════════════════════════ */

/** 4980 → '1h 23m', 300 → '5m', 42 → '42s'. */
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec}s`;
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Compact: 9000 → '2.5h', 1500 → '25m'. */
function fmtDurShort(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1).replace(/\.0$/, '')}h`;
}

/** Decimal hours: '12.5h'. */
function fmtHours(sec) { return `${(sec / 3600).toFixed(1).replace(/\.0$/, '')}h`; }

/** Stopwatch face: 'HH:MM:SS'. */
function fmtClockHMS(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function fmtTimeOfDay(ms) { const p = londonParts(ms); return `${pad2(p.h)}:${pad2(p.mi)}`; }
function fmtFullDate(ms) { return _fullDateFmt.format(ms); }

/** 'Mon 7 Jul' for a date key. */
function fmtDayShort(key) {
  const { m, d } = keyParts(key);
  return `${WD_SHORT[weekdayOfKey(key)]} ${d} ${MONTHS_SHORT[m - 1]}`;
}

/** '7 – 13 Jul 2026' or '28 Jul – 3 Aug 2026' for a week range. */
function fmtRange(aKey, bKey) {
  const a = keyParts(aKey), b = keyParts(bKey);
  if (a.y === b.y && a.m === b.m) return `${a.d} – ${b.d} ${MONTHS_SHORT[b.m - 1]} ${b.y}`;
  if (a.y === b.y) return `${a.d} ${MONTHS_SHORT[a.m - 1]} – ${b.d} ${MONTHS_SHORT[b.m - 1]} ${b.y}`;
  return `${a.d} ${MONTHS_SHORT[a.m - 1]} ${a.y} – ${b.d} ${MONTHS_SHORT[b.m - 1]} ${b.y}`;
}

function minToHM(min) {
  min = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
}
function hmToMin(hm) {
  const [h, m] = String(hm || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/* ═══ 4. Store ═══════════════════════════════════════════════════════════ */

const DEFAULT_SETTINGS = {
  theme: 'system', palette: 'indigo', firstDayOfWeek: 1,
  weeklyTargetHours: 10, dailyTargetHours: 2,
  defaultSessionMinutes: 45, sound: 'chime'
};

const Store = {
  data: null,

  load() {
    let raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { console.warn('RevTrack: localStorage unavailable.', e); }
    let parsed = null;
    if (raw) {
      try { parsed = JSON.parse(raw); }
      catch (e) {
        console.warn('RevTrack: stored data was corrupt; a copy was kept under "' + STORAGE_KEY + '.corrupt".', e);
        try { localStorage.setItem(STORAGE_KEY + '.corrupt', raw); } catch (_) { /* best effort */ }
      }
    }
    this.data = this.normalise(parsed);
  },

  /** Coerce any imported/stored blob into a valid state object. */
  normalise(d) {
    const out = { version: 1, subjects: [], sessions: [], settings: { ...DEFAULT_SETTINGS }, timer: null };
    if (!d || typeof d !== 'object') return out;

    if (Array.isArray(d.subjects)) {
      out.subjects = d.subjects
        .filter(s => s && s.id != null && s.name)
        .map(s => ({
          id: String(s.id),
          name: String(s.name).slice(0, 60),
          color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color.toLowerCase() : SUBJECT_COLORS[0]
        }));
    }

    if (Array.isArray(d.sessions)) {
      out.sessions = d.sessions
        .filter(s => s && s.id != null && Number.isFinite(+s.start) && Number.isFinite(+s.duration) && +s.duration > 0)
        .map(s => {
          const start = +s.start;
          const duration = clamp(Math.round(+s.duration), 1, MAX_SESSION_SEC);
          const end = Number.isFinite(+s.end) && +s.end > start ? +s.end : start + duration * 1000;
          return {
            id: String(s.id),
            subjectId: String(s.subjectId ?? ''),
            title: String(s.title ?? '').slice(0, 120),
            notes: String(s.notes ?? '').slice(0, 5000),
            start, end, duration,
            color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color.toLowerCase() : null,
            manual: !!s.manual
          };
        });
    }

    if (d.settings && typeof d.settings === 'object') {
      const st = d.settings, S = out.settings;
      if (['system', 'light', 'dark'].includes(st.theme)) S.theme = st.theme;
      if (['indigo', 'teal', 'amber', 'rose', 'slate'].includes(st.palette)) S.palette = st.palette;
      if (st.firstDayOfWeek === 0 || st.firstDayOfWeek === 1) S.firstDayOfWeek = st.firstDayOfWeek;
      if (Number.isFinite(+st.weeklyTargetHours)) S.weeklyTargetHours = clamp(+st.weeklyTargetHours, 0, 120);
      if (Number.isFinite(+st.dailyTargetHours)) S.dailyTargetHours = clamp(+st.dailyTargetHours, 0, 24);
      if (Number.isFinite(+st.defaultSessionMinutes)) S.defaultSessionMinutes = clamp(Math.round(+st.defaultSessionMinutes), 5, 480);
      if (['chime', 'bell', 'beep', 'none'].includes(st.sound)) S.sound = st.sound;
    }

    if (d.timer && typeof d.timer === 'object' && Number.isFinite(+d.timer.startedAt)) {
      out.timer = {
        subjectId: String(d.timer.subjectId ?? ''),
        title: String(d.timer.title ?? '').slice(0, 120),
        notes: String(d.timer.notes ?? '').slice(0, 5000),
        startedAt: +d.timer.startedAt,
        accumMs: Math.max(0, +d.timer.accumMs || 0),
        resumedAt: Number.isFinite(+d.timer.resumedAt) ? +d.timer.resumedAt : null,
        notified: !!d.timer.notified
      };
      // A timer whose subject no longer exists cannot be finished meaningfully.
      if (!out.subjects.some(s => s.id === out.timer.subjectId)) out.timer = null;
    }

    return out;
  },

  save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data)); }
    catch (e) {
      console.error('RevTrack: save failed.', e);
      Toast.show('Could not save — browser storage is full or blocked.', { danger: true });
    }
  }
};

/* Convenience lookups used everywhere. */
function subjectById(id) { return Store.data.subjects.find(s => s.id === id) || null; }
function subjectName(id) { const s = subjectById(id); return s ? s.name : 'No subject'; }
function sessionColor(s) { return s.color || (subjectById(s.subjectId) || {}).color || '#8b91a5'; }
function sessionLabel(s) { return (s.title || '').trim() ? s.title.trim() : subjectName(s.subjectId); }

/* ═══ 5. Derived statistics ══════════════════════════════════════════════
   Rebuilt in a single O(n) pass whenever data changes. Every view reads
   from these maps instead of re-scanning the session list, which keeps
   rendering fast even with thousands of sessions.                        */

const Stats = {
  byDay: new Map(),      // 'YYYY-MM-DD' → seconds
  byMonth: new Map(),    // 'YYYY-MM'    → seconds
  byYear: new Map(),     // 'YYYY'       → seconds
  byWeekday: [0, 0, 0, 0, 0, 0, 0],
  bySubject: new Map(),  // subjectId → {total,count,week,month,longest,shortest}
  sorted: [],            // sessions, newest first
  totalSec: 0,
  longest: null, shortest: null,
  firstKey: null,
  weekStartKey: '', weekEndKey: '', monthPrefix: '',

  rebuild() {
    this.byDay.clear(); this.byMonth.clear(); this.byYear.clear(); this.bySubject.clear();
    this.byWeekday = [0, 0, 0, 0, 0, 0, 0];
    this.totalSec = 0; this.longest = null; this.shortest = null; this.firstKey = null;

    const tk = todayKey();
    this.weekStartKey = weekStartOf(tk);
    this.weekEndKey = addDaysKey(this.weekStartKey, 6);
    this.monthPrefix = tk.slice(0, 7);

    for (const sub of Store.data.subjects) {
      this.bySubject.set(sub.id, { total: 0, count: 0, week: 0, month: 0, longest: 0, shortest: Infinity });
    }

    for (const s of Store.data.sessions) {
      const key = dateKeyOf(s.start);
      const dur = s.duration;

      this.byDay.set(key, (this.byDay.get(key) || 0) + dur);
      const mk = key.slice(0, 7);
      this.byMonth.set(mk, (this.byMonth.get(mk) || 0) + dur);
      const yk = key.slice(0, 4);
      this.byYear.set(yk, (this.byYear.get(yk) || 0) + dur);
      this.byWeekday[weekdayOfKey(key)] += dur;
      this.totalSec += dur;

      if (!this.longest || dur > this.longest.duration) this.longest = s;
      if (!this.shortest || dur < this.shortest.duration) this.shortest = s;
      if (!this.firstKey || key < this.firstKey) this.firstKey = key;

      let agg = this.bySubject.get(s.subjectId);
      if (!agg) { agg = { total: 0, count: 0, week: 0, month: 0, longest: 0, shortest: Infinity }; this.bySubject.set(s.subjectId, agg); }
      agg.total += dur; agg.count += 1;
      agg.longest = Math.max(agg.longest, dur);
      agg.shortest = Math.min(agg.shortest, dur);
      if (key >= this.weekStartKey && key <= this.weekEndKey) agg.week += dur;
      if (mk === this.monthPrefix) agg.month += dur;
    }

    this.sorted = Store.data.sessions.slice().sort((a, b) => b.start - a.start);
  },

  daySec(key) { return this.byDay.get(key) || 0; },

  weekSec(startKey) {
    let t = 0;
    for (let i = 0; i < 7; i++) t += this.daySec(addDaysKey(startKey, i));
    return t;
  },

  /** {current, longest} streaks of consecutive days with any revision. */
  streaks() {
    let longest = 0, current = 0;
    if (this.byDay.size) {
      const keys = [...this.byDay.keys()].filter(k => this.byDay.get(k) > 0).sort();
      let run = 0, prev = null;
      for (const k of keys) {
        run = (prev && addDaysKey(prev, 1) === k) ? run + 1 : 1;
        longest = Math.max(longest, run);
        prev = k;
      }
      let k = todayKey();
      if (!this.byDay.get(k)) k = addDaysKey(k, -1);   // today not started yet ≠ broken streak
      while ((this.byDay.get(k) || 0) > 0) { current++; k = addDaysKey(k, -1); }
    }
    return { current, longest };
  }
};

/* ═══ 6. Toasts (with undo) ══════════════════════════════════════════════ */

const Toast = {
  root: null,

  /**
   * Show a toast. opts: {actionLabel, onAction, duration, danger}
   * Returns a dismiss function.
   */
  show(msg, opts = {}) {
    if (!this.root) return () => {};
    const { actionLabel, onAction, duration = 3800, danger = false } = opts;

    const t = el('div', 'toast' + (danger ? ' is-danger' : ''));
    const span = el('span', 't-msg');
    span.textContent = msg;
    t.appendChild(span);

    let gone = false;
    const dismiss = () => {
      if (gone) return;
      gone = true;
      t.classList.add('is-leaving');
      setTimeout(() => t.remove(), 280);
    };

    if (actionLabel) {
      const b = el('button');
      b.type = 'button';
      b.textContent = actionLabel;
      b.addEventListener('click', () => { dismiss(); if (onAction) onAction(); });
      t.appendChild(b);
    }

    this.root.appendChild(t);
    while (this.root.children.length > 3) this.root.firstElementChild.remove();
    setTimeout(dismiss, duration);
    return dismiss;
  }
};

/* ═══ 7. Sound ═══════════════════════════════════════════════════════════
   Tones are synthesised with WebAudio so the app ships no audio files.   */

const Sound = {
  ctx: null,

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { this.ctx = new AC(); } catch (_) { return null; }
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  },

  play(kind = Store.data.settings.sound) {
    if (kind === 'none') return;
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime;

    const tone = (freq, start, dur, type = 'sine', gain = 0.16) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0 + start);
      g.gain.linearRampToValueAtTime(gain, t0 + start + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
      o.connect(g); g.connect(ctx.destination);
      o.start(t0 + start); o.stop(t0 + start + dur + 0.05);
    };

    if (kind === 'chime')      { tone(880, 0, 0.5); tone(1318.5, 0.13, 0.7); }
    else if (kind === 'bell')  { tone(659.25, 0, 1.15, 'triangle', 0.22); tone(1318.5, 0, 0.55, 'sine', 0.06); }
    else if (kind === 'beep')  { tone(1000, 0, 0.12, 'square', 0.09); tone(1000, 0.2, 0.12, 'square', 0.09); }
  }
};

/* ═══ 8. Theme ═══════════════════════════════════════════════════════════ */

const Theme = {
  mq: window.matchMedia('(prefers-color-scheme: dark)'),

  init() {
    const onSystemChange = () => { if (Store.data.settings.theme === 'system') this.apply(); };
    if (this.mq.addEventListener) this.mq.addEventListener('change', onSystemChange);
    else if (this.mq.addListener) this.mq.addListener(onSystemChange); // older Safari

    $('#theme-toggle').addEventListener('click', () => {
      const resolvedNow = document.documentElement.dataset.theme;
      Store.data.settings.theme = resolvedNow === 'dark' ? 'light' : 'dark';
      Store.save();
      this.apply();
      const sel = $('#set-theme');
      if (sel) sel.value = Store.data.settings.theme;
    });

    this.apply(false);
  },

  resolved() {
    const t = Store.data.settings.theme;
    return t === 'system' ? (this.mq.matches ? 'dark' : 'light') : t;
  },

  apply(rerender = true) {
    document.documentElement.dataset.theme = this.resolved();
    document.documentElement.dataset.palette = Store.data.settings.palette;
    const meta = $('#meta-theme-color');
    if (meta) meta.setAttribute('content', getComputedStyle(document.body).backgroundColor);
    if (rerender) renderActiveView(); // recreates charts with the new colours
  }
};

/* ═══ 9. Modal system ════════════════════════════════════════════════════ */

const CLOSE_X_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/></svg>';

const Modal = {
  root: null,
  lastFocus: null,
  onCloseCb: null,

  /** Open a dialog from an HTML string; returns the .modal element. */
  open(innerHtml, { narrow = false, onClose = null } = {}) {
    this.close();
    this.lastFocus = document.activeElement;
    this.onCloseCb = onClose;

    const overlay = el('div', 'modal-overlay');
    overlay.innerHTML = `<div class="modal${narrow ? ' modal-narrow' : ''}" role="dialog" aria-modal="true">${innerHtml}</div>`;
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) this.close(); });
    this.root.appendChild(overlay);

    const dlg = overlay.firstElementChild;
    $$('.modal-close, [data-close]', dlg).forEach(b => b.addEventListener('click', () => this.close()));

    const focusables = () =>
      $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', dlg)
        .filter(n => !n.disabled && n.offsetParent !== null);

    const first = focusables();
    (first.find(n => n.matches('input, select, textarea')) || first[0] || dlg).focus();

    overlay.addEventListener('keydown', e => {
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (!list.length) return;
      const firstEl = list[0], lastEl = list[list.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
    });

    return dlg;
  },

  close() {
    const ov = this.root ? this.root.firstElementChild : null;
    if (!ov) return;
    ov.remove();
    const cb = this.onCloseCb;
    this.onCloseCb = null;
    if (cb) cb();
    if (this.lastFocus && this.lastFocus.focus) this.lastFocus.focus();
  },

  isOpen() { return !!(this.root && this.root.firstElementChild); },

  /** Promise<boolean> confirmation dialog. */
  confirm({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', danger = false } = {}) {
    return new Promise(resolve => {
      let done = false;
      const finish = v => { if (!done) { done = true; resolve(v); } };
      const dlg = this.open(`
        <div class="modal-head">
          <h3 class="modal-title">${escapeHtml(title)}</h3>
          <button class="modal-close" aria-label="Close">${CLOSE_X_SVG}</button>
        </div>
        <p class="modal-msg">${escapeHtml(message)}</p>
        <div class="modal-foot">
          <button type="button" class="btn btn-ghost" data-close>Cancel</button>
          <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${escapeHtml(confirmLabel)}</button>
        </div>`,
        { narrow: true, onClose: () => finish(false) });
      $('[data-ok]', dlg).addEventListener('click', () => { finish(true); this.close(); });
    });
  }
};

/* ═══ 10. Data mutations ═════════════════════════════════════════════════
   All writes funnel through here: save → rebuild stats → re-render.      */

function commit() {
  Store.save();
  Stats.rebuild();
  renderActiveView();
}

function addSessionRecord(rec) {
  Store.data.sessions.push(rec);
  commit();
}

function updateSession(id, patch) {
  const s = Store.data.sessions.find(x => x.id === id);
  if (!s) return;
  Object.assign(s, patch);
  commit();
}

function removeSession(id, { withUndo = true } = {}) {
  const i = Store.data.sessions.findIndex(x => x.id === id);
  if (i < 0) return;
  const [gone] = Store.data.sessions.splice(i, 1);
  commit();
  if (withUndo) {
    Toast.show('Session deleted', {
      actionLabel: 'Undo', duration: 6000,
      onAction: () => { Store.data.sessions.push(gone); commit(); Toast.show('Session restored'); }
    });
  }
}

/** First existing session that overlaps [start,end), excluding one id. */
function findOverlap(start, end, excludeId = null) {
  return Store.data.sessions.find(s => s.id !== excludeId && s.start < end && s.end > start) || null;
}

/** Copy a session onto the next day at the same wall time. */
function duplicateSession(s) {
  const key = addDaysKey(dateKeyOf(s.start), 1);
  const start = epochFromKeyTime(key, fmtTimeOfDay(s.start));
  const wall = Math.max(60000, s.end - s.start);
  const copy = { ...s, id: uid(), start, end: start + wall };
  Store.data.sessions.push(copy);
  commit();
  Toast.show('Copied to ' + fmtDayShort(key), {
    actionLabel: 'Undo', duration: 6000,
    onAction: () => removeSession(copy.id, { withUndo: false })
  });
}

/* ═══ 11. Session form modal (add · edit · view details) ═════════════════ */

function subjectOptionsHtml(selectedId) {
  return Store.data.subjects
    .map(s => `<option value="${escapeHtml(s.id)}" ${s.id === selectedId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`)
    .join('');
}

/**
 * The one form used for manual entry, calendar blocks and editing.
 * opts: { session } to edit, or { prefill: {dateKey, startMin, durationMin, subjectId} } to add.
 */
function openSessionModal(opts = {}) {
  const session = opts.session || null;
  const prefill = opts.prefill || {};
  const isEdit = !!session;

  if (!Store.data.subjects.length) {
    Toast.show('Add a subject in Setup first', {
      actionLabel: 'Open Setup', onAction: () => Router.go('setup')
    });
    return;
  }

  // ── initial values ──
  let dateKey, startHM, endHM, subjectId, title, notes, colorMode, colorHex, storedDuration;
  if (isEdit) {
    dateKey = dateKeyOf(session.start);
    startHM = fmtTimeOfDay(session.start);
    endHM = fmtTimeOfDay(session.end);
    subjectId = session.subjectId;
    title = session.title || '';
    notes = session.notes || '';
    colorMode = session.color ? 'custom' : 'subject';
    colorHex = session.color || sessionColor(session);
    storedDuration = session.duration;
  } else {
    dateKey = prefill.dateKey || todayKey();
    const nowP = londonParts(Date.now());
    const rawStart = prefill.startMin != null ? prefill.startMin : nowP.h * 60 + nowP.mi;
    const startMin = clamp(Math.round(rawStart / 5) * 5, 0, 1435);
    const len = clamp(prefill.durationMin || Store.data.settings.defaultSessionMinutes, 5, 1435);
    startHM = minToHM(startMin);
    endHM = minToHM(startMin + len);
    subjectId = prefill.subjectId || Store.data.subjects[0].id;
    title = ''; notes = '';
    colorMode = 'subject';
    colorHex = (subjectById(subjectId) || {}).color || SUBJECT_COLORS[0];
    storedDuration = len * 60;
  }

  const dlg = Modal.open(`
    <div class="modal-head">
      <h3 class="modal-title">${isEdit ? 'Session details' : 'Add revision'}</h3>
      <button class="modal-close" aria-label="Close">${CLOSE_X_SVG}</button>
    </div>
    <div class="modal-body">
      <div id="f-error" class="form-error" hidden></div>
      <div class="form-2col">
        <label class="field"><span>Subject</span>
          <select id="f-subject">${subjectOptionsHtml(subjectId)}</select>
        </label>
        <label class="field"><span>Title <em class="form-hint">(optional)</em></span>
          <input id="f-title" type="text" maxlength="120" placeholder="e.g. Past paper 3" value="${escapeHtml(title)}" />
        </label>
      </div>
      <div class="form-3col">
        <label class="field"><span>Date</span><input id="f-date" type="date" value="${dateKey}" required /></label>
        <label class="field"><span>Start</span><input id="f-start" type="time" value="${startHM}" required /></label>
        <label class="field"><span>End</span><input id="f-end" type="time" value="${endHM}" required /></label>
      </div>
      <div class="form-2col">
        <label class="field"><span>Duration (minutes)</span>
          <input id="f-durmin" type="number" min="1" max="1439" step="1" />
        </label>
        <label class="field"><span>Block colour</span>
          <span class="field-row">
            <select id="f-colormode">
              <option value="subject" ${colorMode === 'subject' ? 'selected' : ''}>Subject colour</option>
              <option value="custom" ${colorMode === 'custom' ? 'selected' : ''}>Custom</option>
            </select>
            <input id="f-color" type="color" class="subject-color" value="${colorHex}" aria-label="Custom block colour" ${colorMode === 'custom' ? '' : 'hidden'} />
          </span>
        </label>
      </div>
      <p id="f-summary" class="form-hint"></p>
      <label class="field"><span>Notes <em class="form-hint">(optional)</em></span>
        <textarea id="f-notes" placeholder="What did you cover? Anything to revisit?">${escapeHtml(notes)}</textarea>
      </label>
    </div>
    <div class="modal-foot">
      ${isEdit ? `<span class="spacer">
        <button type="button" class="btn btn-danger btn-small" id="f-delete">Delete</button>
        <button type="button" class="btn btn-ghost btn-small" id="f-dup" title="Copy to the next day">Duplicate</button>
      </span>` : ''}
      <button type="button" class="btn btn-ghost" data-close>Cancel</button>
      <button type="button" class="btn btn-primary" id="f-save">${isEdit ? 'Save changes' : 'Add session'}</button>
    </div>`);

  const f = {
    error: $('#f-error', dlg), subject: $('#f-subject', dlg), title: $('#f-title', dlg),
    date: $('#f-date', dlg), start: $('#f-start', dlg), end: $('#f-end', dlg),
    durmin: $('#f-durmin', dlg), notes: $('#f-notes', dlg),
    colormode: $('#f-colormode', dlg), color: $('#f-color', dlg),
    summary: $('#f-summary', dlg), save: $('#f-save', dlg)
  };

  let timesDirty = !isEdit;    // edits keep the original timestamps until touched
  let allowOverlap = false;    // set after the first overlap warning

  const showError = msg => {
    f.error.textContent = msg;
    f.error.hidden = false;
    // retrigger the shake animation
    f.error.style.animation = 'none';
    void f.error.offsetWidth;
    f.error.style.animation = '';
  };
  const clearError = () => { f.error.hidden = true; allowOverlap = false; };

  /** Wall-clock minutes between start and end fields (overnight-aware). */
  const wallMinutes = () => {
    const s = hmToMin(f.start.value), e = hmToMin(f.end.value);
    if (f.start.value === f.end.value) return 0;
    return e > s ? e - s : (1440 - s) + e;
  };

  const syncSummary = () => {
    const mins = timesDirty ? wallMinutes() : Math.round(storedDuration / 60);
    const overnight = timesDirty && hmToMin(f.end.value) <= hmToMin(f.start.value) && f.start.value !== f.end.value;
    f.durmin.value = mins > 0 ? mins : '';
    f.summary.textContent = mins > 0
      ? `Counts as ${fmtDur(mins * 60)}${overnight ? ' · finishes the next day' : ''}`
      : 'End time must be different from the start time.';
  };

  const markDirty = () => { timesDirty = true; clearError(); syncSummary(); };
  ['input', 'change'].forEach(ev => {
    f.date.addEventListener(ev, markDirty);
    f.start.addEventListener(ev, markDirty);
    f.end.addEventListener(ev, markDirty);
  });

  f.durmin.addEventListener('change', () => {
    let v = parseInt(f.durmin.value, 10);
    if (!Number.isFinite(v)) { syncSummary(); return; }
    v = clamp(v, 1, 1439);
    timesDirty = true;
    f.end.value = minToHM(hmToMin(f.start.value) + v);
    clearError();
    syncSummary();
  });

  f.subject.addEventListener('change', () => {
    clearError();
    if (f.colormode.value === 'subject') {
      const sub = subjectById(f.subject.value);
      if (sub) f.color.value = sub.color;
    }
  });
  f.colormode.addEventListener('change', () => { f.color.hidden = f.colormode.value !== 'custom'; });

  syncSummary();

  // ── actions ──
  if (isEdit) {
    $('#f-delete', dlg).addEventListener('click', async () => {
      Modal.close();
      const ok = await Modal.confirm({
        title: 'Delete this session?',
        message: `${subjectName(session.subjectId)} · ${fmtDayShort(dateKeyOf(session.start))}, ${fmtTimeOfDay(session.start)}–${fmtTimeOfDay(session.end)} (${fmtDur(session.duration)}).`,
        confirmLabel: 'Delete', danger: true
      });
      if (ok) removeSession(session.id);
    });
    $('#f-dup', dlg).addEventListener('click', () => { Modal.close(); duplicateSession(session); });
  }

  f.save.addEventListener('click', () => {
    // — validation —
    const subj = subjectById(f.subject.value);
    if (!subj) { showError('Choose a subject for this session.'); return; }
    if (!f.date.value || !/^\d{4}-\d{2}-\d{2}$/.test(f.date.value)) { showError('Choose a valid date.'); return; }
    if (!f.start.value || !f.end.value) { showError('Enter both a start and an end time.'); return; }
    if (f.start.value === f.end.value) { showError('End time must be different from the start time — a session cannot last 0 minutes.'); return; }

    let startMs, endMs, durSec;
    if (timesDirty) {
      startMs = epochFromKeyTime(f.date.value, f.start.value);
      const endKey = hmToMin(f.end.value) <= hmToMin(f.start.value) ? addDaysKey(f.date.value, 1) : f.date.value;
      endMs = epochFromKeyTime(endKey, f.end.value);
      durSec = Math.round((endMs - startMs) / 1000);
      if (!(durSec > 0)) { showError('The end must come after the start — check the times.'); return; }
      if (durSec > MAX_SESSION_SEC) { showError('Sessions are capped at 24 hours. Split longer stints into parts.'); return; }
    } else {
      startMs = session.start; endMs = session.end; durSec = session.duration;
    }

    const clash = findOverlap(startMs, endMs, isEdit ? session.id : null);
    if (clash && !allowOverlap) {
      allowOverlap = true;
      showError(`Overlaps “${sessionLabel(clash)}” (${fmtTimeOfDay(clash.start)}–${fmtTimeOfDay(clash.end)}, ${fmtDayShort(dateKeyOf(clash.start))}). Press ${isEdit ? '“Save changes”' : '“Add session”'} again to keep both.`);
      return;
    }

    const payload = {
      subjectId: subj.id,
      title: f.title.value.trim().slice(0, 120),
      notes: f.notes.value.slice(0, 5000),
      color: f.colormode.value === 'custom' ? f.color.value : null
    };

    if (isEdit) {
      if (timesDirty) Object.assign(payload, { start: startMs, end: endMs, duration: durSec, manual: true });
      Modal.close();
      updateSession(session.id, payload);
      Toast.show('Session updated');
    } else {
      Modal.close();
      addSessionRecord({ id: uid(), start: startMs, end: endMs, duration: durSec, manual: true, ...payload });
      Toast.show(startMs > Date.now() ? 'Block planned — it will show on the calendar' : 'Session added');
    }
  });
}

/* ═══ 12. Timer ══════════════════════════════════════════════════════════
   Elapsed time is always derived from stored timestamps (startedAt,
   accumMs, resumedAt), never from interval counting — so it cannot drift,
   keeps running in background tabs, and survives page reloads because the
   whole timer state is persisted with the rest of the store.             */

const Timer = {
  get t() { return Store.data.timer; },
  isRunning() { return !!(this.t && this.t.resumedAt); },

  elapsedMs() {
    const t = this.t;
    if (!t) return 0;
    return t.accumMs + (t.resumedAt ? Date.now() - t.resumedAt : 0);
  },

  openStartModal() {
    if (this.t) return;
    if (!Store.data.subjects.length) {
      Toast.show('Add a subject in Setup first', { actionLabel: 'Open Setup', onAction: () => Router.go('setup') });
      return;
    }
    const dlg = Modal.open(`
      <div class="modal-head">
        <h3 class="modal-title">Start a session</h3>
        <button class="modal-close" aria-label="Close">${CLOSE_X_SVG}</button>
      </div>
      <div class="modal-body">
        <label class="field"><span>Subject</span>
          <select id="t-subject">${subjectOptionsHtml(Store.data.subjects[0].id)}</select>
        </label>
        <label class="field"><span>Session title <em class="form-hint">(optional)</em></span>
          <input id="t-title" type="text" maxlength="120" placeholder="e.g. Flashcards, chapter 4" />
        </label>
        <label class="field"><span>Notes <em class="form-hint">(optional — you can edit them later)</em></span>
          <textarea id="t-notes" placeholder="Plan for this session…"></textarea>
        </label>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn btn-ghost" data-close>Cancel</button>
        <button type="button" class="btn btn-primary" id="t-go">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg> Start timer
        </button>
      </div>`);

    const go = () => {
      Store.data.timer = {
        subjectId: $('#t-subject', dlg).value,
        title: $('#t-title', dlg).value.trim().slice(0, 120),
        notes: $('#t-notes', dlg).value.slice(0, 5000),
        startedAt: Date.now(), accumMs: 0, resumedAt: Date.now(), notified: false
      };
      Store.save();
      Sound.ensure();            // unlock audio while we have a user gesture
      Modal.close();
      this.syncUI();
      Toast.show('Timer started — good luck!');
    };
    $('#t-go', dlg).addEventListener('click', go);
    dlg.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.target.matches('textarea')) { e.preventDefault(); go(); }
    });
  },

  pause() {
    const t = this.t;
    if (!t || !t.resumedAt) return;
    t.accumMs += Date.now() - t.resumedAt;
    t.resumedAt = null;
    Store.save();
    this.syncUI();
  },

  resume() {
    const t = this.t;
    if (!t || t.resumedAt) return;
    t.resumedAt = Date.now();
    Store.save();
    this.syncUI();
  },

  finish() {
    const t = this.t;
    if (!t) return;
    const elapsed = Math.round(this.elapsedMs() / 1000);
    Store.data.timer = null;
    if (elapsed < 5) {
      commit();
      this.syncUI();
      Toast.show('Under 5 seconds — nothing was saved');
      return;
    }
    Store.data.sessions.push({
      id: uid(), subjectId: t.subjectId, title: t.title, notes: t.notes,
      start: t.startedAt, end: Date.now(),
      duration: Math.min(elapsed, MAX_SESSION_SEC),
      color: null, manual: false
    });
    commit();
    this.syncUI();
    Sound.play();
    Toast.show(`Saved ${fmtDur(elapsed)} of ${subjectName(t.subjectId)} — well done!`, { duration: 5200 });
  },

  async discard() {
    if (!this.t) return;
    const ok = await Modal.confirm({
      title: 'Discard this session?',
      message: `${fmtDur(Math.round(this.elapsedMs() / 1000))} of elapsed time will not be saved.`,
      confirmLabel: 'Discard', danger: true
    });
    if (!ok) return;
    Store.data.timer = null;
    Store.save();
    this.syncUI();
    Toast.show('Session discarded');
  },

  /** Called every second by the global heartbeat. */
  tick() {
    const t = this.t;
    const display = $('#timer-display');
    if (!t) return;
    const elSec = Math.floor(this.elapsedMs() / 1000);
    display.textContent = fmtClockHMS(elSec);

    const goalSec = Store.data.settings.defaultSessionMinutes * 60;
    const frac = goalSec > 0 ? Math.min(1, elSec / goalSec) : 0;
    $('#ring-progress').style.strokeDashoffset = (RING_CIRC * (1 - frac)).toFixed(1);

    if (this.isRunning() && !t.notified && goalSec > 0 && elSec >= goalSec) {
      t.notified = true;
      Store.save();
      Sound.play();
      Toast.show(`${Store.data.settings.defaultSessionMinutes} minutes done — keep going or take a break`, { duration: 6000 });
    }
  },

  /** Reflect timer state in the dashboard controls. */
  syncUI() {
    const t = this.t;
    const running = this.isRunning();
    $('#btn-start').hidden = !!t;
    $('#btn-manual').hidden = !!t;
    $('#btn-pause').hidden = !t || !running;
    $('#btn-resume').hidden = !t || running;
    $('#btn-finish').hidden = !t;
    $('#btn-reset').hidden = !t;

    const zone = $('#timer-zone');
    zone.classList.toggle('is-running', !!t && running);
    zone.classList.toggle('is-paused', !!t && !running);
    $('#timer-state').textContent = !t ? 'Ready' : (running ? 'Focusing' : 'Paused');

    const chip = $('#timer-subject'), titleEl = $('#timer-session-title');
    if (t) {
      const sub = subjectById(t.subjectId);
      chip.hidden = false;
      chip.innerHTML = `<i class="dot" style="background:${escapeHtml(sub ? sub.color : '#8b91a5')}"></i><span>${escapeHtml(sub ? sub.name : 'Subject')}</span>`;
      titleEl.hidden = !t.title;
      titleEl.textContent = t.title;
    } else {
      chip.hidden = true;
      titleEl.hidden = true;
      $('#timer-display').textContent = '00:00:00';
      $('#ring-progress').style.strokeDashoffset = RING_CIRC;
    }
    this.tick();
    updateTodayTotal();
  }
};

/** Today's stored seconds + the live timer, shown with the highlighter mark. */
function updateTodayTotal() {
  const live = Timer.t ? Math.floor(Timer.elapsedMs() / 1000) : 0;
  $('#today-total').textContent = fmtDur(Stats.daySec(todayKey()) + live);
}

/* ═══ 13. Charts ═════════════════════════════════════════════════════════
   Thin wrapper over Chart.js. Every chart is destroyed and rebuilt on
   render so colours always follow the current theme/palette; instances
   are tracked in a registry to avoid canvas reuse errors and leaks.      */

const Charts = {
  reg: new Map(),

  ok() { return typeof window.Chart !== 'undefined'; },
  cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); },
  accent() { return this.cssVar('--accent') || '#5457e0'; },

  destroy(id) {
    const c = this.reg.get(id);
    if (c) { c.destroy(); this.reg.delete(id); }
  },

  make(id, cfg) {
    const canvas = document.getElementById(id);
    if (!canvas) return null;
    this.destroy(id);
    if (!this.ok()) { this.offlineNote(canvas); return null; }
    const chart = new Chart(canvas.getContext('2d'), cfg);
    this.reg.set(id, chart);
    return chart;
  },

  offlineNote(canvas) {
    const box = canvas.closest('.chart-box');
    if (box && !box.querySelector('.chart-offline')) {
      const d = el('div', 'chart-empty chart-offline');
      d.style.inset = '0';
      d.innerHTML = '<p>Charts load from the Chart.js CDN — reconnect to the internet and refresh to see them.</p>';
      box.appendChild(d);
    }
  },

  tooltipBase() {
    return {
      backgroundColor: this.cssVar('--text') || '#171b2d',
      titleColor: this.cssVar('--text-invert') || '#fff',
      bodyColor: this.cssVar('--text-invert') || '#fff',
      padding: 10, cornerRadius: 9, displayColors: false,
      titleFont: { family: 'Instrument Sans, sans-serif', weight: '600' },
      bodyFont: { family: 'Instrument Sans, sans-serif' }
    };
  },

  /** Shared cartesian options (y axis in hours). */
  axesOpts(durTooltip = true) {
    const tickColor = this.cssVar('--text-3') || '#8b91a5';
    return {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 650, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: Object.assign(this.tooltipBase(), durTooltip ? {
          callbacks: { label: ctx => ' ' + fmtDur((ctx.parsed.y || 0) * 3600) }
        } : {})
      },
      scales: {
        x: { grid: { display: false }, border: { display: false }, ticks: { color: tickColor, font: { size: 11, family: 'Instrument Sans, sans-serif' }, maxRotation: 0, autoSkipPadding: 8 } },
        y: { beginAtZero: true, grid: { color: 'rgba(128,138,160,0.16)' }, border: { display: false }, ticks: { color: tickColor, font: { size: 11, family: 'Instrument Sans, sans-serif' }, callback: v => v + 'h' } }
      }
    };
  },

  gradientFill(hex) {
    return ctx => {
      const { chart } = ctx;
      const area = chart.chartArea;
      if (!area) return hexToRgba(hex, 0.12);
      const g = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
      g.addColorStop(0, hexToRgba(hex, 0.28));
      g.addColorStop(1, hexToRgba(hex, 0));
      return g;
    };
  }
};

const hoursOf = sec => +((sec || 0) / 3600).toFixed(2);

/* ═══ 14. Dashboard ══════════════════════════════════════════════════════ */

let mainRange = 'daily';

function renderDashboard() {
  renderGreeting();
  updateTodayTotal();
  renderWeekCard();
  renderMonthCard();
  renderMainChart();
  renderPieChart();
  renderRecent();
  Timer.syncUI();
}

function renderGreeting() {
  const h = londonParts(Date.now()).h;
  const g = h < 5 ? 'Late-night session?' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : h < 21 ? 'Good evening' : 'Good night';
  $('#greeting').textContent = g;
  $('#date-line').textContent = fmtFullDate(Date.now());
}

function renderWeekCard() {
  const start = Stats.weekStartKey;
  const total = Stats.weekSec(start);
  const targetSec = Store.data.settings.weeklyTargetHours * 3600;
  const pct = targetSec > 0 ? Math.round((total / targetSec) * 100) : 0;

  $('#week-hours').textContent = fmtHours(total);
  $('#week-target-label').textContent = targetSec > 0 ? `of ${fmtHours(targetSec)} target` : 'no weekly target set';
  $('#week-percent').textContent = pct + '%';
  $('#week-progress-fill').style.width = clamp(pct, 0, 100) + '%';
  $('#week-progressbar').setAttribute('aria-valuenow', clamp(pct, 0, 100));

  const wrap = $('#week-days');
  wrap.innerHTML = '';
  const tk = todayKey();
  const days = [];
  let max = Store.data.settings.dailyTargetHours * 3600;
  for (let i = 0; i < 7; i++) {
    const k = addDaysKey(start, i);
    const v = Stats.daySec(k);
    days.push({ k, v });
    max = Math.max(max, v);
  }
  if (max <= 0) max = 3600;
  for (const { k, v } of days) {
    const d = el('div', 'wd' + (k === tk ? ' is-today' : ''));
    const hPct = v > 0 ? clamp((v / max) * 100, 7, 100) : 0;
    d.innerHTML = `
      <div class="wd-bar-track"><div class="wd-bar" style="height:${hPct}%"></div></div>
      <span class="wd-name">${WD_MIN[weekdayOfKey(k)]}</span>
      <span class="wd-val">${v > 0 ? fmtDurShort(v) : '·'}</span>`;
    d.title = `${fmtDayShort(k)} — ${v > 0 ? fmtDur(v) : 'no revision'}`;
    wrap.appendChild(d);
  }
}

function renderMonthCard() {
  const prefix = Stats.monthPrefix;
  const { y, m, d } = keyParts(todayKey());
  const total = Stats.byMonth.get(prefix) || 0;

  $('#month-name').textContent = `${MONTHS[m - 1]} ${y}`;
  $('#month-hours').textContent = fmtHours(total);
  $('#month-avg').textContent = fmtDur(total / d);

  let count = 0;
  for (const s of Store.data.sessions) if (dateKeyOf(s.start).startsWith(prefix)) count++;
  $('#month-count').textContent = String(count);

  let bestKey = null, bestVal = 0;
  for (const [k, v] of Stats.byDay) if (k.startsWith(prefix) && v > bestVal) { bestVal = v; bestKey = k; }
  const bestEl = $('#month-best');
  bestEl.textContent = bestKey ? `${keyParts(bestKey).d} ${MONTHS_SHORT[m - 1]}` : '—';
  bestEl.title = bestKey ? `${fmtDayShort(bestKey)} — ${fmtDur(bestVal)}` : '';
}

function renderMainChart() {
  const empty = Stats.totalSec === 0;
  $('#chart-main-empty').hidden = !empty;
  if (empty) { Charts.destroy('chart-main'); return; }

  const acc = Charts.accent();
  let labels = [], values = [], type = 'bar';

  if (mainRange === 'daily') {
    type = 'line';
    const tk = todayKey();
    for (let i = 13; i >= 0; i--) {
      const k = addDaysKey(tk, -i);
      labels.push(`${WD_MIN[weekdayOfKey(k)]} ${keyParts(k).d}`);
      values.push(hoursOf(Stats.daySec(k)));
    }
  } else if (mainRange === 'weekly') {
    for (let i = 7; i >= 0; i--) {
      const startK = addDaysKey(Stats.weekStartKey, -7 * i);
      const p = keyParts(startK);
      labels.push(`${p.d} ${MONTHS_SHORT[p.m - 1]}`);
      values.push(hoursOf(Stats.weekSec(startK)));
    }
  } else {
    const { y, m } = keyParts(todayKey());
    for (let i = 5; i >= 0; i--) {
      const dt = new Date(Date.UTC(y, m - 1 - i, 1));
      const mk = `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}`;
      labels.push(MONTHS_SHORT[dt.getUTCMonth()]);
      values.push(hoursOf(Stats.byMonth.get(mk)));
    }
  }

  const dataset = type === 'line'
    ? {
        data: values, borderColor: acc, backgroundColor: Charts.gradientFill(acc),
        fill: true, tension: 0.35, borderWidth: 2.5,
        pointRadius: 3, pointHoverRadius: 5, pointBackgroundColor: acc, pointBorderColor: acc
      }
    : { data: values, backgroundColor: acc, hoverBackgroundColor: acc, borderRadius: 7, maxBarThickness: 36 };

  Charts.make('chart-main', { type, data: { labels, datasets: [dataset] }, options: Charts.axesOpts() });
}

function renderPieChart() {
  const shares = Store.data.subjects
    .map(sub => ({ sub, sec: (Stats.bySubject.get(sub.id) || {}).total || 0 }))
    .filter(x => x.sec > 0)
    .sort((a, b) => b.sec - a.sec);

  const legend = $('#pie-legend');
  const empty = shares.length === 0;
  $('#chart-pie-empty').hidden = !empty;
  legend.innerHTML = '';
  if (empty) { Charts.destroy('chart-pie'); return; }

  const totalSec = shares.reduce((a, x) => a + x.sec, 0);
  legend.innerHTML = shares.map(({ sub, sec }) => `
    <li>
      <i class="dot" style="background:${escapeHtml(sub.color)}"></i>
      <span class="name">${escapeHtml(sub.name)}</span>
      <span class="pct">${Math.round((sec / totalSec) * 100)}%<span class="amt">${fmtDurShort(sec)}</span></span>
    </li>`).join('');

  Charts.make('chart-pie', {
    type: 'pie',
    data: {
      labels: shares.map(x => x.sub.name),
      datasets: [{
        data: shares.map(x => x.sec),
        backgroundColor: shares.map(x => x.sub.color),
        borderColor: Charts.cssVar('--surface') || '#fff',
        borderWidth: 2, hoverOffset: 8
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 700, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: Object.assign(Charts.tooltipBase(), {
          callbacks: {
            label: ctx => ` ${fmtDur(ctx.parsed)} · ${Math.round((ctx.parsed / totalSec) * 100)}%`
          }
        })
      }
    }
  });
}

function renderRecent() {
  const list = $('#recent-list');
  list.innerHTML = '';
  const recent = Stats.sorted.slice(0, 6);

  if (!recent.length) {
    const li = el('li', 'empty');
    const hasSubjects = Store.data.subjects.length > 0;
    li.innerHTML = `
      <span>${hasSubjects
        ? 'No sessions yet. Start the timer or add time manually — your history builds here.'
        : 'Welcome! Add your subjects first, then start timing your revision.'}</span>
      <button class="btn btn-primary btn-small" id="empty-cta">${hasSubjects ? 'Start your first session' : 'Add your subjects'}</button>`;
    list.appendChild(li);
    $('#empty-cta').addEventListener('click', () => hasSubjects ? Timer.openStartModal() : Router.go('setup'));
    return;
  }

  for (const s of recent) {
    const li = el('li');
    const col = sessionColor(s);
    const dayK = dateKeyOf(s.start);
    const btn = el('button', 'session-item');
    btn.type = 'button';
    btn.innerHTML = `
      <span class="bar" style="background:${escapeHtml(col)}"></span>
      <span class="si-main">
        <span class="si-top">
          <span class="si-subject">${escapeHtml(subjectName(s.subjectId))}</span>
          ${s.title ? `<span class="si-title">${escapeHtml(s.title)}</span>` : ''}
        </span>
        <span class="si-times">${fmtDayShort(dayK)} · ${fmtTimeOfDay(s.start)}–${fmtTimeOfDay(s.end)}${s.start > Date.now() ? ' · planned' : ''}</span>
        ${s.notes ? `<span class="si-notes">${escapeHtml(s.notes)}</span>` : ''}
      </span>
      <span class="si-dur">${fmtDur(s.duration)}</span>`;
    btn.setAttribute('aria-label', `Open session: ${subjectName(s.subjectId)}, ${fmtDayShort(dayK)}, ${fmtDur(s.duration)}`);
    btn.addEventListener('click', () => openSessionModal({ session: s }));
    li.appendChild(btn);
    list.appendChild(li);
  }
}

/* ═══ 15. Calendar ═══════════════════════════════════════════════════════ */

const Cal = {
  weekStart: null,     // date key of the first visible day
  _nowEl: null,
  _scrolledOnce: false,
  _justDragged: false,

  ensure() { if (!this.weekStart) this.weekStart = weekStartOf(todayKey()); },

  go(deltaWeeks) {
    this.ensure();
    this.weekStart = addDaysKey(this.weekStart, deltaWeeks * 7);
    this.render();
  },

  goToday() {
    this.weekStart = weekStartOf(todayKey());
    this.render(true);
  },

  render(scrollToNow = false) {
    this.ensure();
    // Keep the visible week aligned if the first-day-of-week setting changed.
    this.weekStart = weekStartOf(this.weekStart);

    const endKey = addDaysKey(this.weekStart, 6);
    $('#cal-range').textContent = fmtRange(this.weekStart, endKey);

    const grid = $('#cal-grid');
    grid.innerHTML = '';
    this._nowEl = null;

    // Hour gutter
    const gutter = el('div', 'cal-timegutter');
    let gutterHtml = '<div class="cal-gutter-head" aria-hidden="true"></div><div class="cal-gutter-body">';
    for (let h = 1; h < 24; h++) gutterHtml += `<span class="cal-hour-label" style="top:${h * HOUR_H}px">${pad2(h)}:00</span>`;
    gutterHtml += '</div>';
    gutter.innerHTML = gutterHtml;
    grid.appendChild(gutter);

    const tk = todayKey();
    const nowMs = Date.now();

    for (let i = 0; i < 7; i++) {
      const k = addDaysKey(this.weekStart, i);
      const day = el('div', 'cal-day' + (k === tk ? ' is-today' : ''));
      const daySec = Stats.daySec(k);

      const head = el('div', 'cal-day-head');
      head.innerHTML = `
        <span class="d-name">${WD_SHORT[weekdayOfKey(k)]}</span>
        <span class="d-num">${keyParts(k).d}</span>
        <span class="d-total">${daySec > 0 ? fmtDur(daySec) : '\u00a0'}</span>`;
      day.appendChild(head);

      const body = el('div', 'cal-day-body');
      body.dataset.key = k;
      body.setAttribute('aria-label', `${fmtDayShort(k)} — click an empty space to plan a block`);

      // Blocks for this day (bucketed by their London start date)
      const blocks = Store.data.sessions
        .filter(s => dateKeyOf(s.start) === k)
        .sort((a, b) => a.start - b.start);

      // Simple lane packing so overlapping blocks sit side by side.
      const laneEnds = [];
      let laneCount = 1;
      const placed = blocks.map(s => {
        const startMin = minutesIntoDay(s.start);
        const wallMin = Math.max(1, (s.end - s.start) / 60000);
        const endMin = Math.min(1440, startMin + wallMin);
        let lane = 0;
        while (lane < laneEnds.length && laneEnds[lane] > startMin + 0.5) lane++;
        laneEnds[lane] = endMin;
        laneCount = Math.max(laneCount, lane + 1);
        return { s, startMin, endMin, lane };
      });

      for (const p of placed) {
        const col = sessionColor(p.s);
        const planned = p.s.start > nowMs;
        const b = el('button', 'cal-block' + (planned ? ' is-planned' : ''));
        b.type = 'button';
        b.dataset.id = p.s.id;
        const w = 100 / laneCount;
        b.style.top = `${(p.startMin / 60) * HOUR_H}px`;
        b.style.height = `${Math.max(24, ((p.endMin - p.startMin) / 60) * HOUR_H - 2)}px`;
        b.style.left = `calc(${(p.lane * w).toFixed(3)}% + 3px)`;
        b.style.width = `calc(${w.toFixed(3)}% - 6px)`;
        b.style.background = hexToRgba(col, 0.16);
        b.style.borderLeftColor = col;
        if (planned) b.style.borderColor = hexToRgba(col, 0.55);
        b.style.borderLeftColor = col;
        b.setAttribute('aria-label',
          `${sessionLabel(p.s)}, ${fmtTimeOfDay(p.s.start)} to ${fmtTimeOfDay(p.s.end)}, ${fmtDur(p.s.duration)}${planned ? ', planned' : ''}`);
        b.innerHTML = `
          <div class="cb-title">${escapeHtml(sessionLabel(p.s))}</div>
          <div class="cb-time">${fmtTimeOfDay(p.s.start)}–${fmtTimeOfDay(p.s.end)} · ${fmtDur(p.s.duration)}</div>`;
        body.appendChild(b);
      }

      if (k === tk) {
        const now = el('div', 'cal-now');
        now.style.top = `${(minutesIntoDay(nowMs) / 60) * HOUR_H}px`;
        body.appendChild(now);
        this._nowEl = now;
      }

      day.appendChild(body);
      grid.appendChild(day);
    }

    const scroller = $('#cal-scroll');
    if (scrollToNow && this._nowEl) {
      requestAnimationFrame(() => { scroller.scrollTop = Math.max(0, (minutesIntoDay(Date.now()) / 60) * HOUR_H - 170); });
    } else if (!this._scrolledOnce) {
      this._scrolledOnce = true;
      requestAnimationFrame(() => { scroller.scrollTop = 7 * HOUR_H; });
    }
  },

  bind() {
    $('#cal-prev').addEventListener('click', () => this.go(-1));
    $('#cal-next').addEventListener('click', () => this.go(1));
    $('#cal-today').addEventListener('click', () => this.goToday());
    $('#cal-add').addEventListener('click', () => {
      this.ensure();
      const tk = todayKey();
      const inWeek = tk >= this.weekStart && tk <= addDaysKey(this.weekStart, 6);
      openSessionModal({ prefill: { dateKey: inWeek ? tk : this.weekStart, startMin: inWeek ? undefined : 9 * 60 } });
    });

    const grid = $('#cal-grid');

    // Click: open a block, or plan a new one in an empty slot.
    grid.addEventListener('click', e => {
      if (this._justDragged) { this._justDragged = false; return; }
      const blockEl = e.target.closest('.cal-block');
      if (blockEl) {
        const s = Store.data.sessions.find(x => x.id === blockEl.dataset.id);
        if (s) openSessionModal({ session: s });
        return;
      }
      const body = e.target.closest('.cal-day-body');
      if (body && e.target === body) {
        const startMin = clamp(Math.floor((e.offsetY / HOUR_H) * 60 / 30) * 30, 0, 1410);
        openSessionModal({ prefill: { dateKey: body.dataset.key, startMin } });
      }
    });

    this.bindDrag(grid);
  },

  /** Mouse drag to move a block to another time/day (15-minute snapping).
      Touch devices use the edit dialog instead so scrolling stays natural. */
  bindDrag(grid) {
    let drag = null;

    grid.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      const blockEl = e.target.closest('.cal-block');
      if (!blockEl) return;
      const session = Store.data.sessions.find(s => s.id === blockEl.dataset.id);
      if (!session) return;
      drag = {
        session, blockEl,
        startX: e.clientX, startY: e.clientY,
        offsetY: e.clientY - blockEl.getBoundingClientRect().top,
        moved: false, ghost: null, line: null, target: null,
        bodies: $$('.cal-day-body', grid)
      };
    });

    window.addEventListener('pointermove', e => {
      if (!drag) return;
      if (!drag.moved) {
        if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 5) return;
        drag.moved = true;
        document.body.classList.add('is-dragging-block');
        drag.blockEl.classList.add('is-dragging');

        const g = el('div', 'cal-ghost');
        g.textContent = sessionLabel(drag.session);
        g.style.background = Charts.cssVar('--surface') || '#fff';
        g.style.borderLeftColor = sessionColor(drag.session);
        document.body.appendChild(g);
        drag.ghost = g;
        drag.line = el('div', 'cal-drop-line');
      }
      e.preventDefault();

      drag.ghost.style.left = `${e.clientX + 14}px`;
      drag.ghost.style.top = `${e.clientY + 12}px`;

      let targetBody = null;
      for (const b of drag.bodies) {
        const r = b.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX < r.right) { targetBody = b; break; }
      }
      if (!targetBody) {
        if (drag.line.parentElement) drag.line.remove();
        drag.target = null;
        return;
      }
      const rect = targetBody.getBoundingClientRect();
      const durMin = (drag.session.end - drag.session.start) / 60000;
      let min = ((e.clientY - rect.top - drag.offsetY) / HOUR_H) * 60;
      min = clamp(Math.round(min / 15) * 15, 0, Math.max(0, 1440 - Math.ceil(durMin)));
      drag.target = { key: targetBody.dataset.key, min };
      drag.line.style.top = `${(min / 60) * HOUR_H}px`;
      drag.line.dataset.time = minToHM(min);
      if (drag.line.parentElement !== targetBody) targetBody.appendChild(drag.line);
    });

    window.addEventListener('pointerup', () => {
      if (!drag) return;
      const d = drag;
      drag = null;
      document.body.classList.remove('is-dragging-block');
      if (d.ghost) d.ghost.remove();
      if (d.line) d.line.remove();
      d.blockEl.classList.remove('is-dragging');
      if (!d.moved) return;              // treated as a plain click
      this._justDragged = true;

      if (d.target) {
        const s = d.session;
        const wall = s.end - s.start;
        const newStart = epochFromKeyTime(d.target.key, minToHM(d.target.min));
        if (newStart !== s.start) {
          updateSession(s.id, {
            start: newStart,
            end: newStart + wall,
            duration: s.manual ? Math.round(wall / 1000) : s.duration
          });
          Toast.show(`Moved to ${fmtDayShort(d.target.key)}, ${minToHM(d.target.min)}`);
        }
      }
    });

    window.addEventListener('pointercancel', () => {
      if (!drag) return;
      const d = drag;
      drag = null;
      document.body.classList.remove('is-dragging-block');
      if (d.ghost) d.ghost.remove();
      if (d.line) d.line.remove();
      d.blockEl.classList.remove('is-dragging');
    });
  }
};

/* ═══ 16. Statistics view ════════════════════════════════════════════════ */

/** Inclusive day count between two date keys. */
function daysBetweenKeys(a, b) {
  const ms = epochFromKeyTime(b, '12:00') - epochFromKeyTime(a, '12:00');
  return Math.round(ms / 86400000) + 1;
}

function renderStats() {
  const n = Store.data.sessions.length;
  $('#stats-sub').textContent = n
    ? `Since ${fmtFullDate(epochFromKeyTime(Stats.firstKey, '12:00'))} · ${n} session${n === 1 ? '' : 's'} logged`
    : 'Log your first session and this page comes alive.';

  renderStatTiles();
  renderStatCharts();
  renderHeatmap();
  renderSubjectTable();
}

function renderStatTiles() {
  const tk = todayKey();
  const total = Stats.totalSec;
  const count = Store.data.sessions.length;
  const span = Stats.firstKey ? daysBetweenKeys(Stats.firstKey, tk) : 0;
  const activeDays = [...Stats.byDay.values()].filter(v => v > 0).length;
  const st = Stats.streaks();

  // Most / least revised subject (among subjects with any time logged).
  const ranked = Store.data.subjects
    .map(s => ({ s, t: (Stats.bySubject.get(s.id) || { total: 0 }).total }))
    .filter(x => x.t > 0)
    .sort((a, b) => b.t - a.t);
  const most = ranked[0] || null;
  const least = ranked.length > 1 ? ranked[ranked.length - 1] : null;

  // Busiest weekday.
  let bwIdx = -1, bwSec = 0;
  Stats.byWeekday.forEach((sec, i) => { if (sec > bwSec) { bwSec = sec; bwIdx = i; } });

  const L = Stats.longest, S = Stats.shortest;
  const sessExtra = s => s ? `${subjectName(s.subjectId)} · ${fmtDayShort(dateKeyOf(s.start))}` : '';

  const tiles = [
    { label: 'Total revision', value: total ? fmtDur(total) : '0m', extra: `${count} session${count === 1 ? '' : 's'} logged` },
    { label: 'Current streak', value: `${st.current} day${st.current === 1 ? '' : 's'}`, extra: 'consecutive days revised', cls: st.current > 0 ? 'is-streak' : '' },
    { label: 'Longest streak', value: `${st.longest} day${st.longest === 1 ? '' : 's'}`, extra: 'your best run so far' },
    { label: 'Active days', value: String(activeDays), extra: span ? `of ${span} day${span === 1 ? '' : 's'} tracked` : 'no days tracked yet' },
    { label: 'Daily average', value: span ? fmtDur(Math.round(total / span)) : '—', extra: 'across all tracked days' },
    { label: 'Weekly average', value: span ? fmtDur(Math.round(total / (span / 7))) : '—', extra: 'across all tracked weeks' },
    { label: 'Average session', value: count ? fmtDur(Math.round(total / count)) : '—', extra: 'per session' },
    { label: 'Longest session', value: L ? fmtDur(L.duration) : '—', extra: sessExtra(L) },
    { label: 'Shortest session', value: S ? fmtDur(S.duration) : '—', extra: sessExtra(S) },
    { label: 'Most revised', value: most ? most.s.name : '—', extra: most ? fmtDur(most.t) + ' overall' : 'nothing logged yet' },
    { label: 'Least revised', value: least ? least.s.name : '—', extra: least ? fmtDur(least.t) + ' overall' : 'needs two subjects with time' },
    { label: 'Busiest weekday', value: bwIdx > -1 ? WD_LONG[bwIdx] : '—', extra: bwIdx > -1 ? fmtDur(bwSec) + ' overall' : 'no pattern yet' }
  ];

  $('#stat-tiles').innerHTML = tiles.map(t => `
    <div class="stat-tile${t.cls ? ' ' + t.cls : ''}">
      <div class="t-label">${t.label}</div>
      <div class="t-value">${escapeHtml(t.value)}</div>
      ${t.extra ? `<div class="t-extra">${escapeHtml(t.extra)}</div>` : ''}
    </div>`).join('');
}

/** Show/hide a "nothing here yet" overlay on a chart box. */
function chartEmptyOverlay(canvasId, show, msg) {
  const canvas = document.getElementById(canvasId);
  const box = canvas && canvas.closest('.chart-box');
  if (!box) return;
  box.style.position = 'relative';
  let ov = box.querySelector('.chart-empty:not(.chart-offline)');
  if (show) {
    if (!ov) { ov = el('div', 'chart-empty'); ov.style.inset = '0'; box.appendChild(ov); }
    ov.innerHTML = `<p>${msg}</p>`;
    ov.hidden = false;
  } else if (ov) {
    ov.hidden = true;
  }
}

function renderStatCharts() {
  const accent = Charts.accent();
  const tk = todayKey();
  const fdw = Store.data.settings.firstDayOfWeek;

  /* Hours by weekday — reordered so the chart starts on the user's first day. */
  {
    const labels = [], values = [];
    for (let i = 0; i < 7; i++) {
      const wd = (fdw + i) % 7;
      labels.push(WD_SHORT[wd]);
      values.push(hoursOf(Stats.byWeekday[wd]));
    }
    Charts.make('chart-weekday', {
      type: 'bar',
      data: { labels, datasets: [{ data: values, backgroundColor: hexToRgba(accent, 0.82), hoverBackgroundColor: accent, borderRadius: 7, maxBarThickness: 36 }] },
      options: Charts.axesOpts()
    });
  }

  /* Hours by month — the last twelve months. */
  {
    const { y, m } = keyParts(tk);
    const labels = [], values = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(y, m - 1 - i, 1));
      const mk = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
      labels.push(`${MONTHS_SHORT[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`);
      values.push(hoursOf(Stats.byMonth.get(mk)));
    }
    Charts.make('chart-months', {
      type: 'bar',
      data: { labels, datasets: [{ data: values, backgroundColor: hexToRgba(accent, 0.82), hoverBackgroundColor: accent, borderRadius: 7, maxBarThickness: 36 }] },
      options: Charts.axesOpts()
    });
  }

  /* Hours by year. */
  {
    let keys = [...Stats.byYear.keys()].sort();
    if (!keys.length) keys = [tk.slice(0, 4)];
    Charts.make('chart-years', {
      type: 'bar',
      data: { labels: keys, datasets: [{ data: keys.map(k => hoursOf(Stats.byYear.get(k))), backgroundColor: hexToRgba(accent, 0.82), hoverBackgroundColor: accent, borderRadius: 7, maxBarThickness: 52 }] },
      options: Charts.axesOpts()
    });
  }

  /* 7-day rolling average over the last 60 days. */
  {
    const labels = [], values = [];
    for (let i = 59; i >= 0; i--) {
      const k = addDaysKey(tk, -i);
      let sum = 0;
      for (let j = 0; j < 7; j++) sum += Stats.daySec(addDaysKey(k, -j));
      const { d, m: mm } = keyParts(k);
      labels.push(`${d} ${MONTHS_SHORT[mm - 1]}`);
      values.push(hoursOf(sum / 7));
    }
    Charts.make('chart-trend', {
      type: 'line',
      data: { labels, datasets: [{ data: values, borderColor: accent, borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 4, pointBackgroundColor: accent, tension: 0.35, fill: true, backgroundColor: Charts.gradientFill(accent) }] },
      options: Charts.axesOpts()
    });
  }

  /* Doughnut — this month, by subject. */
  {
    const parts = Store.data.subjects
      .map(sub => ({ sub, sec: (Stats.bySubject.get(sub.id) || { month: 0 }).month }))
      .filter(x => x.sec > 0)
      .sort((a, b) => b.sec - a.sec);
    const monthTotal = parts.reduce((t, x) => t + x.sec, 0);

    chartEmptyOverlay('chart-doughnut', !parts.length, 'Nothing logged this month yet.');
    if (!parts.length) { Charts.destroy('chart-doughnut'); }
    else {
      const secs = parts.map(x => x.sec);
      Charts.make('chart-doughnut', {
        type: 'doughnut',
        data: {
          labels: parts.map(x => x.sub.name),
          datasets: [{ data: secs.map(hoursOf), backgroundColor: parts.map(x => x.sub.color), borderColor: Charts.cssVar('--surface') || '#fff', borderWidth: 3, hoverOffset: 5 }]
        },
        options: {
          responsive: true, maintainAspectRatio: false, cutout: '62%',
          animation: { duration: 650, easing: 'easeOutQuart' },
          plugins: {
            legend: {
              position: 'bottom',
              labels: { color: Charts.cssVar('--text-2') || '#555b70', usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, padding: 14, font: { family: 'Instrument Sans, sans-serif', size: 12 } }
            },
            tooltip: Object.assign(Charts.tooltipBase(), {
              callbacks: { label: ctx => ` ${fmtDur(secs[ctx.dataIndex])} · ${Math.round(secs[ctx.dataIndex] / monthTotal * 100)}%` }
            })
          }
        }
      });
    }
  }
}

function renderHeatmap() {
  const wrap = $('#heatmap');
  const tk = todayKey();
  const start = weekStartOf(addDaysKey(tk, -370));
  const endExclusive = addDaysKey(weekStartOf(tk), 7);    // pad out the final week
  const targetSec = Math.max(0.25, Store.data.settings.dailyTargetHours || 2) * 3600;

  const frag = document.createDocumentFragment();
  let k = start;
  while (k < endExclusive) {
    const cell = el('div', 'heat-cell');
    if (k > tk) {
      cell.classList.add('is-future');
    } else {
      const sec = Stats.daySec(k);
      if (sec > 0) {
        const r = sec / targetSec;
        cell.classList.add('l' + (r >= 1 ? 4 : r >= 0.66 ? 3 : r >= 0.33 ? 2 : 1));
      }
      cell.title = `${fmtDayShort(k)} — ${sec ? fmtDur(sec) : 'No revision'}`;
    }
    frag.appendChild(cell);
    k = addDaysKey(k, 1);
  }
  wrap.innerHTML = '';
  wrap.appendChild(frag);
  const scroller = wrap.parentElement;
  if (scroller) scroller.scrollLeft = scroller.scrollWidth;   // land on "now"
}

function renderSubjectTable() {
  const table = $('#subject-stats');
  const empty = $('#subject-stats-empty');
  const rows = Store.data.subjects
    .map(sub => ({ sub, a: Stats.bySubject.get(sub.id) }))
    .filter(x => x.a && x.a.count > 0);

  table.querySelector('tbody').innerHTML = rows.map(({ sub, a }) => `
    <tr>
      <td><span class="subj-cell"><span class="dot" style="background:${sub.color}"></span>${escapeHtml(sub.name)}</span></td>
      <td>${fmtDur(a.total)}</td>
      <td>${a.week ? fmtDurShort(a.week) : '—'}</td>
      <td>${a.month ? fmtDurShort(a.month) : '—'}</td>
      <td>${a.count}</td>
      <td>${fmtDurShort(Math.round(a.total / a.count))}</td>
      <td>${fmtDurShort(a.longest)}</td>
    </tr>`).join('');

  table.hidden = rows.length === 0;
  empty.hidden = rows.length > 0;
}

/* ═══ 17. Setup view ═════════════════════════════════════════════════════ */

const GRIP_SVG = '<svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="4.5" cy="2.5" r="1.4"/><circle cx="9.5" cy="2.5" r="1.4"/><circle cx="4.5" cy="7" r="1.4"/><circle cx="9.5" cy="7" r="1.4"/><circle cx="4.5" cy="11.5" r="1.4"/><circle cx="9.5" cy="11.5" r="1.4"/></svg>';
const UP_SVG = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M2.5 9 7 4.5 11.5 9l-1.06 1.06L7 6.62 3.56 10.06z"/></svg>';
const DOWN_SVG = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M11.5 5 7 9.5 2.5 5l1.06-1.06L7 7.38l3.44-3.44z"/></svg>';
const TRASH_SVG = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M5.2 1.6h3.6l.5 1.1h2.6v1.3H2.1V2.7h2.6l.5-1.1zM3.2 5.2h7.6l-.55 6.4a1.35 1.35 0 0 1-1.34 1.23H5.09a1.35 1.35 0 0 1-1.34-1.23L3.2 5.2z"/></svg>';

function renderSetup() {
  const s = Store.data.settings;
  const subs = Store.data.subjects;
  const list = $('#subject-list');

  if (!subs.length) {
    list.innerHTML = '<li class="search-none">No subjects yet — add your first one below.</li>';
  } else {
    list.innerHTML = subs.map(sub => {
      const total = (Stats.bySubject.get(sub.id) || { total: 0 }).total;
      return `
      <li class="subject-row" draggable="false" data-id="${sub.id}">
        <button class="drag-handle" type="button" aria-label="Drag to reorder ${escapeHtml(sub.name)}" title="Drag to reorder">${GRIP_SVG}</button>
        <input type="color" class="subject-color" value="${sub.color}" aria-label="Colour for ${escapeHtml(sub.name)}" title="Subject colour" />
        <input type="text" class="subject-name-input" value="${escapeHtml(sub.name)}" maxlength="60" aria-label="Rename ${escapeHtml(sub.name)}" />
        <span class="sr-total">${total ? fmtDurShort(total) : 'no time yet'}</span>
        <span class="sr-actions">
          <button class="mini-btn" type="button" data-act="up" aria-label="Move ${escapeHtml(sub.name)} up" title="Move up">${UP_SVG}</button>
          <button class="mini-btn" type="button" data-act="down" aria-label="Move ${escapeHtml(sub.name)} down" title="Move down">${DOWN_SVG}</button>
          <button class="mini-btn danger" type="button" data-act="del" aria-label="Delete ${escapeHtml(sub.name)}" title="Delete subject">${TRASH_SVG}</button>
        </span>
      </li>`;
    }).join('');
  }

  // Settings controls reflect stored values.
  $('#set-weekly-target').value = s.weeklyTargetHours;
  $('#set-daily-target').value = s.dailyTargetHours;
  $('#set-session-length').value = s.defaultSessionMinutes;
  $('#set-sound').value = s.sound;
  $('#set-theme').value = s.theme;
  $('#set-palette').value = s.palette;
  $('#set-fdw').value = String(s.firstDayOfWeek);
  $('#new-subject-color').value = SUBJECT_COLORS[subs.length % SUBJECT_COLORS.length];
}

/** One-time event wiring for the subject list (delegated — survives re-renders). */
function bindSubjectList() {
  const list = $('#subject-list');
  let dragId = null;

  // Only the grip starts a drag, so text selection in the name input still works.
  list.addEventListener('pointerdown', e => {
    const li = e.target.closest('.subject-row');
    if (li && e.target.closest('.drag-handle')) li.setAttribute('draggable', 'true');
  });
  list.addEventListener('pointerup', () => {
    list.querySelectorAll('.subject-row[draggable="true"]').forEach(li => li.setAttribute('draggable', 'false'));
  });

  list.addEventListener('change', e => {
    const li = e.target.closest('.subject-row');
    if (!li) return;
    const sub = Store.data.subjects.find(x => x.id === li.dataset.id);
    if (!sub) return;

    if (e.target.classList.contains('subject-color')) {
      sub.color = e.target.value;
      commit();
    } else if (e.target.classList.contains('subject-name-input')) {
      const name = e.target.value.trim();
      const clash = Store.data.subjects.some(x => x.id !== sub.id && x.name.toLowerCase() === name.toLowerCase());
      if (!name) {
        e.target.value = sub.name;
        Toast.show('Subject names can’t be blank');
      } else if (clash) {
        e.target.value = sub.name;
        Toast.show('You already have a subject with that name');
      } else if (name !== sub.name) {
        sub.name = name;
        commit();
      }
    }
  });

  list.addEventListener('click', async e => {
    const btn = e.target.closest('.mini-btn');
    const li = e.target.closest('.subject-row');
    if (!btn || !li) return;
    const subs = Store.data.subjects;
    const i = subs.findIndex(x => x.id === li.dataset.id);
    if (i < 0) return;
    const act = btn.dataset.act;

    if (act === 'up' && i > 0) {
      [subs[i - 1], subs[i]] = [subs[i], subs[i - 1]];
      commit();
    } else if (act === 'down' && i < subs.length - 1) {
      [subs[i + 1], subs[i]] = [subs[i], subs[i + 1]];
      commit();
    } else if (act === 'del') {
      const sub = subs[i];
      const owned = Store.data.sessions.filter(x => x.subjectId === sub.id);
      const ok = await Modal.confirm({
        title: `Delete “${sub.name}”?`,
        message: owned.length
          ? `This also deletes its ${owned.length} logged session${owned.length === 1 ? '' : 's'}. You can undo straight away.`
          : 'No sessions belong to it yet. You can undo straight away.',
        confirmLabel: 'Delete',
        danger: true
      });
      if (!ok) return;

      subs.splice(i, 1);
      Store.data.sessions = Store.data.sessions.filter(x => x.subjectId !== sub.id);
      commit();
      Toast.show(`Deleted “${sub.name}”`, {
        actionLabel: 'Undo',
        danger: true,
        onAction: () => {
          Store.data.subjects.splice(Math.min(i, Store.data.subjects.length), 0, sub);
          Store.data.sessions.push(...owned);
          commit();
        }
      });
    }
  });

  /* HTML5 drag-and-drop reordering. */
  list.addEventListener('dragstart', e => {
    const li = e.target.closest('.subject-row');
    if (!li) return;
    dragId = li.dataset.id;
    li.classList.add('is-drag');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', dragId); } catch { /* older engines */ }
  });
  list.addEventListener('dragover', e => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const li = e.target.closest('.subject-row');
    list.querySelectorAll('.subject-row.is-over').forEach(x => { if (x !== li) x.classList.remove('is-over'); });
    if (li && li.dataset.id !== dragId) li.classList.add('is-over');
  });
  list.addEventListener('drop', e => {
    e.preventDefault();
    const li = e.target.closest('.subject-row');
    if (li && dragId && li.dataset.id !== dragId) {
      const subs = Store.data.subjects;
      const from = subs.findIndex(x => x.id === dragId);
      const to = subs.findIndex(x => x.id === li.dataset.id);
      if (from > -1 && to > -1) {
        const [moved] = subs.splice(from, 1);
        subs.splice(to, 0, moved);
        commit();
      }
    }
    dragId = null;
  });
  list.addEventListener('dragend', () => { dragId = null; renderSetup(); });
}

/* ═══ 18. Import / export / erase ════════════════════════════════════════ */

function downloadFile(name, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function csvCell(v) {
  v = String(v ?? '');
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

function exportCSV() {
  if (!Store.data.sessions.length) { Toast.show('Nothing to export yet'); return; }
  const header = 'id,date,start_iso,end_iso,duration_seconds,subject,title,notes,colour';
  const lines = Store.data.sessions
    .slice()
    .sort((a, b) => a.start - b.start)
    .map(s => [
      s.id, dateKeyOf(s.start),
      new Date(s.start).toISOString(), new Date(s.end).toISOString(),
      s.duration, subjectName(s.subjectId), s.title || '', s.notes || '', s.color || ''
    ].map(csvCell).join(','));
  downloadFile(`revtrack-sessions-${todayKey()}.csv`, header + '\n' + lines.join('\n'), 'text/csv;charset=utf-8');
  Toast.show('CSV exported');
}

function exportJSON() {
  const payload = { app: 'RevTrack', exportedAt: new Date().toISOString(), ...Store.data };
  downloadFile(`revtrack-backup-${todayKey()}.json`, JSON.stringify(payload, null, 2), 'application/json');
  Toast.show('Backup downloaded');
}

/** Minimal, quote-aware CSV parser (handles commas, quotes and newlines in cells). */
function parseCSV(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else q = false;
      } else cur += c;
    } else if (c === '"') {
      q = true;
    } else if (c === ',') {
      row.push(cur); cur = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.length > 1 || row[0].trim() !== '') rows.push(row);
      row = [];
    } else {
      cur += c;
    }
  }
  row.push(cur);
  if (row.length > 1 || row[0].trim() !== '') rows.push(row);
  return rows;
}

function normDateKey(v) {
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad2(+m[2])}-${pad2(+m[3])}`;
  m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);          // UK-style DD/MM/YYYY
  if (m) return `${m[3]}-${pad2(+m[2])}-${pad2(+m[1])}`;
  return null;
}

function normTimeHM(v) {
  const m = v.match(/^(\d{1,2}):(\d{2})/);
  return m ? `${pad2(+m[1])}:${m[2]}` : null;
}

function importCSV(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) { Toast.show('That CSV has no data rows', { danger: true }); return; }

  const H = rows[0].map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const idx = (...names) => { for (const n of names) { const i = H.indexOf(n); if (i > -1) return i; } return -1; };
  const iId = idx('id'), iDate = idx('date'), iStartIso = idx('start_iso', 'startiso'), iEndIso = idx('end_iso', 'endiso');
  const iStart = idx('start', 'start_time'), iEnd = idx('end', 'end_time', 'finish');
  const iDurS = idx('duration_seconds', 'duration_secs', 'seconds'), iDurM = idx('duration_minutes', 'minutes', 'duration');
  const iSubj = idx('subject', 'subject_name'), iTitle = idx('title', 'session', 'name');
  const iNotes = idx('notes', 'note'), iCol = idx('colour', 'color');
  const cell = (row, i) => (i > -1 ? String(row[i] ?? '').trim() : '');

  const added = [];
  let skipped = 0, createdSubjects = 0;

  for (const row of rows.slice(1)) {
    if (row.every(c => !String(c).trim())) continue;

    // Subject: match by name (case-insensitive) or create on the fly.
    const subjName = cell(row, iSubj) || 'Imported';
    let sub = Store.data.subjects.find(x => x.name.toLowerCase() === subjName.toLowerCase());
    if (!sub) {
      sub = { id: uid(), name: subjName.slice(0, 60), color: SUBJECT_COLORS[(Store.data.subjects.length + createdSubjects) % SUBJECT_COLORS.length] };
      Store.data.subjects.push(sub);
      createdSubjects++;
    }

    // Start time: ISO wins, else date + start columns.
    let start = NaN;
    const iso = cell(row, iStartIso);
    if (iso) start = Date.parse(iso);
    if (!Number.isFinite(start)) {
      const dk = normDateKey(cell(row, iDate));
      const hm = normTimeHM(cell(row, iStart));
      if (dk && hm) start = epochFromKeyTime(dk, hm);
    }

    // Duration: explicit seconds/minutes, else derived from the end time.
    let dur = parseInt(cell(row, iDurS), 10);
    if (!Number.isFinite(dur) || dur <= 0) {
      const mins = parseFloat(cell(row, iDurM));
      if (Number.isFinite(mins) && mins > 0) dur = Math.round(mins * 60);
    }
    if ((!Number.isFinite(dur) || dur <= 0) && Number.isFinite(start)) {
      let end = NaN;
      const eIso = cell(row, iEndIso);
      if (eIso) end = Date.parse(eIso);
      if (!Number.isFinite(end)) {
        const dk = normDateKey(cell(row, iDate));
        const hm = normTimeHM(cell(row, iEnd));
        if (dk && hm) {
          end = epochFromKeyTime(dk, hm);
          if (end <= start) end += 86400000;             // overnight session
        }
      }
      if (Number.isFinite(end) && end > start) dur = Math.round((end - start) / 1000);
    }

    if (!Number.isFinite(start) || !Number.isFinite(dur) || dur <= 0 || dur > MAX_SESSION_SEC) { skipped++; continue; }

    let sid = cell(row, iId);
    if (!sid || Store.data.sessions.some(x => x.id === sid) || added.some(x => x.id === sid)) sid = uid();
    const col = cell(row, iCol);

    added.push({
      id: sid,
      subjectId: sub.id,
      title: cell(row, iTitle).slice(0, 120),
      notes: cell(row, iNotes),
      start,
      end: start + dur * 1000,
      duration: dur,
      color: /^#[0-9a-f]{6}$/i.test(col) ? col.toLowerCase() : null,
      manual: true
    });
  }

  if (!added.length) {
    Toast.show(`No usable rows found${skipped ? ` (${skipped} skipped)` : ''}`, { danger: true });
    return;
  }

  Store.data.sessions.push(...added);
  commit();
  Toast.show(`Imported ${added.length} session${added.length === 1 ? '' : 's'}${skipped ? ` · ${skipped} skipped` : ''}${createdSubjects ? ` · ${createdSubjects} new subject${createdSubjects === 1 ? '' : 's'}` : ''}`);
}

async function importJSON(text) {
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { Toast.show('That file isn’t valid JSON', { danger: true }); return; }

  const raw = parsed && typeof parsed === 'object'
    ? (Array.isArray(parsed.sessions) || Array.isArray(parsed.subjects) ? parsed : parsed.data)
    : null;
  if (!raw || typeof raw !== 'object') { Toast.show('That doesn’t look like a RevTrack backup', { danger: true }); return; }

  const nSess = Array.isArray(raw.sessions) ? raw.sessions.length : 0;
  const ok = await Modal.confirm({
    title: 'Restore this backup?',
    message: `Everything currently stored will be replaced with the backup (${nSess} session${nSess === 1 ? '' : 's'}). Export first if you want to keep what’s here now.`,
    confirmLabel: 'Restore',
    danger: true
  });
  if (!ok) return;

  Store.data = Store.normalise(raw);
  Theme.apply(false);
  Cal.weekStart = weekStartOf(todayKey());
  commit();
  Timer.syncUI();
  Toast.show(`Restored ${Store.data.sessions.length} session${Store.data.sessions.length === 1 ? '' : 's'} · ${Store.data.subjects.length} subject${Store.data.subjects.length === 1 ? '' : 's'}`);
}

function readImportFile(input, handler) {
  const f = input.files && input.files[0];
  if (!f) return;
  f.text()
    .then(txt => handler(txt))
    .catch(() => Toast.show('Couldn’t read that file', { danger: true }))
    .finally(() => { input.value = ''; });
}

async function clearAllData() {
  const first = await Modal.confirm({
    title: 'Erase everything?',
    message: 'All subjects, sessions and settings will be permanently deleted from this browser. Export a backup first if you might want them back.',
    confirmLabel: 'Erase',
    danger: true
  });
  if (!first) return;
  const second = await Modal.confirm({
    title: 'Last check',
    message: 'This really can’t be undone. Erase all RevTrack data?',
    confirmLabel: 'Yes, erase it all',
    danger: true
  });
  if (!second) return;

  Store.data = Store.normalise(null);
  Theme.apply(false);
  Cal.weekStart = weekStartOf(todayKey());
  commit();
  Timer.syncUI();
  Toast.show('Everything erased — fresh start');
}

/* ═══ 19. Global search ══════════════════════════════════════════════════ */

const Search = {
  input: null,
  panel: null,

  bind() {
    this.input = $('#global-search');
    this.panel = $('#search-panel');
    if (!this.input || !this.panel) return;

    this.input.addEventListener('input', debounce(() => this.run(), 140));
    this.input.addEventListener('focus', () => { if (this.input.value.trim()) this.run(); });
    this.input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') {
        const first = this.panel.querySelector('.search-item');
        if (first) { e.preventDefault(); first.focus(); }
      } else if (e.key === 'Escape') {
        this.hide();
        this.input.blur();
      }
    });

    this.panel.addEventListener('keydown', e => {
      const items = [...this.panel.querySelectorAll('.search-item')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' && i > -1 && i < items.length - 1) { e.preventDefault(); items[i + 1].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); i > 0 ? items[i - 1].focus() : this.input.focus(); }
      else if (e.key === 'Escape') { this.hide(); this.input.focus(); }
    });

    this.panel.addEventListener('click', e => {
      const btn = e.target.closest('.search-item');
      if (!btn) return;
      const s = Store.data.sessions.find(x => x.id === btn.dataset.id);
      this.hide();
      if (s) openSessionModal({ session: s });
    });

    document.addEventListener('pointerdown', e => {
      if (!e.target.closest('.search-wrap')) this.hide();
    });
  },

  run() {
    const q = this.input.value.trim().toLowerCase();
    if (!q) { this.hide(); return; }

    const out = [];
    for (const s of Stats.sorted) {
      const key = dateKeyOf(s.start);
      const hay = `${subjectName(s.subjectId)} ${s.title || ''} ${s.notes || ''} ${key} ${fmtDayShort(key)}`.toLowerCase();
      if (hay.includes(q)) {
        out.push(s);
        if (out.length >= 30) break;
      }
    }

    this.panel.innerHTML = out.length
      ? out.map(s => {
          const key = dateKeyOf(s.start);
          const title = s.title ? ' · ' + escapeHtml(s.title) : '';
          const notes = s.notes ? ' · ' + escapeHtml(s.notes.slice(0, 60)) : '';
          return `
          <button class="search-item" type="button" data-id="${s.id}">
            <span class="dot" style="background:${sessionColor(s)}"></span>
            <span class="s-main">
              <div class="s-title">${escapeHtml(subjectName(s.subjectId))}${title}</div>
              <div class="s-sub">${fmtDayShort(key)} · ${fmtTimeOfDay(s.start)}–${fmtTimeOfDay(s.end)}${notes}</div>
            </span>
            <span class="s-dur">${fmtDurShort(s.duration)}</span>
          </button>`;
        }).join('')
      : '<div class="search-none">No sessions match that.</div>';

    this.panel.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
  },

  hide() {
    if (!this.panel || this.panel.hidden) return;
    this.panel.hidden = true;
    this.panel.innerHTML = '';
    this.input.setAttribute('aria-expanded', 'false');
  }
};

/* ═══ 20. Keyboard shortcuts ═════════════════════════════════════════════ */

function openShortcutsModal() {
  const rows = [
    ['Focus search', ['/']],
    ['Dashboard · Calendar · Stats · Setup', ['1', '2', '3', '4']],
    ['Start, pause or resume the timer', ['S']],
    ['Finish the running session', ['F']],
    ['Add time manually', ['M']],
    ['Toggle light / dark', ['T']],
    ['Previous / next week (calendar)', ['P', 'N']],
    ['Close dialogs', ['Esc']],
    ['This cheatsheet', ['?']]
  ];
  Modal.open(`
    <div class="modal-head">
      <h3 class="modal-title">Keyboard shortcuts</h3>
      <button class="modal-close" aria-label="Close">${CLOSE_X_SVG}</button>
    </div>
    <div class="modal-body">
      <div class="kbd-list">
        ${rows.map(([desc, keys]) => `
          <div class="kbd-row"><span>${desc}</span><span>${keys.map(k => `<kbd>${k}</kbd>`).join(' ')}</span></div>
        `).join('')}
      </div>
    </div>`, { narrow: true });
}

/** Start the timer, nudging towards Setup if there are no subjects yet. */
function startTimerFlow() {
  Timer.openStartModal();
}

function bindShortcuts() {
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') return;                        // modal + search handle their own
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (Modal.isOpen()) return;

    switch (e.key) {
      case '/': e.preventDefault(); $('#global-search').focus(); break;
      case '?': openShortcutsModal(); break;
      case '1': Router.go('dashboard'); break;
      case '2': Router.go('calendar'); break;
      case '3': Router.go('stats'); break;
      case '4': Router.go('setup'); break;
      case 't': case 'T': $('#theme-toggle').click(); break;
      case 'm': case 'M': openSessionModal({}); break;
      case 's': case 'S': {
        const tm = Store.data.timer;
        if (!tm) startTimerFlow();
        else if (tm.resumedAt) Timer.pause();
        else Timer.resume();
        break;
      }
      case 'f': case 'F': if (Store.data.timer) Timer.finish(); break;
      case 'n': case 'N': if (currentView === 'calendar') Cal.go(1); break;
      case 'p': case 'P': if (currentView === 'calendar') Cal.go(-1); break;
    }
  });

  $('#shortcuts-btn').addEventListener('click', openShortcutsModal);
}

/* ═══ 21. Router ═════════════════════════════════════════════════════════ */

const VIEWS = ['dashboard', 'calendar', 'stats', 'setup'];
let currentView = 'dashboard';

const Router = {
  go(view) {
    if (!VIEWS.includes(view)) view = 'dashboard';
    currentView = view;

    $$('.view').forEach(v => v.classList.toggle('is-active', v.id === 'view-' + view));
    $$('.nav-btn').forEach(b => {
      const on = b.dataset.view === view;
      b.classList.toggle('is-active', on);
      if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });

    history.replaceState(null, '', '#/' + view);
    renderActiveView();
  },

  init() {
    $$('.nav-btn').forEach(b => b.addEventListener('click', () => this.go(b.dataset.view)));
    window.addEventListener('hashchange', () => {
      const v = location.hash.replace(/^#\//, '');
      if (VIEWS.includes(v) && v !== currentView) this.go(v);
    });
    const initial = location.hash.replace(/^#\//, '');
    this.go(VIEWS.includes(initial) ? initial : 'dashboard');
  }
};

function renderActiveView() {
  if (currentView === 'dashboard') renderDashboard();
  else if (currentView === 'calendar') Cal.render();
  else if (currentView === 'stats') renderStats();
  else renderSetup();
}

/* ═══ 22. One-time bindings ══════════════════════════════════════════════ */

function bindStatic() {
  /* Dashboard: timer + manual entry. */
  $('#btn-start').addEventListener('click', startTimerFlow);
  $('#btn-pause').addEventListener('click', () => Timer.pause());
  $('#btn-resume').addEventListener('click', () => Timer.resume());
  $('#btn-finish').addEventListener('click', () => Timer.finish());
  $('#btn-reset').addEventListener('click', () => Timer.discard());
  $('#btn-manual').addEventListener('click', () => openSessionModal({}));
  $('#recent-view-all').addEventListener('click', () => Router.go('calendar'));

  /* Dashboard: main-chart range switcher. */
  $$('#view-dashboard .seg-btn').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.range === mainRange) return;
    mainRange = b.dataset.range;
    $$('#view-dashboard .seg-btn').forEach(x => {
      const on = x === b;
      x.classList.toggle('is-active', on);
      x.setAttribute('aria-pressed', String(on));
    });
    renderMainChart();
  }));

  /* Calendar. */
  Cal.bind();

  /* Setup: subjects. */
  bindSubjectList();
  $('#add-subject-form').addEventListener('submit', e => {
    e.preventDefault();
    const nameInput = $('#new-subject-name');
    const name = nameInput.value.trim();
    if (!name) { Toast.show('Give the subject a name'); nameInput.focus(); return; }
    if (Store.data.subjects.some(x => x.name.toLowerCase() === name.toLowerCase())) {
      Toast.show('You already have a subject with that name');
      nameInput.focus();
      return;
    }
    Store.data.subjects.push({ id: uid(), name: name.slice(0, 60), color: $('#new-subject-color').value });
    nameInput.value = '';
    commit();                                             // re-renders Setup, resets colour swatch
    nameInput.focus();
  });

  /* Setup: numeric targets. */
  const bindNum = (id, key, min, max, integer = false) => {
    const inp = $('#' + id);
    inp.addEventListener('change', () => {
      let v = parseFloat(inp.value);
      if (!Number.isFinite(v)) v = Store.data.settings[key];
      v = clamp(v, min, max);
      if (integer) v = Math.round(v);
      inp.value = v;
      if (v !== Store.data.settings[key]) {
        Store.data.settings[key] = v;
        Store.save();
        Stats.rebuild();
        renderActiveView();
      }
    });
  };
  bindNum('set-weekly-target', 'weeklyTargetHours', 0, 120);
  bindNum('set-daily-target', 'dailyTargetHours', 0, 24);
  bindNum('set-session-length', 'defaultSessionMinutes', 5, 480, true);

  /* Setup: sound, theme, palette, week start. */
  $('#set-sound').addEventListener('change', e => {
    Store.data.settings.sound = e.target.value;
    Store.save();
  });
  $('#btn-sound-preview').addEventListener('click', () => {
    Sound.ensure();
    Sound.play($('#set-sound').value);
  });
  $('#set-theme').addEventListener('change', e => {
    Store.data.settings.theme = e.target.value;
    Store.save();
    Theme.apply();
  });
  $('#set-palette').addEventListener('change', e => {
    Store.data.settings.palette = e.target.value;
    Store.save();
    Theme.apply();
  });
  $('#set-fdw').addEventListener('change', e => {
    Store.data.settings.firstDayOfWeek = +e.target.value;
    Store.save();
    Stats.rebuild();
    Cal.weekStart = weekStartOf(todayKey());
    renderActiveView();
  });

  /* Setup: data in/out. */
  $('#btn-export-csv').addEventListener('click', exportCSV);
  $('#btn-export-json').addEventListener('click', exportJSON);
  $('#btn-import-csv').addEventListener('click', () => $('#file-import-csv').click());
  $('#btn-import-json').addEventListener('click', () => $('#file-import-json').click());
  $('#file-import-csv').addEventListener('change', e => readImportFile(e.target, importCSV));
  $('#file-import-json').addEventListener('change', e => readImportFile(e.target, importJSON));
  $('#btn-clear').addEventListener('click', clearAllData);
}

/* ═══ 23. Heartbeat + boot ═══════════════════════════════════════════════ */

let lastDayKey = '';

function startClock() {
  const clockEl = $('#clock-time');

  const tick = () => {
    const p = londonParts(Date.now());
    clockEl.textContent = `${pad2(p.h)}:${pad2(p.mi)}:${pad2(p.s)}`;

    Timer.tick();

    // Midnight in London: totals roll over to the new day.
    const tk = todayKey();
    if (lastDayKey && tk !== lastDayKey) {
      lastDayKey = tk;
      Stats.rebuild();
      renderActiveView();
    }
    lastDayKey = tk;

    if (currentView === 'dashboard') updateTodayTotal();
    if (currentView === 'calendar' && Cal._nowEl) {
      Cal._nowEl.style.top = (minutesIntoDay(Date.now()) / 60 * HOUR_H) + 'px';
    }
  };

  tick();
  setInterval(tick, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
}

function init() {
  Store.load();
  Stats.rebuild();

  Toast.root = $('#toast-root');
  Modal.root = $('#modal-root');

  Theme.init();            // applies stored theme + palette
  bindStatic();
  Search.bind();
  bindShortcuts();
  Router.init();           // renders the first view
  lastDayKey = todayKey();
  startClock();
  Timer.syncUI();

  // Let the first paint settle, then lift the curtain.
  setTimeout(() => {
    const loader = $('#app-loader');
    if (loader) loader.classList.add('is-done');
  }, 250);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();
