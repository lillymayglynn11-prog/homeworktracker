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

const STORAGE_KEY = 'revtrack.v2';
const LEGACY_KEY  = 'revtrack.v1';   // pre-cat data migrates forward automatically
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
  defaultSessionMinutes: 45, sound: 'chime',
  fx: true,        // click sprites, celebrations, micro-effects
  ambient: true,   // animated sky / particles background
  catName: 'Biscuit'
};

const DEFAULT_UI = { mainRange: 'daily', questTab: 'quests', boardSort: 'edited', taskList: '' };

const Store = {
  data: null,

  load() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) raw = localStorage.getItem(LEGACY_KEY);   // one-way v1 → v2 migration
    } catch (e) { console.warn('RevTrack: localStorage unavailable.', e); }
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
    const out = {
      version: 2, subjects: [], sessions: [], settings: { ...DEFAULT_SETTINGS }, timer: null,
      ui: { ...DEFAULT_UI },
      taskLists: [], tasks: [],
      quests: { dayKey: '', weekKey: '', monthKey: '', awarded: {} },
      ach: {},                                     // id → unlock timestamp
      pet: { xp: 0, hat: 'none', acc: 'none', pets: 0 },
      music: { last: '', dock: 'mini' },
      boards: [], boardPrefs: null,
      counters: { exports: 0, imports: 0, boardsMade: 0, questsDone: 0, tasksDone: 0, comebacks: 0 }
    };
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
      if (typeof st.catName === 'string' && st.catName.trim()) S.catName = st.catName.slice(0, 20);
      if (typeof st.fx === 'boolean') S.fx = st.fx;
      if (typeof st.ambient === 'boolean') S.ambient = st.ambient;
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

    if (d.ui && typeof d.ui === 'object') {
      const u = d.ui, U = out.ui;
      if (['daily', 'weekly', 'monthly'].includes(u.mainRange)) U.mainRange = u.mainRange;
      if (['quests', 'awards', 'pet'].includes(u.questTab)) U.questTab = u.questTab;
      if (['edited', 'created', 'name'].includes(u.boardSort)) U.boardSort = u.boardSort;
      if (typeof u.taskList === 'string') U.taskList = u.taskList;
    }

    if (Array.isArray(d.taskLists)) {
      out.taskLists = d.taskLists
        .filter(l => l && l.id != null && l.name)
        .map(l => ({ id: String(l.id), name: String(l.name).slice(0, 60) }));
    }
    if (Array.isArray(d.tasks)) {
      const listIds = new Set(out.taskLists.map(l => l.id));
      out.tasks = d.tasks
        .filter(t => t && t.id != null && typeof t.title === 'string' && listIds.has(String(t.listId)))
        .map((t, i) => ({
          id: String(t.id), listId: String(t.listId),
          title: String(t.title).slice(0, 200),
          notes: String(t.notes ?? '').slice(0, 2000),
          priority: [0, 1, 2].includes(+t.priority) ? +t.priority : 1,
          deadline: /^\d{4}-\d{2}-\d{2}$/.test(t.deadline) ? t.deadline : null,
          subjectId: out.subjects.some(s => s.id === String(t.subjectId)) ? String(t.subjectId) : '',
          category: String(t.category ?? '').slice(0, 40),
          recur: ['none', 'daily', 'weekly', 'monthly'].includes(t.recur) ? t.recur : 'none',
          done: !!t.done,
          doneAt: Number.isFinite(+t.doneAt) ? +t.doneAt : null,
          created: Number.isFinite(+t.created) ? +t.created : Date.now(),
          order: Number.isFinite(+t.order) ? +t.order : i
        }));
    }

    if (d.quests && typeof d.quests === 'object') {
      const q = d.quests;
      out.quests = {
        dayKey: String(q.dayKey ?? ''), weekKey: String(q.weekKey ?? ''), monthKey: String(q.monthKey ?? ''),
        awarded: (q.awarded && typeof q.awarded === 'object') ? { ...q.awarded } : {}
      };
    }

    if (d.ach && typeof d.ach === 'object') {
      for (const k of Object.keys(d.ach)) {
        if (Number.isFinite(+d.ach[k])) out.ach[String(k).slice(0, 40)] = +d.ach[k];
      }
    }

    if (d.pet && typeof d.pet === 'object') {
      out.pet = {
        xp: Math.max(0, Math.round(+d.pet.xp || 0)),
        hat: String(d.pet.hat ?? 'none').slice(0, 20),
        acc: String(d.pet.acc ?? 'none').slice(0, 20),
        pets: Math.max(0, Math.round(+d.pet.pets || 0))
      };
    }

    if (d.music && typeof d.music === 'object') {
      out.music = {
        last: String(d.music.last ?? '').slice(0, 300),
        dock: ['mini', 'open', 'hidden'].includes(d.music.dock) ? d.music.dock : 'mini'
      };
    }

    if (Array.isArray(d.boards)) {
      out.boards = d.boards
        .filter(b => b && b.id != null && Array.isArray(b.els))
        .slice(0, 400)
        .map(b => ({
          id: String(b.id),
          name: String(b.name ?? 'Untitled board').slice(0, 80),
          created: Number.isFinite(+b.created) ? +b.created : Date.now(),
          edited: Number.isFinite(+b.edited) ? +b.edited : Date.now(),
          fav: !!b.fav,
          bg: (typeof Board !== 'undefined' && Board.BGS && Board.BGS[b.bg]) ? b.bg : (typeof b.bg === 'string' ? b.bg : 'blank'),
          els: b.els.filter(e => e && typeof e.t === 'string'),
          thumb: typeof b.thumb === 'string' && b.thumb.startsWith('data:image') ? b.thumb.slice(0, 60000) : '',
          view: (b.view && Number.isFinite(+b.view.x)) ? { x: +b.view.x, y: +b.view.y, s: clamp(+b.view.s || 1, 0.1, 8) } : { x: 0, y: 0, s: 1 }
        }));
    }
    if (d.boardPrefs && typeof d.boardPrefs === 'object') out.boardPrefs = d.boardPrefs;

    if (d.counters && typeof d.counters === 'object') {
      for (const k of Object.keys(out.counters)) {
        if (Number.isFinite(+d.counters[k])) out.counters[k] = Math.max(0, Math.round(+d.counters[k]));
      }
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
  if (typeof Game !== 'undefined') Game.onCommit();   // quests · achievements · XP
}

function addSessionRecord(rec) {
  Store.data.sessions.push(rec);
  commit();
  if (typeof Game !== 'undefined') {
    Game.award(Math.max(1, Math.round(rec.duration / 60)), 'revision');
    Cat.celebrate('happy');
  }
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
      if (typeof Cat !== 'undefined') {
        Cat.setState('excited');
        if (Math.random() < 0.8) Cat.say(Cat.pickOne(['A session! I\u2019m so ready.', 'Focus mode: ON. I\u2019ll keep watch.', 'Let\u2019s go. Deep breaths, sharp claws.']));
      }
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
  if (typeof Board !== 'undefined' && Board.studio) Board.mount($('#dash-studio-slot'));
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

function renderHeatmap(sel = '#heatmap') {
  const wrap = $(sel);
  if (!wrap) return;
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
  $('#set-cat-name').value = Store.data.settings.catName;
  $('#set-fx').checked = !!Store.data.settings.fx;
  $('#set-ambient').checked = !!Store.data.settings.ambient;
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
  Store.data.counters.imports += 1;
  commit();
  Game.award(Math.max(1, Math.round(added.reduce((a, s) => a + s.duration, 0) / 60)), 'import');
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
  Store.data.counters.imports += 1;
  Theme.apply(false);
  Cal.weekStart = weekStartOf(todayKey());
  resyncCompanionState();
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
  resyncCompanionState();
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
    ['Switch view (nav order)', ['1', '…', '9']],
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
      case '1': case '2': case '3': case '4': case '5':
      case '6': case '7': case '8': case '9':
        Router.go(VIEWS[+e.key - 1]); break;
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


/* ═══ 24. Event bus + presence ═══════════════════════════════════════════
   A tiny pub/sub keeps the companion layer decoupled from core logic,
   and a presence tracker tells the cat when you have wandered off.      */

const Bus = {
  map: new Map(),
  on(evt, fn) { if (!this.map.has(evt)) this.map.set(evt, []); this.map.get(evt).push(fn); },
  emit(evt, data) { (this.map.get(evt) || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); }
};

const Presence = {
  lastActive: Date.now(),
  pointer: { x: innerWidth / 2, y: innerHeight * 0.4 },
  bind() {
    const touch = () => { this.lastActive = Date.now(); Bus.emit('active'); };
    document.addEventListener('pointermove', e => { this.pointer.x = e.clientX; this.pointer.y = e.clientY; touch(); }, { passive: true });
    document.addEventListener('pointerdown', touch, { passive: true });
    document.addEventListener('keydown', touch);
  },
  idleMs() { return Date.now() - this.lastActive; }
};

const REDUCED_MOTION = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

/* Extra synthesised cues for the companion layer (reuses Sound's context). */
Sound.cue = function (name) {
  if (Store.data.settings.sound === 'none') return;
  const ctx = this.ensure();
  if (!ctx) return;
  const t0 = ctx.currentTime;
  const tone = (freq, start, dur, type = 'sine', gain = 0.14, glideTo = null) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0 + start);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t0 + start + dur);
    g.gain.setValueAtTime(0.0001, t0 + start);
    g.gain.linearRampToValueAtTime(gain, t0 + start + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
    o.connect(g); g.connect(ctx.destination);
    o.start(t0 + start); o.stop(t0 + start + dur + 0.05);
  };
  if (name === 'pop')          tone(520, 0, 0.09, 'triangle', 0.08, 760);
  else if (name === 'purr')  { tone(196, 0, 0.4, 'sawtooth', 0.05, 170); tone(98, 0, 0.4, 'sine', 0.06); }
  else if (name === 'meow')  { tone(620, 0, 0.28, 'triangle', 0.1, 880); tone(880, 0.24, 0.22, 'triangle', 0.08, 540); }
  else if (name === 'quest') { tone(740, 0, 0.16, 'triangle', 0.12); tone(988, 0.14, 0.3, 'triangle', 0.12); }
  else if (name === 'fanfare') { tone(523.3, 0, 0.16, 'triangle', 0.13); tone(659.3, 0.13, 0.16, 'triangle', 0.13); tone(784, 0.26, 0.16, 'triangle', 0.13); tone(1046.5, 0.4, 0.5, 'triangle', 0.15); }
  else if (name === 'level') { tone(392, 0, 0.14, 'square', 0.06); tone(523.3, 0.12, 0.14, 'square', 0.06); tone(659.3, 0.24, 0.14, 'square', 0.06); tone(784, 0.36, 0.42, 'triangle', 0.14); }
  else if (name === 'stamp')   tone(300, 0, 0.1, 'square', 0.07, 140);
};

/* ═══ 25. Ambient sky ════════════════════════════════════════════════════
   A fixed canvas paints a slow day/dusk/night sky with drifting clouds,
   twinkling stars, floating cats and rising paw motes. Layers parallax
   gently against the pointer. One static frame is drawn when animation
   is off (setting, hidden tab, or reduced-motion).                       */

const Ambient = {
  cv: null, ctx: null, w: 0, h: 0, raf: 0, t: 0,
  clouds: [], stars: [], cats: [], paws: [],

  init() {
    this.cv = $('#bg-canvas');
    if (!this.cv) return;
    this.ctx = this.cv.getContext && this.cv.getContext('2d');
    if (!this.ctx) return;
    const seed = (n, fn) => Array.from({ length: n }, fn);
    this.clouds = seed(5, () => ({ x: Math.random(), y: 0.06 + Math.random() * 0.3, s: 0.55 + Math.random() * 0.9, v: 0.004 + Math.random() * 0.01 }));
    this.stars  = seed(26, () => ({ x: Math.random(), y: Math.random() * 0.55, r: 0.6 + Math.random() * 1.4, p: Math.random() * Math.PI * 2 }));
    this.cats   = seed(3, i => ({ x: Math.random(), y: 0.2 + Math.random() * 0.5, s: 0.5 + Math.random() * 0.5, v: (0.002 + Math.random() * 0.004) * (Math.random() < 0.5 ? -1 : 1), b: Math.random() * Math.PI * 2 }));
    this.paws   = seed(14, () => ({ x: Math.random(), y: Math.random(), r: 2 + Math.random() * 3.2, v: 0.006 + Math.random() * 0.012, d: Math.random() * Math.PI * 2 }));
    const size = () => {
      this.w = this.cv.width = Math.max(1, Math.round(innerWidth * 0.75));
      this.h = this.cv.height = Math.max(1, Math.round(innerHeight * 0.75));
      if (!this.raf) this.repaintStill();
    };
    size();
    addEventListener('resize', debounce(size, 150));
    document.addEventListener('visibilitychange', () => this.sync());
    this.sync();
  },

  /** {a, b, night 0-1} sky colours blended for the current London hour. */
  palette() {
    const p = londonParts(Date.now());
    const hr = p.h + p.mi / 60;
    const cs = getComputedStyle(document.documentElement);
    const pick = v => cs.getPropertyValue(v).trim() || '#dceafe';
    const day = [pick('--sky-day-a'), pick('--sky-day-b')], dusk = [pick('--sky-dusk-a'), pick('--sky-dusk-b')], night = [pick('--sky-night-a'), pick('--sky-night-b')];
    const lerp = (a, b, t) => {
      const pa = a.match(/\w\w/g).map(x => parseInt(x, 16)), pb = b.match(/\w\w/g).map(x => parseInt(x, 16));
      return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('');
    };
    const mix = (A, B, t) => [lerp(A[0], B[0], t), lerp(A[1], B[1], t)];
    let cols, nightAmt;
    if (hr >= 7 && hr < 17)       { cols = day; nightAmt = 0; }
    else if (hr >= 17 && hr < 20) { const t = (hr - 17) / 3; cols = t < 0.5 ? mix(day, dusk, t * 2) : mix(dusk, night, (t - 0.5) * 2); nightAmt = Math.max(0, (t - 0.5) * 2); }
    else if (hr >= 5 && hr < 7)   { const t = (hr - 5) / 2; cols = t < 0.5 ? mix(night, dusk, t * 2) : mix(dusk, day, (t - 0.5) * 2); nightAmt = Math.max(0, 1 - t * 2); }
    else                          { cols = night; nightAmt = 1; }
    return { a: cols[0], b: cols[1], night: nightAmt };
  },

  running() { return Store.data.settings.ambient && !document.hidden && !REDUCED_MOTION; },

  sync() {
    if (this.running() && !this.raf && this.ctx) {
      let last = performance.now();
      const loop = now => {
        this.raf = requestAnimationFrame(loop);
        const dt = Math.min(0.06, (now - last) / 1000); last = now;
        this.t += dt;
        this.frame(dt, false);
      };
      this.raf = requestAnimationFrame(loop);
    } else if (!this.running() && this.raf) {
      cancelAnimationFrame(this.raf); this.raf = 0;
      this.repaintStill();
    }
  },

  /** One static frame when paused; a clean slate when turned off. */
  repaintStill() {
    if (!this.ctx) return;
    if (Store.data.settings.ambient) this.frame(0, true);
    else { this.ctx.setTransform(1, 0, 0, 1, 0, 0); this.ctx.clearRect(0, 0, this.w, this.h); }
  },

  drawPaw(x, y, r, alpha) {
    const c = this.ctx;
    c.globalAlpha = alpha;
    c.beginPath(); c.ellipse(x, y, r, r * 0.9, 0, 0, 7); c.fill();
    for (let i = -1; i <= 1; i++) {
      c.beginPath(); c.ellipse(x + i * r * 0.9, y - r * 1.25 + Math.abs(i) * r * 0.22, r * 0.34, r * 0.44, 0, 0, 7); c.fill();
    }
    c.globalAlpha = 1;
  },

  drawCatSilhouette(x, y, s, bob) {
    const c = this.ctx;
    c.save(); c.translate(x, y + Math.sin(bob) * 6); c.scale(s, s);
    c.beginPath();
    c.moveTo(-26, 14); c.quadraticCurveTo(-30, -12, 0, -12); c.quadraticCurveTo(30, -12, 26, 14); c.closePath();          // body
    c.moveTo(-14, -8); c.lineTo(-20, -24); c.lineTo(-4, -14);                                                             // ear
    c.moveTo(14, -8); c.lineTo(20, -24); c.lineTo(4, -14);
    c.fill();
    c.beginPath(); c.moveTo(24, 8); c.quadraticCurveTo(44, 4, 40, -12); c.lineWidth = 7; c.lineCap = 'round'; c.stroke();  // tail
    c.restore();
  },

  frame(dt, still) {
    const c = this.ctx, W = this.w, H = this.h;
    const pal = this.palette();
    const px = (Presence.pointer.x / innerWidth - 0.5), py = (Presence.pointer.y / innerHeight - 0.5);
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, pal.a); g.addColorStop(1, pal.b);
    c.clearRect(0, 0, W, H);
    c.globalAlpha = 0.6; c.fillStyle = g; c.fillRect(0, 0, W, H); c.globalAlpha = 1;

    // Stars fade in at night.
    if (pal.night > 0.05) {
      c.fillStyle = '#fff';
      for (const s of this.stars) {
        if (!still) s.p += dt * 1.6;
        const tw = 0.35 + 0.65 * Math.abs(Math.sin(s.p));
        c.globalAlpha = pal.night * 0.7 * tw;
        c.beginPath(); c.arc((s.x + px * -0.012) * W, (s.y + py * -0.012) * H, s.r, 0, 7); c.fill();
      }
      c.globalAlpha = 1;
    }

    // Clouds by day, drifting right.
    if (pal.night < 0.95) {
      c.fillStyle = pal.night > 0.4 ? 'rgba(200,205,235,0.5)' : 'rgba(255,255,255,0.75)';
      for (const cl of this.clouds) {
        if (!still) { cl.x += cl.v * dt; if (cl.x > 1.2) cl.x = -0.25; }
        const x = (cl.x + px * -0.02) * W, y = (cl.y + py * -0.02) * H, s = cl.s * (W / 900);
        c.globalAlpha = (1 - pal.night) * 0.5 + 0.08;
        c.beginPath();
        c.ellipse(x, y, 46 * s, 15 * s, 0, 0, 7);
        c.ellipse(x - 30 * s, y + 6 * s, 26 * s, 11 * s, 0, 0, 7);
        c.ellipse(x + 32 * s, y + 7 * s, 30 * s, 12 * s, 0, 0, 7);
        c.fill();
      }
      c.globalAlpha = 1;
    }

    // Floating dream-cats, deepest parallax layer.
    c.fillStyle = pal.night > 0.5 ? 'rgba(190,180,240,0.16)' : 'rgba(120,110,200,0.10)';
    c.strokeStyle = c.fillStyle;
    for (const k of this.cats) {
      if (!still) { k.x += k.v * dt; k.b += dt; if (k.x > 1.15) k.x = -0.15; if (k.x < -0.15) k.x = 1.15; }
      this.drawCatSilhouette((k.x + px * -0.035) * W, (k.y + py * -0.035) * H, k.s * (W / 1100), k.b);
    }

    // Paw motes rising like bubbles.
    c.fillStyle = pal.night > 0.5 ? 'rgba(247,167,108,0.20)' : 'rgba(247,167,108,0.26)';
    for (const p of this.paws) {
      if (!still) { p.y -= p.v * dt; p.d += dt * 0.7; if (p.y < -0.05) { p.y = 1.05; p.x = Math.random(); } }
      this.drawPaw((p.x + Math.sin(p.d) * 0.012 + px * -0.05) * W, (p.y + py * -0.05) * H, p.r * (W / 1000), 0.9);
    }
  }
};

/* ═══ 26. Click effects ══════════════════════════════════════════════════ */

const FX = {
  layer: null,
  SPRITES: [
    '<svg viewBox="0 0 24 24" fill="__C__"><path d="M12 12.6c-3 0-5.4 2-5.4 4.4 0 1.8 1.4 3.1 3.2 3.1.8 0 1.6-.3 2.2-.8.6.5 1.4.8 2.2.8 1.8 0 3.2-1.3 3.2-3.1 0-2.4-2.4-4.4-5.4-4.4zM6.3 8.1c-1 .1-1.7 1.2-1.6 2.4.1 1.2 1 2.1 2 2s1.7-1.2 1.6-2.4c-.1-1.2-1-2.1-2-2zm11.4 0c-1-.1-1.9.8-2 2-.1 1.2.6 2.3 1.6 2.4 1 .1 1.9-.8 2-2 .1-1.2-.6-2.3-1.6-2.4zM9.4 3.5c-1 .1-1.8 1.3-1.6 2.6.2 1.3 1.1 2.3 2.1 2.2 1-.1 1.8-1.3 1.6-2.6-.2-1.3-1.1-2.3-2.1-2.2zm5.2 0c-1-.1-1.9.9-2.1 2.2-.2 1.3.6 2.5 1.6 2.6 1 .1 1.9-.9 2.1-2.2.2-1.3-.6-2.5-1.6-2.6z"/></svg>',
    '<svg viewBox="0 0 24 24" fill="__C__"><path d="M12 21s-7.4-4.6-9.6-9A5.4 5.4 0 0 1 12 6.6 5.4 5.4 0 0 1 21.6 12c-2.2 4.4-9.6 9-9.6 9z"/></svg>',
    '<svg viewBox="0 0 24 24" fill="__C__"><path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2z"/></svg>',
    '<svg viewBox="0 0 24 24" fill="__C__"><path d="M4.5 4 8 7.2A7.9 7.9 0 0 1 12 6.2c1.5 0 2.8.4 4 1L19.5 4l.6 5.3c.6 1 .9 2.1.9 3.2 0 4.1-4 7.3-9 7.3s-9-3.2-9-7.3c0-1.1.3-2.2.9-3.2L4.5 4z"/></svg>',
    '<svg viewBox="0 0 24 24" fill="__C__"><path d="M12 3l2 4.5L19 9l-3.6 3.2.9 4.8L12 14.8 7.7 17l.9-4.8L5 9l5-1.5L12 3z"/></svg>'
  ],
  COLORS: ['#f7a76c', '#f492b5', '#8fb7f4', '#8dd8ae', '#e8c04c', '#c39bf0'],

  init() {
    this.layer = $('#fx-layer');
    document.addEventListener('pointerdown', e => {
      if (!Store.data.settings.fx || REDUCED_MOTION) return;
      if (e.target.closest('.canvas-wrap, input, textarea, select, iframe')) return;
      this.spawn(e.clientX, e.clientY, 1, true);
    }, { passive: true });
  },

  spawn(x, y, n = 1, ring = false) {
    if (!this.layer || !Store.data.settings.fx || REDUCED_MOTION) return;
    if (ring) {
      const r = el('span', 'fx-ring');
      r.style.left = x + 'px'; r.style.top = y + 'px';
      this.layer.appendChild(r);
      r.addEventListener('animationend', () => r.remove());
    }
    for (let i = 0; i < n; i++) {
      if (this.layer.children.length > 24) this.layer.firstElementChild.remove();
      const s = el('span', 'fx-sprite fx-pop');
      const svg = this.SPRITES[Math.floor(Math.random() * this.SPRITES.length)]
        .replace('__C__', this.COLORS[Math.floor(Math.random() * this.COLORS.length)]);
      s.innerHTML = svg;
      const size = 15 + Math.random() * 12;
      s.style.cssText = `left:${x}px;top:${y}px;width:${size}px;height:${size}px;` +
        `--dx:${(Math.random() - 0.5) * (n > 1 ? 130 : 60)}px;--dy:${-(30 + Math.random() * (n > 1 ? 110 : 50))}px;` +
        `--sc:${0.8 + Math.random() * 0.7};--rot:${(Math.random() - 0.5) * 70}deg;`;
      this.layer.appendChild(s);
      s.addEventListener('animationend', () => s.remove());
    }
  },

  burst(x, y, n = 14) { this.spawn(x, y, n, true); }
};

/* ═══ 27. The cat ════════════════════════════════════════════════════════
   One hand-drawn SVG, driven three ways: continuous CSS keyframes for
   tail/breathing, class toggles for blinks/twitches/moods, and a small
   rAF loop that steers the pupils toward the pointer at 60fps.          */

const Cat = {
  root: null, stage: null, bubbleEl: null,
  baseline: 'idle', state: 'idle', asleep: false,
  bubbleTimer: 0, stateTimer: 0, homeX: 0, facing: 1,
  lastContext: 0,

  svgMarkup() {
    return `
<svg viewBox="0 0 160 150" aria-hidden="true">
  <path class="cat-tail" d="M118 126 C148 122 152 94 137 84" fill="none" stroke="var(--cat-fur-2)" stroke-width="13" stroke-linecap="round"/>
  <g class="cat-body-grp">
    <path d="M40 143 C36 106 56 90 80 90 C104 90 124 106 120 143 Z" fill="var(--cat-fur)"/>
    <ellipse cx="80" cy="130" rx="21" ry="17" fill="var(--cat-cream)"/>
    <rect x="56" y="130" width="17" height="14" rx="7" fill="var(--cat-fur)"/>
    <rect class="cat-paw-front" x="87" y="130" width="17" height="14" rx="7" fill="var(--cat-fur)"/>
  </g>
  <g class="cat-head-grp">
    <g class="cat-ear cat-ear-l"><path d="M52 40 Q41 10 46 8 Q66 15 71 27 Z" fill="var(--cat-fur)"/><path d="M54 34 Q48 17 50 15 Q62 21 65 28 Z" fill="var(--pastel-pink)" opacity=".85"/></g>
    <g class="cat-ear cat-ear-r"><path d="M108 40 Q119 10 114 8 Q94 15 89 27 Z" fill="var(--cat-fur)"/><path d="M106 34 Q112 17 110 15 Q98 21 95 28 Z" fill="var(--pastel-pink)" opacity=".85"/></g>
    <path d="M45 64 C45 34 60 24 80 24 C100 24 115 34 115 64 C115 86 101 95 80 95 C59 95 45 86 45 64 Z" fill="var(--cat-fur)"/>
    <g class="cat-pupils">
      <ellipse cx="66" cy="58" rx="7" ry="8" fill="#2c2118"/><circle cx="68.4" cy="55.2" r="2" fill="#fff"/>
      <ellipse cx="94" cy="58" rx="7" ry="8" fill="#2c2118"/><circle cx="96.4" cy="55.2" r="2" fill="#fff"/>
    </g>
    <g class="cat-lids"><path d="M57 48 h18 v14 a9 8 0 0 1 -18 0 Z" fill="var(--cat-fur)"/><path d="M85 48 h18 v14 a9 8 0 0 1 -18 0 Z" fill="var(--cat-fur)"/></g>
    <circle class="cat-blush" cx="57" cy="70" r="5" fill="var(--pastel-pink)"/>
    <circle class="cat-blush" cx="103" cy="70" r="5" fill="var(--pastel-pink)"/>
    <path d="M76 67 L84 67 L80 72 Z" fill="#e58ba4"/>
    <path class="cat-mouth-idle" d="M74 76 Q77 79 80 76 Q83 79 86 76" fill="none" stroke="#5d4630" stroke-width="1.7" stroke-linecap="round"/>
    <path class="cat-mouth-happy" d="M71 75 Q80 85 89 75" fill="none" stroke="#5d4630" stroke-width="2" stroke-linecap="round"/>
    <circle class="cat-mouth-wow" cx="80" cy="78" r="3.6" fill="#5d4630"/>
    <path class="cat-mouth-sad" d="M73 80 Q80 74 87 80" fill="none" stroke="#5d4630" stroke-width="1.8" stroke-linecap="round"/>
    <g stroke="#a8895f" stroke-width="1.3" stroke-linecap="round" opacity=".8">
      <path d="M52 64 L30 60"/><path d="M52 69 L29 69"/><path d="M52 74 L31 78"/>
      <path d="M108 64 L130 60"/><path d="M108 69 L131 69"/><path d="M108 74 L129 78"/>
    </g>
    <g class="cat-hat-slot"></g>
    <g class="cat-acc-slot"></g>
  </g>
  <g class="cat-zzz" fill="var(--text-3)" font-family="var(--font-display)" font-weight="700">
    <text x="116" y="46" font-size="11">z</text><text x="124" y="36" font-size="14">z</text><text x="134" y="26" font-size="17">z</text>
  </g>
</svg>`;
  },

  init() {
    this.root = $('#cat-root');
    this.stage = $('#cat-stage');
    this.bubbleEl = $('#cat-bubble');
    if (!this.root || !this.stage) return;
    this.stage.innerHTML = this.svgMarkup();
    Pet.dress(this.stage);
    this.setState('idle', true);

    this.stage.addEventListener('click', () => this.petMe());

    // Pupils steer toward the pointer; the head tilts a little with them.
    const pupils = $('.cat-pupils', this.stage), head = $('.cat-head-grp', this.stage);
    let cx = 0, cy = 0;
    const steer = () => {
      requestAnimationFrame(steer);
      if (this.asleep || document.hidden) return;
      const r = this.stage.getBoundingClientRect();
      const dx = Presence.pointer.x - (r.left + r.width * 0.5);
      const dy = Presence.pointer.y - (r.top + r.height * 0.42);
      const dist = Math.hypot(dx, dy) || 1;
      const tx = clamp(dx / dist * Math.min(3.5, dist / 40), -3.5, 3.5) * this.facing;
      const ty = clamp(dy / dist * Math.min(3, dist / 46), -2.5, 3);
      cx += (tx - cx) * 0.16; cy += (ty - cy) * 0.16;
      if (pupils && !REDUCED_MOTION) pupils.style.transform = `translate(${cx.toFixed(2)}px, ${cy.toFixed(2)}px)`;
      if (head && !REDUCED_MOTION && this.state !== 'sleep' && this.state !== 'sad') head.style.transform = `rotate(${(cx * 1.1).toFixed(2)}deg)`;
    };
    if (!REDUCED_MOTION) requestAnimationFrame(steer);

    // Natural blinking.
    const blink = () => {
      if (!this.asleep && !document.hidden) {
        this.root.classList.add('is-blink');
        setTimeout(() => this.root.classList.remove('is-blink'), 160);
      }
      setTimeout(blink, 2400 + Math.random() * 4100);
    };
    setTimeout(blink, 2000);

    // Occasional ear twitches.
    const twitch = () => {
      if (!this.asleep && !document.hidden) {
        const ear = $(Math.random() < 0.5 ? '.cat-ear-l' : '.cat-ear-r', this.stage);
        if (ear) { ear.classList.add('is-twitch'); setTimeout(() => ear.classList.remove('is-twitch'), 550); }
      }
      setTimeout(twitch, 7000 + Math.random() * 11000);
    };
    setTimeout(twitch, 5000);

    // Idle antics: a wave, a hop, or a stroll along the bottom of the screen.
    const antics = () => {
      if (!this.asleep && !document.hidden && Store.data.settings.fx && !REDUCED_MOTION) {
        const pick = Math.random();
        if (pick < 0.35) this.wave();
        else if (pick < 0.6) this.hop();
        else this.stroll();
      }
      setTimeout(antics, 45000 + Math.random() * 75000);
    };
    setTimeout(antics, 30000 + Math.random() * 30000);

    // Sleep after 75s away; wake on any activity.
    setInterval(() => {
      if (!this.asleep && Presence.idleMs() > 75000) {
        this.asleep = true; this.setState('sleep', true);
      }
    }, 4000);
    Bus.on('active', () => {
      if (this.asleep) {
        this.asleep = false;
        this.refreshMood();
        if (Math.random() < 0.6) this.say(this.pickOne(['*yawn* … oh! You\u2019re back.', 'Mrrp? I was resting my eyes.', 'Welcome back. I kept your spot warm.']));
      }
    });

    // Speak with context: shortly after load, then every few minutes.
    setTimeout(() => this.speakContext(true), 2600);
    setInterval(() => { if (!this.asleep && !document.hidden && Date.now() - this.lastContext > 240000) this.speakContext(); }, 30000);

    this.refreshMood();
  },

  daysSinceLastSession() {
    const last = Stats.sorted[0];
    if (!last) return null;
    const lastKey = dateKeyOf(last.start);
    let k = todayKey(), n = 0;
    while (k > lastKey && n < 30) { k = addDaysKey(k, -1); n++; }
    return n;
  },

  refreshMood() {
    const gap = this.daysSinceLastSession();
    this.baseline = (gap != null && gap >= 3) ? 'sad' : 'idle';
    if (!this.asleep && (this.state === 'idle' || this.state === 'sad' || this.state === 'sleep')) this.setState(this.baseline, true);
  },

  setState(s, base = false) {
    this.state = s;
    this.root.className = 'cat-root state-' + s;
    clearTimeout(this.stateTimer);
    if (!base && s !== this.baseline) {
      this.stateTimer = setTimeout(() => { if (!this.asleep) this.setState(this.baseline, true); }, 3500);
    }
  },

  wave() {
    const paw = $('.cat-paw-front', this.stage);
    if (!paw) return;
    paw.classList.add('is-wave');
    setTimeout(() => paw.classList.remove('is-wave'), 1900);
  },

  hop() {
    if (REDUCED_MOTION) return;
    this.root.classList.add('is-hop');
    setTimeout(() => this.root.classList.remove('is-hop'), 1650);
  },

  /** Wander to a new spot along the bottom edge (the "jump around" antic). */
  stroll() {
    if (REDUCED_MOTION) return;
    const max = Math.max(8, innerWidth - 170);
    const target = 8 + Math.random() * (max - 8);
    this.facing = target > this.homeX ? 1 : -1;
    const svg = $('svg', this.stage);
    if (svg) svg.style.transform = this.facing === -1 ? 'scaleX(-1)' : '';
    this.homeX = target;
    this.root.style.transform = `translateX(${Math.round(target)}px)`;
    this.hop();
    setTimeout(() => { const s = $('svg', this.stage); if (s) s.style.transform = ''; this.facing = 1; }, 2600);
  },

  petMe() {
    Store.data.pet.pets += 1;
    Store.save();
    this.root.classList.add('is-pet');
    setTimeout(() => this.root.classList.remove('is-pet'), 750);
    this.setState('happy');
    Sound.cue('purr');
    const r = this.stage.getBoundingClientRect();
    FX.burst(r.left + r.width / 2, r.top + r.height * 0.35, 5);
    if (Math.random() < 0.45) this.say(this.pickOne(['Purrrr…', 'That\u2019s the spot.', 'Okay okay, five more minutes of pets, then revision.', 'I accept this tribute.', '*happy cat noises*']));
    Game.onCommit();
  },

  say(text, ms = 6000) {
    if (!this.bubbleEl || !text) return;
    clearTimeout(this.bubbleTimer);
    this.bubbleEl.classList.remove('is-out');
    this.bubbleEl.hidden = false;
    this.bubbleEl.textContent = text;
    // retrigger pop animation
    void this.bubbleEl.offsetWidth;
    this.bubbleTimer = setTimeout(() => {
      this.bubbleEl.classList.add('is-out');
      setTimeout(() => { this.bubbleEl.hidden = true; this.bubbleEl.classList.remove('is-out'); }, 300);
    }, ms);
  },

  pickOne(arr) { return arr[Math.floor(Math.random() * arr.length)]; },

  name() { return (Store.data.settings.catName || 'Biscuit').trim() || 'Biscuit'; },

  /** Build candidate lines from live app context, weighted by relevance. */
  contextLines(greetingBoost) {
    const out = [];
    const add = (w, t) => { if (t) out.push({ w, t }); };
    const h = londonParts(Date.now()).h;
    const st = Stats.streaks();
    const today = Stats.daySec(todayKey());
    const targetSec = Store.data.settings.dailyTargetHours * 3600;

    add(greetingBoost ? 6 : 1,
      h < 5 ? 'Studying at this hour? Night owls stick together.' :
      h < 12 ? 'Good morning! Ready to study?' :
      h < 17 ? 'Good afternoon. Shall we get some revision in?' :
      h < 22 ? 'Good evening — a calm session before bed?' :
               'It\u2019s late. One small session, then rest.');

    if (st.current >= 3) add(4, `You\u2019re on a ${st.current}-day streak! Don\u2019t let me down.`);
    if (targetSec > 0 && today > 0 && today < targetSec) {
      const left = Math.ceil((targetSec - today) / 60);
      if (left <= 45) add(6, `Only ${left} minute${left === 1 ? '' : 's'} until today\u2019s goal!`);
      else add(2, `${fmtDurShort(targetSec - today)} to go for today\u2019s goal. We\u2019ve got this.`);
    }
    if (targetSec > 0 && today >= targetSec) add(5, 'Today\u2019s goal — done. Amazing work today!');
    if (Store.data.timer) add(5, 'Focus mode. I\u2019ll keep watch.');

    const gap = this.daysSinceLastSession();
    if (gap != null && gap >= 3) add(6, `It\u2019s been ${gap} days… I miss watching you work. One tiny session?`);

    // Nearest task deadline.
    const tk = todayKey(), tm = addDaysKey(tk, 1);
    const due = Store.data.tasks.filter(t => !t.done && t.deadline && t.deadline <= tm).sort((a, b) => a.deadline < b.deadline ? -1 : 1)[0];
    if (due) add(5, due.deadline < tk ? `“${due.title}” is overdue — pounce on it?` : due.deadline === tk ? `“${due.title}” is due today.` : `Heads up: “${due.title}” is due tomorrow.`);

    // A quest that is nearly done.
    const near = Game.questStates().find(q => !q.done && q.target > 0 && q.progress / q.target >= 0.7);
    if (near) add(4, `So close: “${near.name}” is at ${Math.min(99, Math.round(near.progress / near.target * 100))}%.`);

    const recentAch = Object.entries(Store.data.ach).sort((a, b) => b[1] - a[1])[0];
    if (recentAch && Date.now() - recentAch[1] < 7200000) {
      const def = Game.ACH.find(a => a.id === recentAch[0]);
      if (def) add(3, `Still purring about “${def.name}”. Let\u2019s earn another achievement.`);
    }

    add(1, this.pickOne([
      'Ready to study?', 'A little every day beats a lot once a month.',
      `${this.name()} believes in you. That\u2019s me. I\u2019m ${this.name()}.`,
      'Stretch, sip water, then one focused session.',
      'Whiteboard doodles count as thinking. Mostly.'
    ]));
    return out;
  },

  speakContext(greetingBoost = false) {
    this.lastContext = Date.now();
    const lines = this.contextLines(greetingBoost);
    const total = lines.reduce((a, l) => a + l.w, 0);
    let roll = Math.random() * total;
    for (const l of lines) { roll -= l.w; if (roll <= 0) { this.say(l.t); break; } }
    if (greetingBoost) this.wave();
  },

  celebrate(kind = 'happy') {
    this.setState(kind === 'excited' ? 'excited' : 'happy');
    if (!REDUCED_MOTION && Store.data.settings.fx) {
      const r = this.stage.getBoundingClientRect();
      FX.burst(r.left + r.width / 2, r.top + r.height * 0.3, 10);
    }
  }
};

/* ═══ 28. Game layer — XP, quests, achievements ══════════════════════════
   Everything funnels through commit(): after each data change the layer
   refreshes quest periods, checks quest + achievement conditions exactly
   once, awards XP, and persists. Nothing here re-enters commit().       */

const Game = {
  /* ---- levels ---- */
  xpNeed(l) { return 90 + (l - 1) * 45; },
  levelInfo(xp = Store.data.pet.xp) {
    let level = 1, rest = xp;
    while (rest >= this.xpNeed(level) && level < 99) { rest -= this.xpNeed(level); level++; }
    return { level, into: rest, need: this.xpNeed(level) };
  },

  updateChip() {
    const li = this.levelInfo();
    const lv = $('#pet-chip-lv'), fill = $('#pet-chip-fill');
    if (lv) lv.textContent = 'Lv ' + li.level;
    if (fill) fill.style.width = Math.round(li.into / li.need * 100) + '%';
  },

  award(xp, why = '') {
    if (!xp || xp <= 0) return;
    const before = this.levelInfo().level;
    Store.data.pet.xp += Math.round(xp);
    Store.save();
    const after = this.levelInfo().level;
    this.updateChip();
    const chip = $('#pet-chip');
    if (chip) { chip.classList.remove('is-bump'); void chip.offsetWidth; chip.classList.add('is-bump'); }
    if (after > before) this.levelUp(after);
    Bus.emit('xp', { xp, why });
  },

  levelUp(level) {
    Sound.cue('level');
    Cat.celebrate('excited');
    Cat.say(`Level ${level}! ${Cat.name()} is growing up.`, 7000);
    const unlocks = Pet.unlocksAt(level);
    Toast.show(unlocks.length
      ? `Level ${level} — unlocked: ${unlocks.join(', ')}`
      : `Level ${level}! Keep going.`, { duration: 5200 });
    if (!REDUCED_MOTION && Store.data.settings.fx) FX.burst(innerWidth / 2, innerHeight * 0.3, 16);
    Pet.dressEverywhere();
    if (currentView === 'quests') renderQuestView();
  },

  /* ---- quest periods ---- */
  refreshPeriods() {
    const q = Store.data.quests;
    const tk = todayKey(), wk = weekStartOf(tk), mk = tk.slice(0, 7);
    let changed = false;
    const clearPrefix = p => { for (const id of Object.keys(q.awarded)) if (id.startsWith(p)) delete q.awarded[id]; };
    if (q.dayKey !== tk)   { clearPrefix('d:'); q.dayKey = tk; changed = true; }
    if (q.weekKey !== wk)  { clearPrefix('w:'); q.weekKey = wk; changed = true; }
    if (q.monthKey !== mk) { clearPrefix('m:'); q.monthKey = mk; changed = true; }
    if (changed) Store.save();
  },

  questCtx() {
    const tk = todayKey();
    const weekStart = Stats.weekStartKey;
    const monthPrefix = Stats.monthPrefix;
    const kp = keyParts(tk);
    const daysInMonth = new Date(kp.y, kp.m, 0).getDate();

    let daySessions = 0, monthSessions = 0, subjToday = new Map();
    const weekSubs = new Set();
    for (const s of Store.data.sessions) {
      const k = dateKeyOf(s.start);
      if (k === tk) { daySessions++; subjToday.set(s.subjectId, (subjToday.get(s.subjectId) || 0) + s.duration); }
      if (k.slice(0, 7) === monthPrefix) monthSessions++;
      if (k >= weekStart && k <= Stats.weekEndKey) weekSubs.add(s.subjectId);
    }
    let weekDays = 0, monthDays = 0;
    for (let i = 0; i < 7; i++) if (Stats.daySec(addDaysKey(weekStart, i)) > 0) weekDays++;
    for (const [k, v] of Stats.byDay) if (v > 0 && k.slice(0, 7) === monthPrefix) monthDays++;

    return {
      tk, daysInMonth, dayOfMonth: kp.d,
      daySec: Stats.daySec(tk), daySessions, subjToday,
      weekSec: Stats.weekSec(weekStart), weekDays, weekSubs,
      monthSec: Stats.byMonth.get(monthPrefix) || 0, monthSessions, monthDays,
      subjects: Store.data.subjects
    };
  },

  /** Deterministic daily "featured subject" so the quest is stable all day. */
  dailySubject(ctx) {
    if (!ctx.subjects.length) return null;
    let h = 0;
    for (const ch of ctx.tk) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return ctx.subjects[h % ctx.subjects.length];
  },

  questStates() {
    const c = this.questCtx();
    const S = Store.data.settings;
    const list = [];
    const q = (per, id, name, xp, progress, target, doneOverride) => list.push({
      per, id, name, xp, progress, target,
      done: doneOverride !== undefined ? doneOverride : (target > 0 && progress >= target)
    });

    q('d', 'd:time', 'Revise 30 minutes', 20, Math.min(c.daySec, 1800), 1800);
    q('d', 'd:sessions', 'Finish 2 sessions', 20, Math.min(c.daySessions, 2), 2);
    const feat = this.dailySubject(c);
    if (feat) q('d', 'd:subject', `Give ${feat.name} 10 minutes`, 20, Math.min(c.subjToday.get(feat.id) || 0, 600), 600);
    else q('d', 'd:subject', 'Add your first subject in Setup', 20, c.subjects.length ? 1 : 0, 1);
    q('d', 'd:streak', 'Keep the streak alive', 20, c.daySec > 0 ? 1 : 0, 1);

    q('w', 'w:hours', `${S.weeklyTargetHours || 10} hours this week`, 60, Math.min(c.weekSec, (S.weeklyTargetHours || 10) * 3600), (S.weeklyTargetHours || 10) * 3600);
    q('w', 'w:days', 'Study every day this week', 60, c.weekDays, 7);
    if (c.subjects.length) q('w', 'w:subjects', 'Touch every subject', 60, [...c.weekSubs].filter(id => c.subjects.some(s => s.id === id)).length, c.subjects.length);

    q('m', 'm:hours', '40 hours this month', 150, Math.min(c.monthSec, 144000), 144000);
    q('m', 'm:sessions', '100 sessions this month', 150, Math.min(c.monthSessions, 100), 100);
    q('m', 'm:attend', 'Perfect attendance', 150, c.monthDays, c.daysInMonth, c.monthDays >= c.daysInMonth);

    return list;
  },

  evaluateQuests() {
    const q = Store.data.quests;
    let hit = false;
    for (const st of this.questStates()) {
      if (st.done && !q.awarded[st.id]) {
        q.awarded[st.id] = true;
        Store.data.counters.questsDone += 1;
        hit = true;
        Store.save();
        Sound.cue('quest');
        Toast.show(`Quest complete: ${st.name}  (+${st.xp} XP)`);
        Cat.celebrate('happy');
        if (Math.random() < 0.7) Cat.say(this.questPraise(st));
        this.award(st.xp, 'quest');
      }
    }
    return hit;
  },

  questPraise(st) {
    return Cat.pickOne([
      `“${st.name}” — done. Amazing work today!`,
      `Quest cleared! ${st.xp} XP straight to my little cat heart.`,
      'Another one down. You\u2019re unstoppable.',
      'Cleared it! Treat yourself. And me. Mostly me.'
    ]);
  },

  /* ---- achievements ---- */
  ICONS: {
    paw: 'M12 12.6c-3 0-5.4 2-5.4 4.4 0 1.8 1.4 3.1 3.2 3.1.8 0 1.6-.3 2.2-.8.6.5 1.4.8 2.2.8 1.8 0 3.2-1.3 3.2-3.1 0-2.4-2.4-4.4-5.4-4.4zM6.3 8.1c-1 .1-1.7 1.2-1.6 2.4.1 1.2 1 2.1 2 2s1.7-1.2 1.6-2.4c-.1-1.2-1-2.1-2-2zm11.4 0c-1-.1-1.9.8-2 2-.1 1.2.6 2.3 1.6 2.4 1 .1 1.9-.8 2-2 .1-1.2-.6-2.3-1.6-2.4zM9.4 3.5c-1 .1-1.8 1.3-1.6 2.6.2 1.3 1.1 2.3 2.1 2.2 1-.1 1.8-1.3 1.6-2.6-.2-1.3-1.1-2.3-2.1-2.2zm5.2 0c-1-.1-1.9.9-2.1 2.2-.2 1.3.6 2.5 1.6 2.6 1 .1 1.9-.9 2.1-2.2.2-1.3-.6-2.5-1.6-2.6z',
    star: 'M12 2l2.6 6.6L21 9.3l-5 4.6 1.4 7L12 17.3 6.6 21l1.4-7-5-4.6 6.4-.7L12 2z',
    flame: 'M13.5 2s.7 2.6-1.2 4.9C10.6 9 8.5 10.2 8.5 13a4.6 4.6 0 0 0 4 4.6c-.9-1-.9-2.4.2-3.6.8-.9 1.7-1.3 1.7-2.8 1.6 1 3.1 2.9 3.1 4.8a5.5 5.5 0 1 1-11 .2C6.5 12.4 9.2 10.3 10.7 8.5 12.3 6.7 12.2 4.7 13.5 2z',
    moon: 'M21 14.5A8.5 8.5 0 0 1 9.5 3 8.5 8.5 0 1 0 21 14.5z',
    sun: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0-5 1 3h-2l1-3zm0 20 1-3h-2l1 3zM2 12l3-1v2l-3-1zm20 0-3 1v-2l3 1zM5 5l2.6 1.6L6.2 8 5 5zm14 14-2.6-1.6 1.4-1.4L19 19zM19 5l-1.4 2.8-1.4-1.4L19 5zM5 19l1.4-2.8 1.4 1.4L5 19z',
    book: 'M6 2h13a1 1 0 0 1 1 1v17.5a1.5 1.5 0 0 1-1.5 1.5H6a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3zm0 15a1 1 0 0 0-1 1 1 1 0 0 0 1 1h12v-2H6zM6 4v11h12V4H6z',
    cap: 'M12 3 1 8l11 5 8-3.6V15h2V8L12 3zM5 12.3V16c0 1.7 3.1 3 7 3s7-1.3 7-3v-3.7l-7 3.2-7-3.2z',
    heart: 'M12 21s-7.4-4.6-9.6-9A5.4 5.4 0 0 1 12 6.6 5.4 5.4 0 0 1 21.6 12c-2.2 4.4-9.6 9-9.6 9z',
    bolt: 'M13 2 4 14h6l-1 8 9-12h-6l1-8z',
    cup: 'M6 2h12v2h3v4a4 4 0 0 1-4 4h-.3A6 6 0 0 1 13 15.9V18h3v2H8v-2h3v-2.1A6 6 0 0 1 7.3 12H7a4 4 0 0 1-4-4V4h3V2zm12 4v4a2 2 0 0 0 2-2V6h-2zM6 6H4v2a2 2 0 0 0 2 2V6z'
  },

  buildAch() {
    const A = [];
    const add = (id, name, desc, icon, check) => A.push({ id, name, desc, icon, check });
    const tier = (prefix, icon, values, names, descFn, metric) =>
      values.forEach((v, i) => add(prefix + v, names[i] || descFn(v), descFn(v), icon, c => metric(c) >= v));

    add('m10', 'Cat Nap', 'Study 10 minutes in total', 'paw', c => c.minutes >= 10);

    tier('h', 'book', [1, 5, 10, 25, 50, 100, 200, 350, 500, 750, 1000],
      ['Focused Feline', 'Warmed Up', 'Double Digits', 'Quarter Century', 'Half Century', 'Scholar Cat', 'Double Scholar', 'Sage Whiskers', 'Five Hundred Club', 'Purrfessor', 'Legend of the Library'],
      v => `Study ${v} hour${v === 1 ? '' : 's'} in total`, c => c.hours);

    tier('s', 'star', [1, 5, 10, 25, 50, 100, 200, 350, 500, 750, 1000],
      ['First Paw', 'Finding a Rhythm', 'Ten Sessions', 'Session Collector', 'Fifty Focus', 'Century of Sessions', 'Two Hundred', 'Session Machine', 'Five Hundred Sessions', 'Session Royalty', 'Thousand Lives'],
      v => `Complete ${v} session${v === 1 ? '' : 's'}`, c => c.sessions);

    tier('k', 'flame', [2, 3, 5, 7, 10, 14, 21, 30, 45, 60, 80, 100, 150, 200, 365],
      ['Two in a Row', 'Hat-Trick', 'High Five', 'One Week Wonder', 'Ten Days Strong', 'Fortnight Feline', 'Three Whole Weeks', 'Monthly Mouser', 'Forty-Five Alive', 'Sixty Streak', 'Eighty Club', 'Century Streak', 'Streak 150', 'Two Hundred Days', 'Year-Round Cat'],
      v => `Reach a ${v}-day streak`, c => c.streakLong);

    tier('d', 'sun', [3, 7, 14, 30, 60, 100, 180, 270, 365],
      ['Three Days In', 'A Full Week of Days', 'Fourteen Days', 'Thirty Study Days', 'Sixty Study Days', 'Hundred-Day Cat', '180 Study Days', '270 Study Days', 'A Year of Days'],
      v => `Study on ${v} different days`, c => c.days);

    tier('t', 'bolt', [1, 5, 15, 40, 100, 250],
      ['Task Tamer', 'Tidy Five', 'Fifteen Ticked', 'Forty Finished', 'Hundred Done', 'Task Legend'],
      v => `Complete ${v} task${v === 1 ? '' : 's'}`, c => c.tasksDone);

    tier('q', 'cup', [1, 5, 15, 40, 100, 250],
      ['First Quest', 'Quest Curious', 'Quest Regular', 'Quest Hunter', 'Quest Centurion', 'Quest Legend'],
      v => `Complete ${v} quest${v === 1 ? '' : 's'}`, c => c.questsDone);

    tier('b', 'star', [1, 3, 10, 25],
      ['First Sketch', 'Board Trio', 'Ten Boards', 'Gallery Owner'],
      v => `Create ${v} whiteboard${v === 1 ? '' : 's'}`, c => c.boards);

    tier('l', 'cup', [2, 5, 8, 12, 16, 20, 25, 30, 40, 50],
      ['Level 2', 'Level 5', 'Level 8', 'Level 12', 'Level 16', 'Level 20', 'Level 25', 'Level 30', 'Level 40', 'Level 50'],
      v => `Reach cat level ${v}`, c => c.level);

    tier('p', 'heart', [1, 10, 50, 200],
      ['First Pet', 'Ten Pets', 'Fifty Pets', 'Certified Cat Person'],
      v => `Pet the cat ${v} time${v === 1 ? '' : 's'}`, c => c.pets);

    tier('ss', 'flame', [1500, 2700, 3600, 5400, 7200, 10800],
      ['Pomodoro Pro', 'Deep Forty-Five', 'Hour of Power', 'Ninety-Minute Mind', 'Two-Hour Titan', 'Marathon Mouser'],
      v => `A single session of ${fmtDurShort(v)}`, c => c.maxSession);

    tier('dd', 'sun', [3600, 7200, 10800, 14400, 21600],
      ['Solid Hour Day', 'Two-Hour Day', 'Three-Hour Day', 'Four-Hour Day', 'Six-Hour Day'],
      v => `${fmtDurShort(v)} of study in one day`, c => c.maxDay);

    tier('sub', 'book', [1, 3, 5, 8],
      ['First Subject', 'Trio of Topics', 'Five Subjects', 'Renaissance Cat'],
      v => `Set up ${v} subject${v === 1 ? '' : 's'}`, c => c.subjects);

    tier('n', 'book', [1, 10, 50],
      ['First Note', 'Note Taker', 'Chronicle Keeper'],
      v => `Write notes on ${v} session${v === 1 ? '' : 's'}`, c => c.notes);

    add('nightowl', 'Night Owl', 'Start a session after midnight', 'moon', c => c.nightOwl);
    add('earlybird', 'Early Bird', 'Start a session before 7am', 'sun', c => c.earlyBird);
    add('weekend', 'Weekend Warrior', 'Study on a Saturday or Sunday', 'star', c => c.weekend);
    add('lunch', 'Lunch-Break Learner', 'Start a session between 12 and 2pm', 'sun', c => c.lunch);
    add('ninelives', 'Nine Lives', 'Come back after missing 3+ days', 'heart', c => c.nineLives);
    add('perfweek', 'Perfectionist', 'Hit your daily goal 7 days running', 'cup', c => c.perfectWeek);
    add('perfmonth', 'Perfect Month', 'Hit your daily goal every day of a month', 'cup', c => c.perfectMonth);
    add('export1', 'Backup Buddy', 'Export a backup or a board', 'bolt', c => c.exports >= 1);
    add('import1', 'Time Traveller', 'Restore or import a backup', 'bolt', c => c.imports >= 1);
    add('palette', 'Colour Curator', 'Change the accent palette', 'star', c => c.paletteChanged);
    add('dark', 'Creature of the Dark', 'Use dark mode', 'moon', c => c.darkUsed);
    add('music', 'Musical Paws', 'Play something on the Music page', 'heart', c => c.musicUsed);
    add('hat', 'Dressed Up', 'Equip a hat on your cat', 'cap', c => c.hatOn);
    add('acc', 'Accessorised', 'Equip an accessory', 'star', c => c.accOn);
    add('allround', 'All-Rounder', 'Give every subject at least an hour', 'book', c => c.allRounder);
    add('grad', 'Graduation Day', 'Reach 250 hours with 5+ subjects', 'cap', c => c.hours >= 250 && c.subjects >= 5);

    return A;
  },

  achCtx() {
    const S = Store.data, st = Stats.streaks();
    const targetSec = S.settings.dailyTargetHours * 3600;
    let nightOwl = false, earlyBird = false, weekend = false, lunch = false, notes = 0;
    for (const s of S.sessions) {
      const p = londonParts(s.start);
      if (p.h < 5) nightOwl = true;
      if (p.h < 7) earlyBird = true;
      if (p.h >= 12 && p.h < 14) lunch = true;
      if (s.notes && s.notes.trim()) notes++;
    }
    let maxDay = 0, studyKeys = [];
    for (const [k, v] of Stats.byDay) if (v > 0) { studyKeys.push(k); if (v > maxDay) maxDay = v; if (!weekend) { const wd = weekdayOfKey(k); if (wd === 0 || wd === 6) weekend = true; } }
    studyKeys.sort();
    let nineLives = false;
    for (let i = 1; i < studyKeys.length; i++) {
      let gap = 0, k = studyKeys[i - 1];
      while (addDaysKey(k, 1) < studyKeys[i] && gap < 5) { k = addDaysKey(k, 1); gap++; }
      if (gap >= 3) { nineLives = true; break; }
    }
    let perfectWeek = false, perfectMonth = false;
    if (targetSec > 0) {
      for (const k of studyKeys) {
        let ok = true;
        for (let i = 0; i < 7; i++) if (Stats.daySec(addDaysKey(k, i)) < targetSec) { ok = false; break; }
        if (ok) { perfectWeek = true; break; }
      }
      const goalByMonth = new Map();
      for (const [k, v] of Stats.byDay) if (v >= targetSec) goalByMonth.set(k.slice(0, 7), (goalByMonth.get(k.slice(0, 7)) || 0) + 1);
      for (const [mp, n] of goalByMonth) {
        const [y, m] = mp.split('-').map(Number);
        const dim = new Date(y, m, 0).getDate();
        const complete = mp < Stats.monthPrefix || (mp === Stats.monthPrefix && keyParts(todayKey()).d === dim);
        if (complete && n >= dim) { perfectMonth = true; break; }
      }
    }
    let allRounder = S.subjects.length >= 2;
    for (const sub of S.subjects) {
      const agg = Stats.bySubject.get(sub.id);
      if (!agg || agg.total < 3600) { allRounder = false; break; }
    }
    return {
      minutes: Stats.totalSec / 60, hours: Stats.totalSec / 3600,
      sessions: S.sessions.length, streakLong: Math.max(st.longest, st.current),
      days: studyKeys.length, tasksDone: S.counters.tasksDone, questsDone: S.counters.questsDone,
      boards: Math.max(S.counters.boardsMade, S.boards.length),
      exports: S.counters.exports, imports: S.counters.imports,
      pets: S.pet.pets, level: this.levelInfo().level, subjects: S.subjects.length,
      notes, maxSession: Stats.longest ? Stats.longest.duration : 0, maxDay,
      nightOwl, earlyBird, weekend, lunch, nineLives, perfectWeek, perfectMonth,
      paletteChanged: S.settings.palette !== 'indigo', darkUsed: S.settings.theme === 'dark',
      musicUsed: !!S.music.last, hatOn: S.pet.hat !== 'none', accOn: S.pet.acc !== 'none',
      allRounder
    };
  },

  _achQueue: [], _achShowing: false,

  evaluateAch(silent = false) {
    const c = this.achCtx();
    const fresh = [];
    for (const def of this.ACH) {
      if (!Store.data.ach[def.id] && def.check(c)) {
        Store.data.ach[def.id] = Date.now();
        fresh.push(def);
      }
    }
    if (!fresh.length) return false;
    Store.save();
    this.award(fresh.length * 25, 'achievement');
    if (silent) {
      Toast.show(`${fresh.length} achievement${fresh.length === 1 ? '' : 's'} from your history — see the Quests page.`, { duration: 5200 });
    } else if (fresh.length > 3) {
      Sound.cue('fanfare');
      Cat.celebrate('excited');
      Toast.show(`${fresh.length} achievements unlocked! 🐾`, { duration: 5200 });
    } else {
      fresh.forEach(def => this._achQueue.push(def));
      this.pumpAchQueue();
    }
    return true;
  },

  pumpAchQueue() {
    if (this._achShowing || !this._achQueue.length) return;
    this._achShowing = true;
    const def = this._achQueue.shift();
    Sound.cue('fanfare');
    Cat.celebrate('excited');
    Cat.say(`Achievement unlocked: “${def.name}”!`, 5200);
    const card = el('div', 'ach-toast-card');
    card.innerHTML = `
      <span class="ach-badge"><svg viewBox="0 0 24 24"><path d="${this.ICONS[def.icon] || this.ICONS.paw}"/></svg></span>
      <span><span class="ach-kicker">Achievement unlocked</span><br><strong>${escapeHtml(def.name)}</strong><br><span class="ach-desc">${escapeHtml(def.desc)} · +25 XP</span></span>`;
    document.body.appendChild(card);
    if (!REDUCED_MOTION && Store.data.settings.fx) FX.burst(innerWidth / 2, 90, 12);
    setTimeout(() => { card.remove(); this._achShowing = false; this.pumpAchQueue(); }, 5000);
  },

  /* ---- lifecycle ---- */
  onCommit() {
    if (!Store.data) return;
    this.refreshPeriods();
    const a = this.evaluateQuests();
    const b = this.evaluateAch();
    this.updateChip();
    if ((a || b) && currentView === 'quests') renderQuestView();
  },

  init() {
    this.ACH = this.buildAch();
    this.refreshPeriods();
    this.updateChip();
    this.evaluateAch(true);       // history counts, without a firework barrage
    this.evaluateQuests();
  }
};

/* ═══ 29. Pet wardrobe & progression ═════════════════════════════════════ */

const Pet = {
  HATS: [
    { id: 'none',   name: 'No hat',        lv: 1,  svg: '' },
    { id: 'party',  name: 'Party hat',     lv: 2,  svg: '<path d="M64 26 L80 -6 L96 26 Z" fill="#f492b5"/><path d="M67 20 L93 20 L96 26 L64 26 Z" fill="#e97ba4"/><circle cx="80" cy="-6" r="5" fill="#ffe45c"/>' },
    { id: 'beanie', name: 'Cosy beanie',   lv: 4,  svg: '<path d="M56 24 Q80 -4 104 24 L104 31 Q80 23 56 31 Z" fill="#8fb7f4"/><circle cx="80" cy="-1" r="5.5" fill="#fff"/>' },
    { id: 'crown',  name: 'Little crown',  lv: 8,  svg: '<path d="M60 24 L64 5 L74 17 L80 1 L86 17 L96 5 L100 24 Z" fill="#e8c04c" stroke="#d3a835" stroke-width="1.5"/><circle cx="80" cy="20" r="2.4" fill="#d84a54"/>' },
    { id: 'wizard', name: 'Wizard hat',    lv: 12, svg: '<path d="M62 24 L84 -24 L100 24 Z" fill="#7d6bd9"/><ellipse cx="81" cy="24" rx="25" ry="6" fill="#6a58c8"/><path d="M84 -8 l2.6 5.4 6 .8-4.4 4.2 1 5.9-5.2-2.8-5.2 2.8 1-5.9L75.4 -1.8l6-.8L84 -8z" fill="#ffe45c"/>' },
    { id: 'grad',   name: 'Graduation cap', lv: 16, svg: '<path d="M50 12 L80 0 L110 12 L80 24 Z" fill="#414a6b"/><path d="M66 18 v6 q14 8 28 0 v-6" fill="#333a56"/><path d="M108 13 v13" stroke="#e8c04c" stroke-width="2"/><circle cx="108" cy="28" r="2.6" fill="#e8c04c"/>' },
    { id: 'halo',   name: 'Halo',          lv: 25, svg: '<ellipse cx="80" cy="0" rx="19" ry="5.5" fill="none" stroke="#ffe45c" stroke-width="4.5"/>' }
  ],
  ACCS: [
    { id: 'none',       name: 'Nothing',      lv: 1,  svg: '' },
    { id: 'bow',        name: 'Bow tie',      lv: 3,  svg: '<path d="M79 93 L64 85 L64 101 Z" fill="#f06292"/><path d="M81 93 L96 85 L96 101 Z" fill="#f06292"/><circle cx="80" cy="93" r="4.6" fill="#d94f7f"/>' },
    { id: 'glasses',    name: 'Round glasses', lv: 6, svg: '<g fill="none" stroke="#31405e" stroke-width="2.6"><circle cx="66" cy="58" r="10.5"/><circle cx="94" cy="58" r="10.5"/><path d="M76.5 58 h7"/><path d="M55.5 55 l-8 -3"/><path d="M104.5 55 l8 -3"/></g>' },
    { id: 'scarf',      name: 'Winter scarf', lv: 10, svg: '<path d="M58 87 Q80 100 102 87 L102 96 Q80 109 58 96 Z" fill="#d84a54"/><path d="M69 96 h10 v15 q-5 3 -10 0 Z" fill="#c43f49"/>' },
    { id: 'headphones', name: 'Headphones',   lv: 14, svg: '<path d="M52 54 Q52 14 80 14 Q108 14 108 54" fill="none" stroke="#31405e" stroke-width="5.5"/><rect x="45" y="48" width="12" height="19" rx="5.5" fill="#31405e"/><rect x="103" y="48" width="12" height="19" rx="5.5" fill="#31405e"/>' },
    { id: 'monocle',    name: 'Monocle',      lv: 20, svg: '<circle cx="94" cy="58" r="10.5" fill="none" stroke="#31405e" stroke-width="2.6"/><path d="M100 67 q6 10 2 18" fill="none" stroke="#31405e" stroke-width="1.6"/>' }
  ],
  TITLES: [[1, 'Curious Kitten'], [3, 'House Cat'], [5, 'Study Buddy'], [8, 'Clever Cat'], [12, 'Focus Familiar'], [16, 'Scholar Cat'], [20, 'Sage of Sessions'], [25, 'Purrfessor'], [30, 'Grand Purrfessor'], [40, 'Archmage of Naps'], [50, 'Mythical Study Beast']],

  title(level) {
    let t = this.TITLES[0][1];
    for (const [lv, name] of this.TITLES) if (level >= lv) t = name;
    return t;
  },

  unlocksAt(level) {
    const out = [];
    for (const h of this.HATS) if (h.lv === level) out.push(h.name);
    for (const a of this.ACCS) if (a.lv === level) out.push(a.name);
    for (const [lv, name] of this.TITLES) if (lv === level) out.push(`title “${name}”`);
    return out;
  },

  dress(rootEl) {
    if (!rootEl) return;
    const hat = this.HATS.find(h => h.id === Store.data.pet.hat) || this.HATS[0];
    const acc = this.ACCS.find(a => a.id === Store.data.pet.acc) || this.ACCS[0];
    const hs = $('.cat-hat-slot', rootEl), as = $('.cat-acc-slot', rootEl);
    if (hs) hs.innerHTML = hat.svg;
    if (as) as.innerHTML = acc.svg;
  },

  dressEverywhere() {
    this.dress($('#cat-stage'));
    this.dress($('#pet-stage'));
  }
};

/* ═══ 30. Quests · Achievements · Pet view ═══════════════════════════════ */

let achFilter = 'all';

function questCountdowns() {
  const now = Date.now(), p = londonParts(now);
  const midnight = londonEpoch(p.y, p.mo, p.d, 24, 0, 0);
  const hrs = Math.max(1, Math.round((midnight - now) / 3600000));
  const tk = todayKey();
  const daysLeftWeek = 6 - (function () { let d = 0, k = Stats.weekStartKey; while (k < tk && d < 6) { k = addDaysKey(k, 1); d++; } return d; })();
  const kp = keyParts(tk);
  const dim = new Date(kp.y, kp.m, 0).getDate();
  return {
    d: `resets in ~${hrs}h`,
    w: daysLeftWeek === 0 ? 'last day!' : `${daysLeftWeek} day${daysLeftWeek === 1 ? '' : 's'} left`,
    m: `${dim - kp.d === 0 ? 'last day!' : (dim - kp.d) + ' days left'}`
  };
}

function questItemHtml(st) {
  const timeBased = st.target > 120;   // seconds vs counts
  const label = timeBased
    ? `${fmtDurShort(Math.round(st.progress))} / ${fmtDurShort(st.target)}`
    : `${Math.min(st.progress, st.target)} / ${st.target}`;
  const pct = st.target ? clamp(Math.round(st.progress / st.target * 100), 0, 100) : 0;
  return `
    <li class="quest-item${st.done ? ' is-done' : ''}">
      <div class="quest-item-top"><span class="quest-name">${escapeHtml(st.name)}</span><span class="quest-xp">+${st.xp} XP</span></div>
      <div class="paw-progress"><div class="paw-progress-fill" style="width:${st.done ? 100 : pct}%"></div></div>
      <div class="quest-progress-label">${st.done ? 'Complete' : escapeHtml(label)}</div>
    </li>`;
}

function renderQuestView() {
  const tab = Store.data.ui.questTab;
  $$('#quest-tabs .seg-btn').forEach(b => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', String(on));
  });
  $('#panel-quests').hidden = tab !== 'quests';
  $('#panel-awards').hidden = tab !== 'awards';
  $('#panel-pet').hidden = tab !== 'pet';

  if (tab === 'quests') {
    const states = Game.questStates();
    const cd = questCountdowns();
    $('#quest-reset-d').textContent = cd.d;
    $('#quest-reset-w').textContent = cd.w;
    $('#quest-reset-m').textContent = cd.m;
    for (const [per, sel] of [['d', '#quests-daily'], ['w', '#quests-weekly'], ['m', '#quests-monthly']]) {
      $(sel).innerHTML = states.filter(s => s.per === per).map(questItemHtml).join('');
    }
  } else if (tab === 'awards') {
    const total = Game.ACH.length;
    const got = Game.ACH.filter(a => Store.data.ach[a.id]).length;
    $('#ach-summary').innerHTML = `<strong>${got} / ${total}</strong> unlocked · ${Math.round(got / total * 100)}%`;
    $$('#ach-filter .seg-btn').forEach(b => {
      const on = b.dataset.f === achFilter;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    const list = Game.ACH.filter(a => {
      const un = !!Store.data.ach[a.id];
      return achFilter === 'all' || (achFilter === 'unlocked' ? un : !un);
    });
    $('#ach-grid').innerHTML = list.map(a => {
      const ts = Store.data.ach[a.id];
      return `
        <div class="ach-card ${ts ? 'is-unlocked' : 'is-locked'}">
          <span class="ach-badge"><svg viewBox="0 0 24 24"><path d="${Game.ICONS[a.icon] || Game.ICONS.paw}"/></svg></span>
          <span><div class="ach-name">${escapeHtml(a.name)}</div><div class="ach-desc">${escapeHtml(a.desc)}</div>${ts ? `<div class="ach-date">${fmtFullDate(ts)}</div>` : ''}</span>
        </div>`;
    }).join('') || '<p class="muted">Nothing here yet — go earn some!</p>';
  } else {
    renderPetPanel();
  }
}

function renderPetPanel() {
  const stage = $('#pet-stage');
  if (stage && !stage.firstChild) stage.innerHTML = Cat.svgMarkup();
  Pet.dress(stage);
  const li = Game.levelInfo();
  const nameInput = $('#pet-name');
  if (nameInput && document.activeElement !== nameInput) nameInput.value = Cat.name();
  $('#pet-level').textContent = 'Level ' + li.level;
  $('#pet-title').textContent = Pet.title(li.level);
  $('#pet-xp-fill').style.width = Math.round(li.into / li.need * 100) + '%';
  $('#pet-xp-label').textContent = `${li.into} / ${li.need} XP to level ${li.level + 1} · ${Store.data.pet.xp} XP total`;
  $('#pet-facts').textContent = `${Cat.name()} has been petted ${Store.data.pet.pets} time${Store.data.pet.pets === 1 ? '' : 's'} and cheered you through ${Store.data.sessions.length} session${Store.data.sessions.length === 1 ? '' : 's'}.`;

  const row = (items, kind, current) => items.map(it => {
    const locked = li.level < it.lv;
    const preview = `<svg viewBox="40 -28 80 130">${it.svg || '<circle cx="80" cy="40" r="3" fill="var(--text-3)"/>'}</svg>`;
    return `<button class="unlock-item${current === it.id ? ' is-on' : ''}${locked ? ' is-locked' : ''}" data-kind="${kind}" data-id="${it.id}" ${locked ? 'disabled' : ''} title="${locked ? 'Unlocks at level ' + it.lv : escapeHtml(it.name)}">${preview}<span>${locked ? 'Lv ' + it.lv : escapeHtml(it.name)}</span></button>`;
  }).join('');
  $('#pet-hats').innerHTML = row(Pet.HATS, 'hat', Store.data.pet.hat);
  $('#pet-accs').innerHTML = row(Pet.ACCS, 'acc', Store.data.pet.acc);
  $$('#panel-pet .unlock-item:not(.is-locked)').forEach(b => b.addEventListener('click', () => {
    Store.data.pet[b.dataset.kind] = b.dataset.id;
    Store.save();
    Pet.dressEverywhere();
    Sound.cue('pop');
    Cat.setState('happy');
    Game.onCommit();
    renderPetPanel();
  }));

  const milestones = [];
  for (const h of Pet.HATS.slice(1)) milestones.push([h.lv, h.name]);
  for (const a of Pet.ACCS.slice(1)) milestones.push([a.lv, a.name]);
  for (const [lv, t] of Pet.TITLES.slice(1)) milestones.push([lv, `Title: ${t}`]);
  milestones.sort((a, b) => a[0] - b[0]);
  $('#pet-track').innerHTML = milestones.map(([lv, label]) =>
    `<li class="${li.level >= lv ? 'is-hit' : ''}"><span class="lv-dot">Lv ${lv}</span><span>${escapeHtml(label)}</span></li>`).join('');
}

/* ═══ 31. Tasks ══════════════════════════════════════════════════════════ */

const Tasks = {
  editing: null,   // task id currently in inline edit

  ensure() {
    const D = Store.data;
    if (!D.taskLists.length) D.taskLists.push({ id: uid(), name: 'My tasks' });
    if (!D.taskLists.some(l => l.id === D.ui.taskList)) D.ui.taskList = D.taskLists[0].id;
  },

  list() { return Store.data.taskLists.find(l => l.id === Store.data.ui.taskList); },
  ofList(id) { return Store.data.tasks.filter(t => t.listId === id); },

  add(fields) {
    const listId = Store.data.ui.taskList;
    const order = Math.max(0, ...this.ofList(listId).map(t => t.order + 1));
    Store.data.tasks.push({
      id: uid(), listId, title: fields.title, notes: fields.notes || '',
      priority: fields.priority, deadline: fields.deadline || null,
      subjectId: fields.subjectId || '', category: (fields.category || '').trim(),
      recur: fields.recur || 'none', done: false, doneAt: null,
      created: Date.now(), order
    });
    commit();
  },

  nextDeadline(key, recur) {
    if (!key) return null;
    if (recur === 'daily') return addDaysKey(key, 1);
    if (recur === 'weekly') return addDaysKey(key, 7);
    const { y, m, d } = keyParts(key);
    const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
    const dim = new Date(ny, nm, 0).getDate();
    return `${ny}-${pad2(nm)}-${pad2(Math.min(d, dim))}`;
  },

  toggle(id, on) {
    const t = Store.data.tasks.find(x => x.id === id);
    if (!t || t.done === on) return;
    t.done = on;
    t.doneAt = on ? Date.now() : null;
    if (on) {
      Store.data.counters.tasksDone += 1;
      Sound.cue('pop');
      if (t.recur !== 'none') {
        const order = Math.max(0, ...this.ofList(t.listId).map(x => x.order + 1));
        Store.data.tasks.push({ ...t, id: uid(), done: false, doneAt: null, created: Date.now(), order, deadline: this.nextDeadline(t.deadline || todayKey(), t.recur) });
      }
      if (Math.random() < 0.35) Cat.say(Cat.pickOne(['Task down! *paw bump*', 'Tick. Very satisfying.', 'One less thing on the pile.']));
    }
    commit();
    if (on) Game.award(5, 'task');
  },

  remove(id) {
    const idx = Store.data.tasks.findIndex(t => t.id === id);
    if (idx === -1) return;
    const [gone] = Store.data.tasks.splice(idx, 1);
    commit();
    Toast.show('Task deleted.', {
      actionLabel: 'Undo',
      onAction: () => { Store.data.tasks.push(gone); commit(); }
    });
  },

  chips(t) {
    const bits = [];
    bits.push(`<span class="task-chip pri-${t.priority}">${['Low', 'Medium', 'High'][t.priority]}</span>`);
    if (t.deadline) {
      const tk = todayKey();
      const cls = !t.done && t.deadline < tk ? ' is-late' : !t.done && t.deadline <= addDaysKey(tk, 1) ? ' is-soon' : '';
      bits.push(`<span class="task-chip${cls}">${escapeHtml(fmtDayShort(t.deadline))}</span>`);
    }
    if (t.subjectId) {
      const sub = subjectById(t.subjectId);
      if (sub) bits.push(`<span class="task-chip chip-subject" style="background:${sub.color}">${escapeHtml(sub.name)}</span>`);
    }
    if (t.category) bits.push(`<span class="task-chip">${escapeHtml(t.category)}</span>`);
    if (t.recur !== 'none') bits.push(`<span class="task-chip chip-recur">${t.recur}</span>`);
    return bits.join('');
  },

  rowHtml(t, archived) {
    return `
      <li class="task-row${t.done ? ' is-done' : ''}" data-id="${t.id}" ${archived ? '' : 'draggable="true"'}>
        ${archived ? '' : `<span class="task-grip btn-icon" title="Drag to reorder" aria-hidden="true"><svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/><circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/></svg></span>`}
        <input type="checkbox" class="task-check" ${t.done ? 'checked' : ''} aria-label="Mark ${escapeHtml(t.title)} ${t.done ? 'not done' : 'done'}">
        <span class="task-main">
          <span class="task-title">${escapeHtml(t.title)}</span>
          <span class="task-meta">${this.chips(t)}</span>
          ${t.notes ? `<span class="task-notes">${escapeHtml(t.notes)}</span>` : ''}
        </span>
        <span class="task-actions">
          ${archived ? '' : `<button class="btn-icon" data-act="edit" aria-label="Edit task"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.2V21h3.8L17.9 9.9l-3.8-3.8L3 17.2zM20.7 7.1a1 1 0 0 0 0-1.4l-2.4-2.4a1 1 0 0 0-1.4 0l-1.8 1.8 3.8 3.8 1.8-1.8z"/></svg></button>`}
          <button class="btn-icon" data-act="del" aria-label="Delete task"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 3h6l1 2h4v2H4V5h4l1-2zM6 9h12l-1 12H7L6 9z"/></svg></button>
        </span>
      </li>`;
  },

  editorHtml(t) {
    const subs = Store.data.subjects.map(s => `<option value="${s.id}" ${s.id === t.subjectId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('');
    const recur = ['none', 'daily', 'weekly', 'monthly'].map(r => `<option value="${r}" ${r === t.recur ? 'selected' : ''}>${r === 'none' ? 'No repeat' : r[0].toUpperCase() + r.slice(1)}</option>`).join('');
    return `
      <li class="task-row" data-editing="${t.id}">
        <form class="task-editor add-task" style="grid-column:1/-1;margin:0">
          <input name="title" maxlength="200" required value="${escapeHtml(t.title)}" aria-label="Title">
          <textarea name="notes" rows="2" maxlength="2000" placeholder="Notes…" aria-label="Notes" style="resize:vertical;padding:9px 11px;border:1px solid var(--border);border-radius:10px;background:var(--surface);color:var(--text);font:inherit">${escapeHtml(t.notes)}</textarea>
          <div class="add-task-opts">
            <select name="priority" aria-label="Priority"><option value="0" ${t.priority === 0 ? 'selected' : ''}>Low</option><option value="1" ${t.priority === 1 ? 'selected' : ''}>Medium</option><option value="2" ${t.priority === 2 ? 'selected' : ''}>High</option></select>
            <input type="date" name="deadline" value="${t.deadline || ''}" aria-label="Deadline">
            <select name="subjectId" aria-label="Subject"><option value="">No subject</option>${subs}</select>
            <input name="category" maxlength="40" value="${escapeHtml(t.category)}" placeholder="Category" aria-label="Category">
            <select name="recur" aria-label="Repeat">${recur}</select>
            <button class="btn btn-sm" type="submit">Save</button>
            <button class="btn btn-ghost btn-sm" type="button" data-cancel>Cancel</button>
          </div>
        </form>
      </li>`;
  },

  render() {
    this.ensure();
    const D = Store.data, active = this.list();

    $('#tasklist-nav').innerHTML = D.taskLists.map(l => {
      const open = this.ofList(l.id).filter(t => !t.done).length;
      return `<li class="${l.id === active.id ? 'is-active' : ''}"><button data-id="${l.id}"><span>${escapeHtml(l.name)}</span><span class="tasklist-count">${open}</span></button></li>`;
    }).join('');
    $$('#tasklist-nav button').forEach(b => b.addEventListener('click', () => {
      D.ui.taskList = b.dataset.id; Store.save(); this.render();
    }));

    $('#tasklist-title').textContent = active.name;
    const all = this.ofList(active.id);
    const done = all.filter(t => t.done);
    const open = all.filter(t => !t.done).sort((a, b) => a.order - b.order);
    const pct = all.length ? Math.round(done.length / all.length * 100) : 0;
    $('#tasklist-progress').style.width = pct + '%';
    $('#tasklist-progress-label').textContent = all.length ? `${done.length} of ${all.length} done · ${pct}%` : 'Nothing yet — this bar fills as you tick things off.';

    const subjSel = $('#new-task-subject');
    subjSel.innerHTML = '<option value="">No subject</option>' + D.subjects.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
    $('#task-cats').innerHTML = [...new Set(D.tasks.map(t => t.category).filter(Boolean))].map(c => `<option value="${escapeHtml(c)}">`).join('');

    $('#task-items').innerHTML = open.map(t => this.editing === t.id ? this.editorHtml(t) : this.rowHtml(t, false)).join('');
    $('#tasks-empty').hidden = open.length > 0;
    $('#task-archive-count').textContent = done.length;
    $('#task-archive').innerHTML = done.sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).map(t => this.rowHtml(t, true)).join('');

    this.bindRows();
  },

  bindRows() {
    $$('#task-items .task-row, #task-archive .task-row').forEach(row => {
      const id = row.dataset.id || row.dataset.editing;
      const chk = $('.task-check', row);
      if (chk) chk.addEventListener('change', () => {
        if (chk.checked) row.classList.add('is-done-anim');
        setTimeout(() => this.toggle(id, chk.checked), chk.checked ? 320 : 0);
      });
      $$('[data-act]', row).forEach(b => b.addEventListener('click', () => {
        if (b.dataset.act === 'del') this.remove(id);
        else { this.editing = id; this.render(); }
      }));
      const form = $('.task-editor', row);
      if (form) {
        form.addEventListener('submit', e => {
          e.preventDefault();
          const t = Store.data.tasks.find(x => x.id === id);
          const f = new FormData(form);
          Object.assign(t, {
            title: String(f.get('title')).trim().slice(0, 200) || t.title,
            notes: String(f.get('notes')).slice(0, 2000),
            priority: +f.get('priority'),
            deadline: /^\d{4}-\d{2}-\d{2}$/.test(f.get('deadline')) ? f.get('deadline') : null,
            subjectId: String(f.get('subjectId') || ''),
            category: String(f.get('category')).trim().slice(0, 40),
            recur: String(f.get('recur'))
          });
          this.editing = null;
          commit();
        });
        $('[data-cancel]', form).addEventListener('click', () => { this.editing = null; this.render(); });
      }
    });

    // Drag-to-reorder within the open list.
    const wrap = $('#task-items');
    let dragId = null;
    $$('#task-items .task-row[draggable]').forEach(row => {
      row.addEventListener('dragstart', e => {
        dragId = row.dataset.id;
        row.classList.add('is-dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', dragId); } catch (_) {}
      });
      row.addEventListener('dragend', () => { row.classList.remove('is-dragging'); $$('.task-row.is-over', wrap).forEach(r => r.classList.remove('is-over')); });
      row.addEventListener('dragover', e => {
        e.preventDefault();
        if (row.dataset.id !== dragId) row.classList.add('is-over');
      });
      row.addEventListener('dragleave', () => row.classList.remove('is-over'));
      row.addEventListener('drop', e => {
        e.preventDefault();
        row.classList.remove('is-over');
        if (!dragId || row.dataset.id === dragId) return;
        const listId = Store.data.ui.taskList;
        const open = this.ofList(listId).filter(t => !t.done).sort((a, b) => a.order - b.order);
        const from = open.findIndex(t => t.id === dragId);
        const to = open.findIndex(t => t.id === row.dataset.id);
        if (from === -1 || to === -1) return;
        const [moved] = open.splice(from, 1);
        open.splice(to, 0, moved);
        open.forEach((t, i) => { t.order = i; });
        commit();
      });
    });
  },

  newList() {
    const dlg = Modal.open(`
      <div class="modal-head"><h3 class="modal-title">New task list</h3><button class="modal-close" aria-label="Close">✕</button></div>
      <form id="newlist-form" class="add-task" style="padding:0 2px 6px"><input id="newlist-name" maxlength="60" placeholder="e.g. Exam prep" required>
      <div class="modal-foot"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" type="submit">Create</button></div></form>`, { narrow: true });
    $('#newlist-form', dlg).addEventListener('submit', e => {
      e.preventDefault();
      const name = $('#newlist-name', dlg).value.trim();
      if (!name) return;
      const l = { id: uid(), name: name.slice(0, 60) };
      Store.data.taskLists.push(l);
      Store.data.ui.taskList = l.id;
      Modal.close();
      commit();
    });
  },

  renameList() {
    const l = this.list();
    const dlg = Modal.open(`
      <div class="modal-head"><h3 class="modal-title">Rename list</h3><button class="modal-close" aria-label="Close">✕</button></div>
      <form id="renlist-form" class="add-task" style="padding:0 2px 6px"><input id="renlist-name" maxlength="60" value="${escapeHtml(l.name)}" required>
      <div class="modal-foot"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save</button></div></form>`, { narrow: true });
    $('#renlist-form', dlg).addEventListener('submit', e => {
      e.preventDefault();
      l.name = $('#renlist-name', dlg).value.trim().slice(0, 60) || l.name;
      Modal.close();
      commit();
    });
  },

  async deleteList() {
    const l = this.list();
    const n = this.ofList(l.id).length;
    const ok = await Modal.confirm({
      title: `Delete “${l.name}”?`,
      message: n ? `Its ${n} task${n === 1 ? '' : 's'} will be deleted too. This cannot be undone.` : 'The list is empty.',
      confirmLabel: 'Delete list', danger: true
    });
    if (!ok) return;
    Store.data.tasks = Store.data.tasks.filter(t => t.listId !== l.id);
    Store.data.taskLists = Store.data.taskLists.filter(x => x.id !== l.id);
    this.ensure();
    commit();
  }
};

/* ═══ 32. Music (Spotify) ════════════════════════════════════════════════ */

const Music = {
  SHORTS: [
    { e: '🎧', name: 'Lo-fi Beats', sub: 'chilled hip-hop', type: 'playlist', id: '37i9dQZF1DWWQRwui0ExPn' },
    { e: '🌫️', name: 'Deep Focus', sub: 'ambient concentration', type: 'playlist', id: '37i9dQZF1DWZeKCadgRdKQ' },
    { e: '🎹', name: 'Peaceful Piano', sub: 'gentle keys', type: 'playlist', id: '37i9dQZF1DX4sWSpwq3LiO' },
    { e: '🎻', name: 'Classical Essentials', sub: 'the great works', type: 'playlist', id: '37i9dQZF1DWWEJlAGA9gs0' },
    { e: '🎸', name: 'Instrumental Study', sub: 'no lyrics, all flow', type: 'playlist', id: '37i9dQZF1DX9sIqqvKsjG8' },
    { e: '🌧️', name: 'Rain Sounds', sub: 'steady downpour', type: 'playlist', id: '37i9dQZF1DX8ymr6UES7vc' },
    { e: '📻', name: 'White Noise', sub: 'pure background', type: 'playlist', id: '37i9dQZF1DWUZ5bk6qqDSy' }
  ],
  iframe: null,

  parse(url) {
    if (!url) return null;
    url = url.trim();
    let m = url.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]+)/i);
    if (m) return { type: m[1].toLowerCase(), id: m[2] };
    m = url.match(/^spotify:(track|album|playlist|episode|show|artist):([A-Za-z0-9]+)$/i);
    if (m) return { type: m[1].toLowerCase(), id: m[2] };
    return null;
  },

  load(type, id, label, { fromRestore = false } = {}) {
    const wrap = $('#dock-frame-wrap');
    if (!wrap) return;
    const src = `https://open.spotify.com/embed/${type}/${id}`;
    if (!this.iframe) {
      this.iframe = document.createElement('iframe');
      this.iframe.setAttribute('allow', 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture');
      this.iframe.setAttribute('loading', 'lazy');
      this.iframe.title = 'Spotify player';
      wrap.appendChild(this.iframe);
    }
    if (this.iframe.src !== src) this.iframe.src = src;
    $('#dock-label').textContent = label || (type[0].toUpperCase() + type.slice(1));

    Store.data.music.last = `https://open.spotify.com/${type}/${id}`;
    if (!fromRestore) {
      Store.data.music.dock = currentView === 'music' ? 'open' : 'mini';
      Game.onCommit();
      if (Math.random() < 0.5) Cat.say(Cat.pickOne(['Ooh, tunes. I\u2019ll conduct with my tail.', 'Good choice. Focus mode: engaged.', '*sways gently*']));
    } else if (Store.data.music.dock === 'open' && currentView !== 'music') {
      Store.data.music.dock = 'mini';
    }
    Store.save();
    this.applyDock();
  },

  setDock(mode) {
    Store.data.music.dock = mode;
    Store.save();
    this.applyDock();
  },

  applyDock() {
    const dock = $('#music-dock');
    if (!dock) return;
    const mode = Store.data.music.dock;
    const hasMedia = !!this.iframe;
    dock.classList.toggle('is-hidden', !hasMedia || mode === 'hidden');
    dock.classList.toggle('dock-mini', mode === 'mini');
    const page = hasMedia && mode === 'open' && currentView === 'music';
    dock.classList.toggle('dock-page', page);
    if (page) {
      const anchor = $('#player-anchor');
      if (anchor) {
        const r = anchor.getBoundingClientRect();
        dock.style.left = Math.round(r.left) + 'px';
        dock.style.top = Math.round(r.top) + 'px';
        dock.style.width = Math.round(r.width) + 'px';
        dock.style.right = 'auto'; dock.style.bottom = 'auto';
      }
    } else {
      dock.style.left = ''; dock.style.top = ''; dock.style.width = '';
      dock.style.right = ''; dock.style.bottom = '';
      if (mode === 'open' && currentView !== 'music') { Store.data.music.dock = 'mini'; Store.save(); dock.classList.add('dock-mini'); }
    }
  },

  render() {
    const shorts = $('#music-shorts');
    if (shorts && !shorts.firstChild) {
      shorts.innerHTML = this.SHORTS.map((s, i) => `
        <button class="music-short" data-i="${i}">
          <span class="ms-emoji" aria-hidden="true">${s.e}</span>
          <span class="ms-name">${s.name}</span>
          <span class="ms-sub">${s.sub}</span>
        </button>`).join('');
      $$('.music-short', shorts).forEach(b => b.addEventListener('click', () => {
        const s = this.SHORTS[+b.dataset.i];
        this.load(s.type, s.id, s.name);
      }));
    }
    const lastEl = $('#music-last');
    if (lastEl) lastEl.textContent = Store.data.music.last ? `Last played: ${Store.data.music.last}` : '';
    const anchor = $('#player-anchor');
    if (anchor) anchor.firstElementChild.textContent = this.iframe
      ? 'The player is docked below — it keeps playing wherever you go.'
      : 'Load something above and the player appears here — it stays docked when you leave this page.';
    if (this.iframe && Store.data.music.dock === 'mini') { Store.data.music.dock = 'open'; Store.save(); }
    this.applyDock();
  },

  restore() {
    const p = this.parse(Store.data.music.last);
    if (p) {
      const short = this.SHORTS.find(s => s.id === p.id);
      this.load(p.type, p.id, short ? short.name : null, { fromRestore: true });
    } else {
      this.applyDock();
    }
  }
};

/* ═══ 33. Consistency dashboard ══════════════════════════════════════════ */

function hourlyBuckets() {
  const buckets = new Array(24).fill(0);
  for (const s of Store.data.sessions) {
    let t = s.start;
    const end = s.start + s.duration * 1000;
    while (t < end) {
      const p = londonParts(t);
      const hourEnd = t + ((59 - p.mi) * 60 + (60 - p.s)) * 1000;
      const chunk = Math.min(end, hourEnd) - t;
      buckets[p.h] += chunk / 1000;
      t += chunk;
    }
  }
  return buckets;
}

function consistencyStats() {
  const tk = todayKey();
  const st = Stats.streaks();
  const daysStudiedIn = n => {
    let c = 0;
    for (let i = 0; i < n; i++) if (Stats.daySec(addDaysKey(tk, -i)) > 0) c++;
    return c;
  };
  const kp = keyParts(tk);
  const dayOfYear = (() => { let c = 0, k = `${kp.y}-01-01`; while (k <= tk) { c++; k = addDaysKey(k, 1); } return c; })();

  let weekElapsed = 1, k = Stats.weekStartKey;
  while (k < tk) { k = addDaysKey(k, 1); weekElapsed++; }
  let weekDays = 0;
  for (let i = 0; i < weekElapsed; i++) if (Stats.daySec(addDaysKey(Stats.weekStartKey, i)) > 0) weekDays++;

  let monthDays = 0, yearDays = 0;
  for (const [key, v] of Stats.byDay) {
    if (v <= 0) continue;
    if (key.slice(0, 7) === Stats.monthPrefix) monthDays++;
    if (key.slice(0, 4) === String(kp.y)) yearDays++;
  }

  const targetSec = Store.data.settings.dailyTargetHours * 3600;
  let goalDays30 = 0, missed30 = 0;
  for (let i = 0; i < 30; i++) {
    const sec = Stats.daySec(addDaysKey(tk, -i));
    if (sec <= 0) missed30++;
    else if (targetSec > 0 && sec >= targetSec) goalDays30++;
  }

  const wd = Stats.byWeekday;
  const hasAny = wd.some(v => v > 0);
  let best = -1, worst = -1;
  if (hasAny) {
    best = wd.indexOf(Math.max(...wd));
    worst = wd.indexOf(Math.min(...wd));
  }
  const buckets = hourlyBuckets();
  const peakHour = buckets.some(v => v > 0) ? buckets.indexOf(Math.max(...buckets)) : -1;

  // month-over-month: study days this month so far vs same span last month
  const lastMp = (() => { const y = kp.m === 1 ? kp.y - 1 : kp.y; const m = kp.m === 1 ? 12 : kp.m - 1; return `${y}-${pad2(m)}`; })();
  let lastMonthDaysSameSpan = 0;
  for (const [key, v] of Stats.byDay) {
    if (v > 0 && key.slice(0, 7) === lastMp && keyParts(key).d <= kp.d) lastMonthDaysSameSpan++;
  }

  return {
    st, weekPct: Math.round(weekDays / weekElapsed * 100),
    monthPct: Math.round(monthDays / kp.d * 100),
    yearPct: Math.round(yearDays / dayOfYear * 100),
    goalPct30: Math.round(goalDays30 / 30 * 100), missed30,
    best, worst, peakHour, buckets,
    monthDays, lastMonthDaysSameSpan, targetSec
  };
}

const WD_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function hourLabel(h) { const ap = h < 12 ? 'am' : 'pm'; const v = h % 12 === 0 ? 12 : h % 12; return v + ap; }

function renderConsistency() {
  const c = consistencyStats();
  const tiles = [
    { label: 'Current streak', value: c.st.current + (c.st.current === 1 ? ' day' : ' days'), extra: 'consecutive days with revision' },
    { label: 'Longest streak', value: c.st.longest + (c.st.longest === 1 ? ' day' : ' days'), extra: 'your record' },
    { label: 'This week', value: c.weekPct + '%', extra: 'of days so far had revision' },
    { label: 'This month', value: c.monthPct + '%', extra: 'of days so far had revision' },
    { label: 'This year', value: c.yearPct + '%', extra: 'of days so far had revision' },
    { label: 'Goal hit rate', value: c.targetSec > 0 ? c.goalPct30 + '%' : '—', extra: 'daily goal met, last 30 days' },
    { label: 'Missed days', value: String(c.missed30), extra: 'in the last 30 days' },
    { label: 'Best weekday', value: c.best > -1 ? WD_NAMES[c.best] : '—', extra: 'most total revision' },
    { label: 'Quietest weekday', value: c.worst > -1 ? WD_NAMES[c.worst] : '—', extra: 'least total revision' },
    { label: 'Golden hour', value: c.peakHour > -1 ? hourLabel(c.peakHour) + '–' + hourLabel((c.peakHour + 1) % 24) : '—', extra: 'when you study most' }
  ];
  $('#cons-tiles').innerHTML = tiles.map(t => `
    <div class="stat-tile"><div class="t-label">${t.label}</div><div class="t-value">${escapeHtml(t.value)}</div><div class="t-extra">${escapeHtml(t.extra)}</div></div>`).join('');

  const advice = [];
  if (c.peakHour > -1) advice.push(`You revise best between ${hourLabel(c.peakHour)} and ${hourLabel((c.peakHour + 2) % 24)} — protect that window.`);
  if (c.worst > -1 && c.best !== c.worst && Stats.byDay.size >= 7) advice.push(`${WD_NAMES[c.worst]}s are usually your quietest day. Even 15 minutes would smooth the dip.`);
  if (c.lastMonthDaysSameSpan > 0) {
    const delta = Math.round((c.monthDays - c.lastMonthDaysSameSpan) / c.lastMonthDaysSameSpan * 100);
    if (delta > 0) advice.push(`You're ${delta}% more consistent than at this point last month. Keep it rolling.`);
    else if (delta < 0) advice.push(`You're ${Math.abs(delta)}% less consistent than last month — one small session today turns it around.`);
    else advice.push('You are exactly as consistent as last month. Steady paws.');
  }
  if (c.st.current >= 3) advice.push(`A ${c.st.current}-day streak is live right now. Tomorrow's session keeps it breathing.`);
  else if (c.missed30 > 10) advice.push(`${c.missed30} quiet days this month. Try anchoring revision to something you already do daily.`);
  if (c.targetSec > 0 && c.goalPct30 >= 70) advice.push(`You hit your daily goal ${c.goalPct30}% of the time — genuinely excellent.`);
  if (!advice.length) advice.push('Log a few sessions and I\u2019ll start spotting your patterns.');
  $('#cons-advice').innerHTML = advice.map(a => `<li>${escapeHtml(a)}</li>`).join('');

  const hasData = c.buckets.some(v => v > 0);
  chartEmptyOverlay('chart-hourly', !hasData, '');
  $('#chart-hourly-empty').hidden = hasData;
  if (hasData && Charts.ok()) {
    Charts.make('chart-hourly', {
      type: 'bar',
      data: {
        labels: Array.from({ length: 24 }, (_, h) => hourLabel(h)),
        datasets: [{ data: c.buckets.map(v => +(v / 3600).toFixed(2)), backgroundColor: Charts.cssVar('--paw') || '#f7a76c', borderRadius: 5, maxBarThickness: 26 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { ...Charts.tooltipBase(), callbacks: { label: ctx => fmtDur(Math.round(ctx.parsed.y * 3600)) } } },
        scales: {
          x: { grid: { display: false }, ticks: { color: Charts.cssVar('--text-3'), maxRotation: 0, autoSkip: true } },
          y: { beginAtZero: true, grid: { color: Charts.cssVar('--border') }, ticks: { color: Charts.cssVar('--text-3'), callback: v => v + 'h' } }
        }
      }
    });
  } else {
    Charts.destroy('chart-hourly');
  }

  const hm = $('#cons-heatmap');
  if (!$('#cons-heat-grid')) hm.innerHTML = '<div class="heatmap-scroll"><div id="cons-heat-grid" class="heatmap" role="img" aria-label="Daily revision heatmap"></div></div>';
  renderHeatmap('#cons-heat-grid');
}

/* ═══ 34. Whiteboard studio ══════════════════════════════════════════════
   A zoomable vector canvas. Elements live as data (strokes, shapes,
   text); an offscreen "content" layer replays them — eraser strokes use
   destination-out there — and is composited over the chosen paper each
   frame. Every edit is an invertible op (undo/redo) and every board
   autosaves to LocalStorage with a thumbnail.                            */

const Board = {
  BGS: {
    blank:   { label: 'Blank',        paper: '#ffffff' },
    dots:    { label: 'Dot grid',     paper: '#ffffff' },
    grid:    { label: 'Square grid',  paper: '#ffffff' },
    ruled:   { label: 'Ruled paper',  paper: '#fffdf6' },
    graph:   { label: 'Graph paper',  paper: '#fbfdff' },
    cornell: { label: 'Cornell notes', paper: '#fffdf6' },
    dark:    { label: 'Dark paper',   paper: '#232733' },
    light:   { label: 'Light paper',  paper: '#fbf6ea' }
  },

  TOOLS: [
    ['pen', 'Pen', 'M3 17.2V21h3.8L17.9 9.9l-3.8-3.8L3 17.2zM20.7 7.1a1 1 0 0 0 0-1.4l-2.4-2.4a1 1 0 0 0-1.4 0l-1.8 1.8 3.8 3.8 1.8-1.8z'],
    ['pencil', 'Pencil', 'M4 20l1-4 11.5-11.5a1.4 1.4 0 0 1 2 0l1 1a1.4 1.4 0 0 1 0 2L8 19l-4 1zM14 6l4 4'],
    ['highlighter', 'Highlighter', 'M4 21h16v-2H4v2zM9.5 4.5 6 12l2.5 2.5 1 1L17 8l-3.5-3.5a2 2 0 0 0-4 0zM6.8 13.6 5 17h4l.4-.9-2.6-2.5z'],
    ['marker', 'Marker', 'M7 3h10v6l-2 2v10H9V11L7 9V3zm2 2v3.2l2 2V19h2v-8.8l2-2V5H9z'],
    ['eraser', 'Eraser', 'M16.2 3.6 21 8.4a2 2 0 0 1 0 2.8l-8.8 8.8H7l-4-4a2 2 0 0 1 0-2.8l10.4-10.4a2 2 0 0 1 2.8.8zM5 15.6 8.4 19h2.4l2.3-2.3-4.9-4.9L5 15.6zM14 21h7v-2h-5l-2 2z'],
    'sep',
    ['line', 'Straight line', 'M4.5 19.5 19.5 4.5l1.4 1.4L5.9 20.9 4.5 19.5z'],
    ['arrow', 'Arrow', 'M4.5 19.5 16 8h-5V6h9v9h-2v-5L5.9 20.9 4.5 19.5z'],
    ['rect', 'Rectangle', 'M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6zm2 0v12h14V6H5z'],
    ['circle', 'Circle', 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zm0 2a7 7 0 1 0 0 14 7 7 0 0 0 0-14z'],
    ['triangle', 'Triangle', 'M12 3.5 22 20H2L12 3.5zm0 3.9L5.5 18h13L12 7.4z'],
    'sep',
    ['text', 'Text', 'M4 5h16v3h-2V7h-5v11h2v2H9v-2h2V7H6v1H4V5z'],
    'sep',
    ['select', 'Select (box)', 'M4 4h3v2H6v1H4V4zm7 0h3v2h-3V4zm7 0h-1v3h-2V5 4h3zm0 7v3h-2v-3h2zM4 11h2v3H4v-3zm0 7v-1h2v1h1v2H4v-2zm14 0h-1v2h3v-3h-2v1zm-7 0h3v2h-3v-2z'],
    ['lasso', 'Lasso select', 'M12 3c5 0 9 2.7 9 6 0 2.9-3 5.2-7 5.8v1.2a3 3 0 1 1-2-.1v-1.1C8 14.2 5 11.9 5 9c0-3.3 3.1-6 7-6zm0 2C8.9 5 7 6.9 7 9s1.9 4 5 4 5-1.9 5-4-1.9-4-5-4zm-1 12a1 1 0 1 0 2 0 1 1 0 0 0-2 0z'],
    ['move', 'Move', 'M12 2l3 3h-2v4h4V7l3 3-3 3v-2h-4v4h2l-3 3-3-3h2v-4H7v2l-3-3 3-3v2h4V5H9l3-3z']
  ],

  PRESETS: ['#31405e', '#000000', '#d84a54', '#e8a13c', '#ffe45c', '#1d9a6c', '#14b8c4', '#2f6fdd', '#8a56c9', '#e560a8', '#6b7280', '#ffffff'],

  studio: null, wrap: null, cv: null, ctx: null, content: null, cctx: null,
  overlay: null, dpr: 1, cssW: 0, cssH: 0,
  prefs: null, activeId: null,
  view: { x: 0, y: 0, s: 1 },
  undoStack: [], redoStack: [],
  sel: new Set(),
  live: null,            // in-progress {mode, ...}
  pointers: new Map(),
  spaceHeld: false,
  _saveT: 0, _dirty: false, _lastStamp: 0, _libOpen: false,

  /* ---------- data access ---------- */
  board() { return Store.data.boards.find(b => b.id === this.activeId) || null; },

  defaultPrefs() {
    return { tool: 'pen', color: '#31405e', size: 4, opacity: 100, smooth: 55, pressure: true, recent: [], favs: [], activeBoard: '', lastBg: 'blank' };
  },

  /* ---------- lifecycle ---------- */
  init() {
    this.studio = $('#studio');
    if (!this.studio) return;
    this.wrap = $('#canvas-wrap');
    this.cv = $('#board-canvas');
    this.overlay = $('#board-overlay');
    this.ctx = this.cv.getContext && this.cv.getContext('2d');
    if (this.ctx) {
      this.content = document.createElement('canvas');
      this.cctx = this.content.getContext('2d');
    }

    const stored = Store.data.boardPrefs;
    this.prefs = Object.assign(this.defaultPrefs(), (stored && typeof stored === 'object') ? stored : {});
    if (!Array.isArray(this.prefs.recent)) this.prefs.recent = [];
    if (!Array.isArray(this.prefs.favs)) this.prefs.favs = [];
    Store.data.boardPrefs = this.prefs;   // live reference: every Store.save persists brush settings

    if (!Store.data.boards.length) this.create('My first board', { animate: false, silent: true });
    this.activeId = Store.data.boards.some(b => b.id === this.prefs.activeBoard)
      ? this.prefs.activeBoard : Store.data.boards[0].id;
    this.prefs.activeBoard = this.activeId;
    const b = this.board();
    this.view = { ...b.view };

    this.buildToolRail();
    this.bindUI();
    this.bindPointer();
    this.syncUI();
    this.resize();
  },

  /** The studio node moves between the Home card and the full Board view. */
  mount(slot) {
    if (!this.studio || !slot) return;
    if (this.studio.parentElement !== slot) {
      slot.appendChild(this.studio);
      this.closeTextEditor(true);
    }
    this.resize();
  },

  resize() {
    if (!this.wrap || !this.cv) return;
    const r = this.wrap.getBoundingClientRect();
    if (r.width < 5 || r.height < 5) return;
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.cssW = r.width; this.cssH = r.height;
    const pw = Math.round(r.width * this.dpr), ph = Math.round(r.height * this.dpr);
    if (this.cv.width !== pw || this.cv.height !== ph) {
      this.cv.width = pw; this.cv.height = ph;
      if (this.content) { this.content.width = pw; this.content.height = ph; }
    }
    this.render();
  },

  /* ---------- coordinates ---------- */
  toWorld(sx, sy) { return [(sx - this.view.x) / this.view.s, (sy - this.view.y) / this.view.s]; },
  toScreen(wx, wy) { return [wx * this.view.s + this.view.x, wy * this.view.s + this.view.y]; },
  eventPoint(e) {
    const r = this.cv.getBoundingClientRect();
    return this.toWorld(e.clientX - r.left, e.clientY - r.top);
  },

  worldTransform(c) { c.setTransform(this.dpr * this.view.s, 0, 0, this.dpr * this.view.s, this.dpr * this.view.x, this.dpr * this.view.y); },

  /* ---------- rendering ---------- */
  paperColor() { const bg = this.BGS[this.board()?.bg] || this.BGS.blank; return bg.paper; },
  isDarkPaper() { return this.board()?.bg === 'dark'; },

  drawPaper(c) {
    const b = this.board();
    if (!b) return;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = this.paperColor();
    c.fillRect(0, 0, this.cv.width, this.cv.height);

    const [wx0, wy0] = this.toWorld(0, 0);
    const [wx1, wy1] = this.toWorld(this.cssW, this.cssH);
    this.worldTransform(c);
    const dark = b.bg === 'dark';
    const faint = dark ? 'rgba(255,255,255,0.08)' : 'rgba(49,64,94,0.10)';
    const strong = dark ? 'rgba(255,255,255,0.14)' : 'rgba(49,64,94,0.18)';
    const lw = 1 / this.view.s;
    const from = (step, v) => Math.floor(v / step) * step;

    if (b.bg === 'dots') {
      const step = 26;
      c.fillStyle = faint;
      const r = Math.max(0.8, 1.1) / Math.sqrt(this.view.s);
      if ((wx1 - wx0) / step < 400) {
        for (let x = from(step, wx0); x <= wx1; x += step)
          for (let y = from(step, wy0); y <= wy1; y += step) { c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); }
      }
    } else if (b.bg === 'grid' || b.bg === 'graph') {
      const minor = b.bg === 'graph' ? 13 : 26;
      const major = b.bg === 'graph' ? 65 : 0;
      if ((wx1 - wx0) / minor < 900) {
        c.lineWidth = lw; c.strokeStyle = faint; c.beginPath();
        for (let x = from(minor, wx0); x <= wx1; x += minor) { c.moveTo(x, wy0); c.lineTo(x, wy1); }
        for (let y = from(minor, wy0); y <= wy1; y += minor) { c.moveTo(wx0, y); c.lineTo(wx1, y); }
        c.stroke();
        if (major) {
          c.strokeStyle = strong; c.beginPath();
          for (let x = from(major, wx0); x <= wx1; x += major) { c.moveTo(x, wy0); c.lineTo(x, wy1); }
          for (let y = from(major, wy0); y <= wy1; y += major) { c.moveTo(wx0, y); c.lineTo(wx1, y); }
          c.stroke();
        }
      }
    } else if (b.bg === 'ruled' || b.bg === 'cornell') {
      const step = 30;
      if ((wy1 - wy0) / step < 700) {
        c.lineWidth = lw; c.strokeStyle = faint; c.beginPath();
        for (let y = from(step, wy0); y <= wy1; y += step) { c.moveTo(wx0, y); c.lineTo(wx1, y); }
        c.stroke();
      }
      if (b.bg === 'cornell') {
        c.lineWidth = 2 / this.view.s;
        c.strokeStyle = 'rgba(216,74,84,0.45)';
        c.beginPath(); c.moveTo(180, wy0); c.lineTo(180, wy1); c.stroke();
      } else {
        c.lineWidth = 1.4 / this.view.s;
        c.strokeStyle = 'rgba(216,74,84,0.35)';
        c.beginPath(); c.moveTo(70, wy0); c.lineTo(70, wy1); c.stroke();
      }
    }
  },

  rebuildContent() {
    if (!this.cctx) return;
    const c = this.cctx, b = this.board();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.content.width, this.content.height);
    if (!b) return;
    this.worldTransform(c);
    for (const elx of b.els) this.drawEl(c, elx);
  },

  compose() {
    if (!this.ctx) return;
    this.drawPaper(this.ctx);
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.content) this.ctx.drawImage(this.content, 0, 0);
  },

  render() {
    if (!this.ctx) return;
    this.rebuildContent();
    this.compose();
    this.renderSelection();
    const pct = $('#zoom-pct');
    if (pct) pct.textContent = Math.round(this.view.s * 100) + '%';
  },

  strokeStyleFor(c, elx) {
    c.lineJoin = 'round';
    c.lineCap = elx.tool === 'highlighter' || elx.tool === 'marker' ? 'butt' : 'round';
    c.globalCompositeOperation = elx.tool === 'eraser' ? 'destination-out' : 'source-over';
    const op = (elx.op ?? 100) / 100;
    c.globalAlpha = elx.tool === 'highlighter' ? op * 0.32 : elx.tool === 'pencil' ? op * 0.8 : elx.tool === 'eraser' ? 1 : op;
    c.strokeStyle = elx.color || '#31405e';
    c.fillStyle = c.strokeStyle;
  },

  widthFor(elx) {
    const s = elx.size || 4;
    return elx.tool === 'highlighter' ? s * 2.4 : elx.tool === 'marker' ? s * 1.8 : elx.tool === 'eraser' ? s * 1.8 : elx.tool === 'pencil' ? Math.max(1, s * 0.8) : s;
  },

  drawEl(c, elx) {
    c.save();
    if (elx.t === 'stroke') {
      this.strokeStyleFor(c, elx);
      const w = this.widthFor(elx);
      const pts = elx.pts;
      if (!pts || !pts.length) { c.restore(); return; }
      if (pts.length === 1) {
        c.beginPath(); c.arc(pts[0][0], pts[0][1], (w * (pts[0][2] || 1)) / 2, 0, 7); c.fill();
        c.restore(); return;
      }
      const varies = this.prefsVary(elx);
      if (varies) {
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1], bpt = pts[i];
          c.lineWidth = Math.max(0.4, w * (((a[2] || 1) + (bpt[2] || 1)) / 2));
          c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(bpt[0], bpt[1]); c.stroke();
        }
      } else {
        c.lineWidth = w;
        c.beginPath();
        c.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length - 1; i++) {
          const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
          c.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
        }
        const last = pts[pts.length - 1];
        c.lineTo(last[0], last[1]);
        c.stroke();
      }
    } else if (elx.t === 'shape') {
      this.strokeStyleFor(c, { ...elx, tool: 'pen' });
      c.lineWidth = elx.size || 4;
      const { x1, y1, x2, y2 } = elx;
      c.beginPath();
      if (elx.kind === 'line' || elx.kind === 'arrow') {
        c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
        if (elx.kind === 'arrow') {
          const ang = Math.atan2(y2 - y1, x2 - x1);
          const hl = Math.max(10, (elx.size || 4) * 3.4);
          c.beginPath();
          c.moveTo(x2, y2);
          c.lineTo(x2 - hl * Math.cos(ang - 0.44), y2 - hl * Math.sin(ang - 0.44));
          c.moveTo(x2, y2);
          c.lineTo(x2 - hl * Math.cos(ang + 0.44), y2 - hl * Math.sin(ang + 0.44));
          c.stroke();
        }
      } else if (elx.kind === 'rect') {
        c.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      } else if (elx.kind === 'circle') {
        c.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, 7);
        c.stroke();
      } else if (elx.kind === 'triangle') {
        c.moveTo((x1 + x2) / 2, Math.min(y1, y2));
        c.lineTo(Math.min(x1, x2), Math.max(y1, y2));
        c.lineTo(Math.max(x1, x2), Math.max(y1, y2));
        c.closePath(); c.stroke();
      }
    } else if (elx.t === 'text') {
      c.globalAlpha = 1;
      c.fillStyle = elx.color || '#31405e';
      c.font = `500 ${elx.size || 18}px "Instrument Sans", system-ui, sans-serif`;
      c.textBaseline = 'top';
      const lines = String(elx.text || '').split('\n');
      lines.forEach((ln, i) => c.fillText(ln, elx.x, elx.y + i * (elx.size || 18) * 1.28));
    }
    c.restore();
  },

  prefsVary(elx) {
    if (!['pen', 'pencil', 'marker'].includes(elx.tool)) return false;
    const pts = elx.pts;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i][2];
      if (p !== undefined && Math.abs(p - 1) > 0.06) return true;
    }
    return false;
  },

  /* ---------- geometry ---------- */
  elBounds(elx) {
    if (elx.t === 'stroke') {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of elx.pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
      const pad = this.widthFor(elx) / 2 + 2;
      return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
    }
    if (elx.t === 'shape') {
      const pad = (elx.size || 4) / 2 + 2;
      return { x0: Math.min(elx.x1, elx.x2) - pad, y0: Math.min(elx.y1, elx.y2) - pad, x1: Math.max(elx.x1, elx.x2) + pad, y1: Math.max(elx.y1, elx.y2) + pad };
    }
    const size = elx.size || 18;
    const lines = String(elx.text || '').split('\n');
    let wmax = 10;
    if (this.cctx) {
      this.cctx.save();
      this.cctx.setTransform(1, 0, 0, 1, 0, 0);
      this.cctx.font = `500 ${size}px "Instrument Sans", system-ui, sans-serif`;
      for (const ln of lines) wmax = Math.max(wmax, this.cctx.measureText(ln).width);
      this.cctx.restore();
    } else {
      wmax = Math.max(...lines.map(l => l.length)) * size * 0.55;
    }
    return { x0: elx.x - 2, y0: elx.y - 2, x1: elx.x + wmax + 2, y1: elx.y + lines.length * size * 1.28 + 2 };
  },

  samplePoints(elx) {
    if (elx.t === 'stroke') {
      const out = [];
      for (let i = 0; i < elx.pts.length; i += Math.max(1, Math.floor(elx.pts.length / 24))) out.push([elx.pts[i][0], elx.pts[i][1]]);
      return out;
    }
    const b = this.elBounds(elx);
    return [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1], [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2]];
  },

  contentBounds() {
    const b = this.board();
    if (!b || !b.els.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const elx of b.els) {
      if (elx.t === 'stroke' && elx.tool === 'eraser') continue;
      const bb = this.elBounds(elx);
      x0 = Math.min(x0, bb.x0); y0 = Math.min(y0, bb.y0);
      x1 = Math.max(x1, bb.x1); y1 = Math.max(y1, bb.y1);
    }
    if (x0 === Infinity) return null;
    return { x0, y0, x1, y1 };
  },

  /* ---------- ops / undo ---------- */
  pushOp(op) {
    this.undoStack.push(op);
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack.length = 0;
    this.changed();
    this.syncUndoButtons();
  },

  applyOp(op, dir) {   // dir +1 = redo/apply, -1 = undo
    const b = this.board();
    if (!b) return;
    if (op.t === 'add') {
      if (dir > 0) b.els.push(op.el);
      else { const i = b.els.indexOf(op.el); if (i > -1) b.els.splice(i, 1); this.sel.delete(op.el); }
    } else if (op.t === 'remove') {
      if (dir > 0) {
        for (const [, elx] of op.items) { const i = b.els.indexOf(elx); if (i > -1) b.els.splice(i, 1); this.sel.delete(elx); }
      } else {
        for (const [idx, elx] of op.items.slice().sort((a, z) => a[0] - z[0])) b.els.splice(Math.min(idx, b.els.length), 0, elx);
      }
    } else if (op.t === 'move') {
      const dx = op.dx * dir, dy = op.dy * dir;
      for (const elx of op.els) this.translateEl(elx, dx, dy);
    } else if (op.t === 'bg') {
      b.bg = dir > 0 ? op.to : op.from;
      const sel = $('#board-bg'); if (sel) sel.value = b.bg;
    } else if (op.t === 'props') {
      Object.assign(op.el, dir > 0 ? op.after : op.before);
    }
  },

  translateEl(elx, dx, dy) {
    if (elx.t === 'stroke') { for (const p of elx.pts) { p[0] += dx; p[1] += dy; } }
    else if (elx.t === 'shape') { elx.x1 += dx; elx.y1 += dy; elx.x2 += dx; elx.y2 += dy; }
    else { elx.x += dx; elx.y += dy; }
  },

  undo() { const op = this.undoStack.pop(); if (!op) return; this.applyOp(op, -1); this.redoStack.push(op); this.changed(); this.syncUndoButtons(); },
  redo() { const op = this.redoStack.pop(); if (!op) return; this.applyOp(op, +1); this.undoStack.push(op); this.changed(); this.syncUndoButtons(); },

  syncUndoButtons() {
    const u = $('#board-undo'), r = $('#board-redo');
    if (u) u.disabled = !this.undoStack.length;
    if (r) r.disabled = !this.redoStack.length;
  },

  changed() {
    this._dirty = true;
    this.render();
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => this.saveNow(), 800);
  },

  flush() { if (this._dirty) { clearTimeout(this._saveT); this.saveNow(); } },

  saveNow() {
    const b = this.board();
    if (!b) return;
    b.edited = Date.now();
    b.view = { x: this.view.x, y: this.view.y, s: this.view.s };
    this.makeThumb(b);
    this._dirty = false;
    Store.save();
    if (Date.now() - this._lastStamp > 45000) { this._lastStamp = Date.now(); this.pawStamp(); }
    if (this._libOpen) this.renderLib();
  },

  makeThumb(b) {
    if (!this.ctx) return;
    try {
      const t = document.createElement('canvas');
      t.width = 240; t.height = 150;
      const tc = t.getContext('2d');
      if (!tc) return;
      tc.fillStyle = this.BGS[b.bg] ? this.BGS[b.bg].paper : '#fff';
      tc.fillRect(0, 0, 240, 150);
      const bb = this.contentBounds();
      if (bb) {
        const m = 14;
        const scale = Math.min((240 - m * 2) / Math.max(20, bb.x1 - bb.x0), (150 - m * 2) / Math.max(20, bb.y1 - bb.y0), 2);
        tc.setTransform(scale, 0, 0, scale,
          (240 - (bb.x1 - bb.x0) * scale) / 2 - bb.x0 * scale,
          (150 - (bb.y1 - bb.y0) * scale) / 2 - bb.y0 * scale);
        for (const elx of b.els) this.drawEl(tc, elx);
      }
      b.thumb = t.toDataURL('image/jpeg', 0.55);
    } catch (_) { /* thumbnails are decorative */ }
  }
};

/* ── Whiteboard: input, tools, UI, library, lifecycle, export ─────────── */

const PAW_SVG = '<svg viewBox="0 0 24 24" fill="rgba(247,167,108,.85)"><path d="M12 12.6c-3 0-5.4 2-5.4 4.4 0 1.8 1.4 3.1 3.2 3.1.8 0 1.6-.3 2.2-.8.6.5 1.4.8 2.2.8 1.8 0 3.2-1.3 3.2-3.1 0-2.4-2.4-4.4-5.4-4.4zM6.3 8.1c-1 .1-1.7 1.2-1.6 2.4.1 1.2 1 2.1 2 2s1.7-1.2 1.6-2.4c-.1-1.2-1-2.1-2-2zm11.4 0c-1-.1-1.9.8-2 2-.1 1.2.6 2.3 1.6 2.4 1 .1 1.9-.8 2-2 .1-1.2-.6-2.3-1.6-2.4zM9.4 3.5c-1 .1-1.8 1.3-1.6 2.6.2 1.3 1.1 2.3 2.1 2.2 1-.1 1.8-1.3 1.6-2.6-.2-1.3-1.1-2.3-2.1-2.2zm5.2 0c-1-.1-1.9.9-2.1 2.2-.2 1.3.6 2.5 1.6 2.6 1 .1 1.9-.9 2.1-2.2.2-1.3-.6-2.5-1.6-2.6z"/></svg>';

function relTime(ts) {
  const d = Date.now() - ts;
  if (d < 60000) return 'just now';
  if (d < 3600000) return Math.round(d / 60000) + 'm ago';
  if (d < 86400000) return Math.round(d / 3600000) + 'h ago';
  if (d < 86400000 * 14) return Math.round(d / 86400000) + 'd ago';
  return fmtFullDate(ts);
}

Object.assign(Board, {

  fxOn() { return Store.data.settings.fx && !REDUCED_MOTION; },

  /* ---------- tool rail & brush UI ---------- */
  buildToolRail() {
    const rail = $('#tool-rail');
    rail.innerHTML = '';
    for (const t of this.TOOLS) {
      if (t === 'sep') { rail.appendChild(el('div', 'tool-sep')); continue; }
      const [id, label, path] = t;
      const b = el('button', 'tool-btn');
      b.type = 'button'; b.dataset.tool = id; b.title = label; b.setAttribute('aria-label', label);
      b.innerHTML = `<svg viewBox="0 0 24 24"><path d="${path}"/></svg>`;
      b.addEventListener('click', () => this.setTool(id));
      rail.appendChild(b);
    }
  },

  setTool(t) {
    this.commitTextEditor();
    this.prefs.tool = t;
    this.savePrefs();
    if (!['select', 'lasso', 'move'].includes(t)) this.setSel(new Set());
    this.syncUI();
  },

  cursorClass() {
    const t = this.prefs.tool;
    return t === 'text' ? 'cursor-text' : t === 'move' ? 'cursor-move' : ['select', 'lasso'].includes(t) ? '' : 'cursor-draw';
  },

  savePrefs: debounce(function () { Store.save(); }, 400),

  syncUI() {
    $$('#tool-rail .tool-btn').forEach(b => b.classList.toggle('is-active', b.dataset.tool === this.prefs.tool));
    this.wrap.className = 'canvas-wrap ' + this.cursorClass();
    const b = this.board();
    const name = $('#board-name'); if (name && document.activeElement !== name) name.value = b ? b.name : '';
    const bg = $('#board-bg'); if (bg && b) bg.value = this.BGS[b.bg] ? b.bg : 'blank';
    $('#brush-swatch').style.background = this.prefs.color;
    $('#brush-size').value = this.prefs.size; $('#brush-size-out').textContent = this.prefs.size;
    $('#brush-opacity').value = this.prefs.opacity; $('#brush-opacity-out').textContent = this.prefs.opacity + '%';
    $('#brush-smooth').value = this.prefs.smooth; $('#brush-smooth-out').textContent = this.prefs.smooth + '%';
    $('#brush-pressure').checked = !!this.prefs.pressure;
    this.syncColorFields();
    this.renderSwatches();
    this.syncUndoButtons();
  },

  syncColorFields() {
    const hex = this.prefs.color;
    const hi = $('#brush-hex'); if (hi && document.activeElement !== hi) hi.value = hex;
    const n = v => parseInt(hex.slice(v, v + 2), 16);
    for (const [id, off] of [['#brush-r', 1], ['#brush-g', 3], ['#brush-b', 5]]) {
      const inp = $(id); if (inp && document.activeElement !== inp) inp.value = n(off);
    }
    const ci = $('#brush-color'); if (ci) ci.value = hex;
  },

  setColor(hex, remember = false) {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) return;
    this.prefs.color = hex.toLowerCase();
    if (remember) {
      this.prefs.recent = [this.prefs.color, ...this.prefs.recent.filter(c => c !== this.prefs.color)].slice(0, 10);
    }
    this.savePrefs();
    $('#brush-swatch').style.background = this.prefs.color;
    this.syncColorFields();
    this.renderSwatches();
  },

  renderSwatches() {
    const mk = (colors, extraTitle = '') => colors.map(c =>
      `<button class="swatch" style="background:${c}" data-c="${c}" title="${c}${extraTitle}" aria-label="Colour ${c}"></button>`).join('');
    $('#preset-colors').innerHTML = mk(this.PRESETS);
    $('#recent-colors').innerHTML = this.prefs.recent.length ? mk(this.prefs.recent) : '<span class="muted small">Colours you draw with land here.</span>';
    $('#fav-colors').innerHTML = this.prefs.favs.length ? mk(this.prefs.favs, ' — Alt+click removes') : '<span class="muted small">None saved yet.</span>';
    $$('#color-pop .swatch').forEach(s => s.addEventListener('click', e => {
      if (e.altKey && s.parentElement.id === 'fav-colors') {
        this.prefs.favs = this.prefs.favs.filter(c => c !== s.dataset.c);
        this.savePrefs(); this.renderSwatches(); return;
      }
      this.setColor(s.dataset.c, true);
    }));
  },

  /* ---------- static bindings ---------- */
  bindUI() {
    $('#board-name').addEventListener('input', e => {
      const b = this.board(); if (!b) return;
      b.name = e.target.value.slice(0, 80) || 'Untitled board';
      this._dirty = true;
      clearTimeout(this._saveT);
      this._saveT = setTimeout(() => this.saveNow(), 800);
    });

    $('#board-bg').addEventListener('change', e => {
      const b = this.board(); if (!b) return;
      const to = e.target.value;
      const op = { t: 'bg', from: b.bg, to };
      b.bg = to;
      this.prefs.lastBg = to;
      this.pushOp(op);
    });

    $('#board-new').addEventListener('click', () => this.create());
    $('#board-library-btn').addEventListener('click', () => this._libOpen ? this.closeLib() : this.openLib());
    $('#lib-close').addEventListener('click', () => this.closeLib());
    $('#lib-search').addEventListener('input', () => this.renderLib());
    $('#lib-sort').addEventListener('change', e => { Store.data.ui.boardSort = e.target.value; Store.save(); this.renderLib(); });

    const expBtn = $('#board-export-btn'), expMenu = $('#board-export-menu');
    expBtn.addEventListener('click', () => {
      const open = expMenu.hidden;
      expMenu.hidden = !open;
      expBtn.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('pointerdown', e => {
      if (!expMenu.hidden && !e.target.closest('.menu-wrap')) { expMenu.hidden = true; expBtn.setAttribute('aria-expanded', 'false'); }
      const pop = $('#color-pop');
      if (pop && !pop.hidden && !e.target.closest('#color-pop, #brush-swatch')) { pop.hidden = true; $('#brush-swatch').setAttribute('aria-expanded', 'false'); }
    });
    $$('#board-export-menu button').forEach(b => b.addEventListener('click', () => {
      expMenu.hidden = true;
      this.export(b.dataset.exp);
    }));

    $('#board-undo').addEventListener('click', () => this.undo());
    $('#board-redo').addEventListener('click', () => this.redo());
    $('#board-clear').addEventListener('click', () => this.clearBoard());
    $('#board-delete').addEventListener('click', () => this.removeBoard(this.activeId));

    $('#zoom-in').addEventListener('click', () => this.zoomAt(this.cssW / 2, this.cssH / 2, 1.25));
    $('#zoom-out').addEventListener('click', () => this.zoomAt(this.cssW / 2, this.cssH / 2, 0.8));
    $('#zoom-fit').addEventListener('click', () => this.fit());

    const swatch = $('#brush-swatch'), pop = $('#color-pop');
    swatch.addEventListener('click', () => {
      pop.hidden = !pop.hidden;
      swatch.setAttribute('aria-expanded', String(!pop.hidden));
    });
    $('#brush-color').addEventListener('input', e => this.setColor(e.target.value));
    $('#brush-color').addEventListener('change', e => this.setColor(e.target.value, true));
    $('#brush-hex').addEventListener('change', e => {
      let v = e.target.value.trim();
      if (/^[0-9a-f]{6}$/i.test(v)) v = '#' + v;
      this.setColor(v, true);
      this.syncColorFields();
    });
    for (const id of ['#brush-r', '#brush-g', '#brush-b']) {
      $(id).addEventListener('change', () => {
        const c = ['#brush-r', '#brush-g', '#brush-b'].map(s => clamp(Math.round(+$(s).value || 0), 0, 255));
        this.setColor('#' + c.map(v => v.toString(16).padStart(2, '0')).join(''), true);
      });
    }
    $('#fav-add').addEventListener('click', () => {
      if (!this.prefs.favs.includes(this.prefs.color)) {
        this.prefs.favs = [this.prefs.color, ...this.prefs.favs].slice(0, 12);
        this.savePrefs(); this.renderSwatches();
      }
    });
    $('#brush-size').addEventListener('input', e => { this.prefs.size = clamp(+e.target.value, 1, 60); $('#brush-size-out').textContent = this.prefs.size; this.savePrefs(); });
    $('#brush-opacity').addEventListener('input', e => { this.prefs.opacity = clamp(+e.target.value, 5, 100); $('#brush-opacity-out').textContent = this.prefs.opacity + '%'; this.savePrefs(); });
    $('#brush-smooth').addEventListener('input', e => { this.prefs.smooth = clamp(+e.target.value, 0, 100); $('#brush-smooth-out').textContent = this.prefs.smooth + '%'; this.savePrefs(); });
    $('#brush-pressure').addEventListener('change', e => { this.prefs.pressure = e.target.checked; this.savePrefs(); });

    addEventListener('resize', debounce(() => this.resize(), 120));
    addEventListener('blur', () => this.flush());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.flush(); });
    addEventListener('beforeunload', () => this.flush());

    document.addEventListener('keydown', e => {
      const typing = /^(input|textarea|select)$/i.test((document.activeElement || {}).tagName || '');
      const boardVisible = this.studio && this.studio.offsetParent !== null;
      if (!boardVisible || typing) return;
      if (e.code === 'Space' && !this.spaceHeld) { this.spaceHeld = true; this.wrap.classList.add('cursor-move'); e.preventDefault(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redo(); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel.size) { e.preventDefault(); this.deleteSelection(); }
    });
    document.addEventListener('keyup', e => {
      if (e.code === 'Space') { this.spaceHeld = false; this.wrap.classList.remove('cursor-move'); this.wrap.className = 'canvas-wrap ' + this.cursorClass(); }
    });
  },

  /* ---------- pointer input ---------- */
  bindPointer() {
    const w = this.wrap;
    w.addEventListener('pointerdown', e => this.onDown(e));
    w.addEventListener('pointermove', e => this.onMove(e));
    w.addEventListener('pointerup', e => this.onUp(e));
    w.addEventListener('pointercancel', e => this.onUp(e, true));
    w.addEventListener('wheel', e => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = this.cv.getBoundingClientRect();
        this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.pow(1.0016, -e.deltaY));
      } else {
        this.view.x -= e.deltaX; this.view.y -= e.deltaY;
        this._dirty = true; this.render();
      }
    }, { passive: false });
  },

  pressureOf(e) {
    if (e.pointerType === 'pen' && this.prefs.pressure && e.pressure > 0) return clamp(e.pressure * 1.5, 0.15, 1.6);
    return 1;
  },

  onDown(e) {
    if (e.target.closest('.zoom-hud, .board-text-edit')) return;
    this.commitTextEditor();
    this.wrap.setPointerCapture && this.wrap.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.pointers.size === 2) {   // second finger: switch to pinch
      if (this.live && this.live.mode === 'stroke') this.abortStroke();
      const [a, b] = [...this.pointers.values()];
      this.live = {
        mode: 'pinch',
        d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mid0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        view0: { ...this.view }
      };
      return;
    }

    const [wx, wy] = this.eventPoint(e);
    const t = this.prefs.tool;
    const pan = this.spaceHeld || e.button === 1;

    if (pan) { this.live = { mode: 'pan', lx: e.clientX, ly: e.clientY }; this.wrap.classList.add('cursor-moving'); return; }
    if (e.button === 2) return;

    if (['pen', 'pencil', 'highlighter', 'marker', 'eraser'].includes(t)) {
      const elx = { t: 'stroke', tool: t, color: this.prefs.color, size: this.prefs.size, op: this.prefs.opacity, pts: [[+wx.toFixed(2), +wy.toFixed(2), +this.pressureOf(e).toFixed(2)]] };
      this.live = { mode: 'stroke', el: elx, sx: wx, sy: wy, drawn: 0 };
      if (this.cctx) { this.worldTransform(this.cctx); this.drawEl(this.cctx, elx); this.compose(); }
    } else if (['line', 'arrow', 'rect', 'circle', 'triangle'].includes(t)) {
      this.live = { mode: 'shape', el: { t: 'shape', kind: t, x1: wx, y1: wy, x2: wx, y2: wy, color: this.prefs.color, size: this.prefs.size, op: this.prefs.opacity } };
    } else if (t === 'text') {
      const hit = this.topTextAt(wx, wy);
      this.openTextEditor(wx, wy, hit);
    } else if (t === 'select') {
      const bb = this.selBoundsWorld();
      if (bb && wx >= bb.x0 && wx <= bb.x1 && wy >= bb.y0 && wy <= bb.y1) {
        this.live = { mode: 'dragSel', lx: wx, ly: wy, dx: 0, dy: 0, els: [...this.sel] };
      } else {
        this.live = { mode: 'marquee', x0: wx, y0: wy, x1: wx, y1: wy };
      }
    } else if (t === 'lasso') {
      this.live = { mode: 'lasso', pts: [[wx, wy]] };
    } else if (t === 'move') {
      const hit = this.topElAt(wx, wy);
      if (hit) {
        this.setSel(new Set([hit]));
        this.live = { mode: 'dragSel', lx: wx, ly: wy, dx: 0, dy: 0, els: [hit] };
        this.wrap.classList.add('cursor-moving');
      } else {
        this.live = { mode: 'pan', lx: e.clientX, ly: e.clientY };
        this.wrap.classList.add('cursor-moving');
      }
    }
  },

  onMove(e) {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const L = this.live;
    if (!L) return;

    if (L.mode === 'pinch' && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const r = this.cv.getBoundingClientRect();
      const s2 = clamp(L.view0.s * (d / L.d0), 0.1, 8);
      const mx = L.mid0.x - r.left, my = L.mid0.y - r.top;
      this.view.s = s2;
      this.view.x = (mx - (mx - L.view0.x) * (s2 / L.view0.s)) + (mid.x - L.mid0.x);
      this.view.y = (my - (my - L.view0.y) * (s2 / L.view0.s)) + (mid.y - L.mid0.y);
      this._dirty = true; this.render();
      return;
    }

    if (L.mode === 'pan') {
      this.view.x += e.clientX - L.lx; this.view.y += e.clientY - L.ly;
      L.lx = e.clientX; L.ly = e.clientY;
      this._dirty = true; this.render();
      return;
    }

    if (L.mode === 'stroke') {
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      const k = 1 - (this.prefs.smooth / 100) * 0.86;
      for (const ev of evs) {
        const [wx, wy] = this.eventPoint(ev);
        L.sx += (wx - L.sx) * k; L.sy += (wy - L.sy) * k;
        const pts = L.el.pts, last = pts[pts.length - 1];
        if (Math.hypot(L.sx - last[0], L.sy - last[1]) < 0.6 / this.view.s) continue;
        pts.push([+L.sx.toFixed(2), +L.sy.toFixed(2), +this.pressureOf(ev).toFixed(2)]);
      }
      this.drawLiveStroke();
      return;
    }

    const [wx, wy] = this.eventPoint(e);
    if (L.mode === 'shape') {
      L.el.x2 = wx; L.el.y2 = wy;
      if (e.shiftKey) {
        if (L.el.kind === 'line' || L.el.kind === 'arrow') {
          const ang = Math.round(Math.atan2(wy - L.el.y1, wx - L.el.x1) / (Math.PI / 4)) * (Math.PI / 4);
          const d = Math.hypot(wx - L.el.x1, wy - L.el.y1);
          L.el.x2 = L.el.x1 + Math.cos(ang) * d; L.el.y2 = L.el.y1 + Math.sin(ang) * d;
        } else {
          const s = Math.max(Math.abs(wx - L.el.x1), Math.abs(wy - L.el.y1));
          L.el.x2 = L.el.x1 + Math.sign(wx - L.el.x1 || 1) * s;
          L.el.y2 = L.el.y1 + Math.sign(wy - L.el.y1 || 1) * s;
        }
      }
      this.compose();
      if (this.ctx) { this.worldTransform(this.ctx); this.drawEl(this.ctx, L.el); }
      this.renderSelection();
    } else if (L.mode === 'marquee') {
      L.x1 = wx; L.y1 = wy;
      this.renderSelection();
    } else if (L.mode === 'lasso') {
      const last = L.pts[L.pts.length - 1];
      if (Math.hypot(wx - last[0], wy - last[1]) > 3 / this.view.s) L.pts.push([wx, wy]);
      this.renderSelection();
    } else if (L.mode === 'dragSel') {
      const dx = wx - L.lx, dy = wy - L.ly;
      L.lx = wx; L.ly = wy; L.dx += dx; L.dy += dy;
      for (const elx of L.els) this.translateEl(elx, dx, dy);
      this.rebuildContent(); this.compose(); this.renderSelection();
    }
  },

  drawLiveStroke() {
    const L = this.live;
    if (!this.cctx || !L) return;
    const c = this.cctx, pts = L.el.pts;
    if (pts.length < 2) return;
    this.worldTransform(c);
    c.save();
    this.strokeStyleFor(c, L.el);
    const w = this.widthFor(L.el);
    const vary = ['pen', 'pencil', 'marker'].includes(L.el.tool) && this.prefs.pressure;
    for (let i = Math.max(1, L.drawn); i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      c.lineWidth = vary ? Math.max(0.4, w * (((a[2] || 1) + (b[2] || 1)) / 2)) : w;
      c.beginPath();
      if (i >= 2) {
        const p0 = pts[i - 2];
        c.moveTo((p0[0] + a[0]) / 2, (p0[1] + a[1]) / 2);
        c.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      } else {
        c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]);
      }
      c.stroke();
    }
    c.restore();
    L.drawn = pts.length;
    this.compose();
    this.renderSelection();
  },

  abortStroke() {
    this.live = null;
    this.rebuildContent(); this.compose();
  },

  onUp(e, cancelled = false) {
    this.pointers.delete(e.pointerId);
    const L = this.live;
    this.wrap.classList.remove('cursor-moving');
    if (!L) return;
    if (L.mode === 'pinch') { if (this.pointers.size < 2) { this.live = null; this._dirty = true; this.changed(); } return; }
    this.live = null;

    if (cancelled) { this.rebuildContent(); this.compose(); this.renderSelection(); return; }

    if (L.mode === 'stroke') {
      const b = this.board();
      b.els.push(L.el);
      this.pushOp({ t: 'add', el: L.el });
    } else if (L.mode === 'shape') {
      if (Math.hypot(L.el.x2 - L.el.x1, L.el.y2 - L.el.y1) * this.view.s > 4) {
        L.el.x1 = +L.el.x1.toFixed(2); L.el.y1 = +L.el.y1.toFixed(2);
        L.el.x2 = +L.el.x2.toFixed(2); L.el.y2 = +L.el.y2.toFixed(2);
        this.board().els.push(L.el);
        this.pushOp({ t: 'add', el: L.el });
      } else { this.compose(); }
      this.setColorRemember();
    } else if (L.mode === 'marquee') {
      const x0 = Math.min(L.x0, L.x1), x1 = Math.max(L.x0, L.x1);
      const y0 = Math.min(L.y0, L.y1), y1 = Math.max(L.y0, L.y1);
      const hits = new Set();
      for (const elx of this.board().els) {
        if (elx.t === 'stroke' && elx.tool === 'eraser') continue;
        const bb = this.elBounds(elx);
        if (bb.x0 <= x1 && bb.x1 >= x0 && bb.y0 <= y1 && bb.y1 >= y0) hits.add(elx);
      }
      this.setSel(hits);
    } else if (L.mode === 'lasso') {
      const poly = L.pts;
      const hits = new Set();
      if (poly.length > 2) {
        for (const elx of this.board().els) {
          if (elx.t === 'stroke' && elx.tool === 'eraser') continue;
          if (this.samplePoints(elx).some(p => this.pointInPoly(p, poly))) hits.add(elx);
        }
      }
      this.setSel(hits);
    } else if (L.mode === 'dragSel') {
      if (Math.abs(L.dx) > 0.01 || Math.abs(L.dy) > 0.01) {
        this.pushOp({ t: 'move', els: L.els, dx: +L.dx.toFixed(2), dy: +L.dy.toFixed(2) });
      }
      this.renderSelection();
    }
    if (L.mode === 'stroke' && L.el.tool !== 'eraser') this.setColorRemember();
  },

  setColorRemember() {
    if (!this.prefs.recent.includes(this.prefs.color)) {
      this.prefs.recent = [this.prefs.color, ...this.prefs.recent].slice(0, 10);
      this.savePrefs();
      if (!$('#color-pop').hidden) this.renderSwatches();
    }
  },

  pointInPoly(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (((yi > p[1]) !== (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  },

  topElAt(wx, wy) {
    const els = this.board().els;
    for (let i = els.length - 1; i >= 0; i--) {
      const elx = els[i];
      if (elx.t === 'stroke' && elx.tool === 'eraser') continue;
      const bb = this.elBounds(elx);
      const pad = 6 / this.view.s;
      if (wx >= bb.x0 - pad && wx <= bb.x1 + pad && wy >= bb.y0 - pad && wy <= bb.y1 + pad) return elx;
    }
    return null;
  },

  topTextAt(wx, wy) {
    const els = this.board().els;
    for (let i = els.length - 1; i >= 0; i--) {
      if (els[i].t !== 'text') continue;
      const bb = this.elBounds(els[i]);
      if (wx >= bb.x0 && wx <= bb.x1 && wy >= bb.y0 && wy <= bb.y1) return els[i];
    }
    return null;
  },

  /* ---------- selection rendering ---------- */
  setSel(set) { this.sel = set; this.renderSelection(); },

  selBoundsWorld() {
    if (!this.sel.size) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const elx of this.sel) {
      const bb = this.elBounds(elx);
      x0 = Math.min(x0, bb.x0); y0 = Math.min(y0, bb.y0);
      x1 = Math.max(x1, bb.x1); y1 = Math.max(y1, bb.y1);
    }
    return { x0, y0, x1, y1 };
  },

  renderSelection() {
    const ov = this.overlay;
    if (!ov) return;
    ov.innerHTML = '';
    const L = this.live;
    if (L && L.mode === 'marquee') {
      const [sx0, sy0] = this.toScreen(Math.min(L.x0, L.x1), Math.min(L.y0, L.y1));
      const [sx1, sy1] = this.toScreen(Math.max(L.x0, L.x1), Math.max(L.y0, L.y1));
      const d = el('div', 'sel-box');
      d.style.cssText = `left:${sx0}px;top:${sy0}px;width:${sx1 - sx0}px;height:${sy1 - sy0}px`;
      ov.appendChild(d);
    }
    if (L && L.mode === 'lasso' && L.pts.length > 1) {
      const pts = L.pts.map(p => this.toScreen(p[0], p[1]).map(v => v.toFixed(1)).join(',')).join(' ');
      ov.innerHTML += `<svg class="lasso-path"><polygon points="${pts}" fill="rgba(247,167,108,.1)" stroke="var(--paw)" stroke-width="1.5" stroke-dasharray="5 4"/></svg>`;
    }
    const bb = this.selBoundsWorld();
    if (bb) {
      const [sx0, sy0] = this.toScreen(bb.x0, bb.y0);
      const [sx1, sy1] = this.toScreen(bb.x1, bb.y1);
      const d = el('div', 'sel-bounds');
      d.style.cssText = `left:${sx0}px;top:${sy0}px;width:${sx1 - sx0}px;height:${sy1 - sy0}px`;
      ov.appendChild(d);
    }
  },

  deleteSelection() {
    if (!this.sel.size) return;
    const b = this.board();
    const items = [...this.sel].map(elx => [b.els.indexOf(elx), elx]).filter(x => x[0] > -1).sort((a, z) => a[0] - z[0]);
    for (let i = items.length - 1; i >= 0; i--) b.els.splice(items[i][0], 1);
    this.setSel(new Set());
    this.pushOp({ t: 'remove', items });
  },

  /* ---------- zoom ---------- */
  zoomAt(sx, sy, factor) {
    const s2 = clamp(this.view.s * factor, 0.1, 8);
    this.view.x = sx - (sx - this.view.x) * (s2 / this.view.s);
    this.view.y = sy - (sy - this.view.y) * (s2 / this.view.s);
    this.view.s = s2;
    this._dirty = true;
    this.render();
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => this.saveNow(), 1200);
  },

  fit() {
    const bb = this.contentBounds();
    if (!bb) { this.view = { x: 0, y: 0, s: 1 }; }
    else {
      const m = 46;
      const s = clamp(Math.min((this.cssW - m * 2) / Math.max(40, bb.x1 - bb.x0), (this.cssH - m * 2) / Math.max(40, bb.y1 - bb.y0)), 0.1, 3);
      this.view.s = s;
      this.view.x = (this.cssW - (bb.x1 - bb.x0) * s) / 2 - bb.x0 * s;
      this.view.y = (this.cssH - (bb.y1 - bb.y0) * s) / 2 - bb.y0 * s;
    }
    this._dirty = true;
    this.render();
  },

  /* ---------- text editor ---------- */
  textEditor: null,

  openTextEditor(wx, wy, existing = null) {
    this.commitTextEditor();
    const worldSize = existing ? existing.size : clamp(this.prefs.size * 4.5, 14, 72);
    const [sx, sy] = this.toScreen(existing ? existing.x : wx, existing ? existing.y : wy);
    const ta = el('textarea', 'board-text-edit');
    ta.value = existing ? existing.text : '';
    ta.rows = 1;
    ta.style.left = (sx - 3) + 'px';
    ta.style.top = (sy - 3) + 'px';
    ta.style.fontSize = (worldSize * this.view.s) + 'px';
    ta.style.color = existing ? existing.color : this.prefs.color;
    if (this.isDarkPaper() && !existing && this.prefs.color === '#31405e') ta.style.color = '#f2f4f8';
    this.overlay.appendChild(ta);
    const grow = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; ta.style.width = Math.max(60, ta.scrollWidth + 8) + 'px'; };
    ta.addEventListener('input', grow);
    ta.addEventListener('keydown', e => {
      if (e.key === 'Escape') { this.closeTextEditor(true); }
      e.stopPropagation();
    });
    ta.addEventListener('blur', () => this.commitTextEditor());
    this.textEditor = { ta, wx, wy, worldSize, existing, color: ta.style.color };
    requestAnimationFrame(() => { grow(); ta.focus(); });
  },

  commitTextEditor() {
    const T = this.textEditor;
    if (!T) return;
    this.textEditor = null;
    const text = T.ta.value.replace(/\s+$/, '');
    T.ta.remove();
    const b = this.board();
    if (T.existing) {
      if (!text.trim()) {
        const idx = b.els.indexOf(T.existing);
        if (idx > -1) { b.els.splice(idx, 1); this.pushOp({ t: 'remove', items: [[idx, T.existing]] }); }
      } else if (text !== T.existing.text) {
        const op = { t: 'props', el: T.existing, before: { text: T.existing.text }, after: { text } };
        T.existing.text = text;
        this.pushOp(op);
      }
    } else if (text.trim()) {
      const hex = /^#[0-9a-f]{6}$/i.test(T.color) ? T.color : this.prefs.color;
      const elx = { t: 'text', x: +T.wx.toFixed(2), y: +T.wy.toFixed(2), text, color: hex, size: Math.round(T.worldSize) };
      b.els.push(elx);
      this.pushOp({ t: 'add', el: elx });
    }
  },

  closeTextEditor(cancel = false) {
    if (!this.textEditor) return;
    if (cancel) { this.textEditor.ta.remove(); this.textEditor = null; }
    else this.commitTextEditor();
  }
});

/* ── Whiteboard: library, lifecycle + paw theatre, exports ────────────── */

Object.assign(Board, {

  /* ---------- library ---------- */
  openLib() {
    this._libOpen = true;
    this.flush();
    $('#board-library').hidden = false;
    $('#board-library-btn').setAttribute('aria-expanded', 'true');
    this.renderLib();
    $('#lib-search').focus();
  },

  closeLib() {
    this._libOpen = false;
    $('#board-library').hidden = true;
    $('#board-library-btn').setAttribute('aria-expanded', 'false');
  },

  renderLib() {
    const grid = $('#lib-grid');
    const term = ($('#lib-search').value || '').trim().toLowerCase();
    const sort = Store.data.ui.boardSort;
    const list = Store.data.boards
      .filter(b => !term || b.name.toLowerCase().includes(term))
      .sort((a, b) => {
        if (a.fav !== b.fav) return a.fav ? -1 : 1;
        if (sort === 'name') return a.name.localeCompare(b.name);
        if (sort === 'created') return b.created - a.created;
        return b.edited - a.edited;
      });
    $('#lib-empty').hidden = list.length > 0;
    grid.innerHTML = list.map(b => `
      <div class="lib-card${b.id === this.activeId ? ' is-current' : ''}" data-id="${b.id}" role="button" tabindex="0" aria-label="Open ${escapeHtml(b.name)}">
        ${b.thumb ? `<img class="lib-thumb" src="${b.thumb}" alt="">` : '<div class="lib-thumb"></div>'}
        <div class="lib-meta">
          <div class="lib-name">${escapeHtml(b.name)}</div>
          <div class="lib-sub">${b.els.length} element${b.els.length === 1 ? '' : 's'} · edited ${relTime(b.edited)}</div>
        </div>
        <div class="lib-actions">
          <button class="btn-icon lib-fav${b.fav ? ' is-on' : ''}" data-act="fav" title="${b.fav ? 'Unfavourite' : 'Favourite'}" aria-label="Favourite"><svg viewBox="0 0 24 24" fill="${b.fav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M12 3l2.6 6.6L21 9.3l-5 4.6 1.4 7L12 17.3 6.6 21l1.4-7-5-4.6 6.4-.7L12 3z"/></svg></button>
          <button class="btn-icon" data-act="dup" title="Duplicate" aria-label="Duplicate"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 8V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-4v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2h4zm2 0h4a2 2 0 0 1 2 2v4h4V4H10v4z"/></svg></button>
          <button class="btn-icon" data-act="del" title="Delete" aria-label="Delete"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 3h6l1 2h4v2H4V5h4l1-2zM6 9h12l-1 12H7L6 9z"/></svg></button>
        </div>
      </div>`).join('');

    $$('.lib-card', grid).forEach(card => {
      const id = card.dataset.id;
      card.addEventListener('click', e => {
        const act = e.target.closest('[data-act]');
        if (!act) { if (id !== this.activeId) this.switchTo(id, 'open'); else this.closeLib(); return; }
        e.stopPropagation();
        if (act.dataset.act === 'fav') {
          const b = Store.data.boards.find(x => x.id === id);
          b.fav = !b.fav; Store.save(); this.renderLib();
        } else if (act.dataset.act === 'dup') this.duplicate(id);
        else this.removeBoard(id);
      });
      card.addEventListener('keydown', e => { if (e.key === 'Enter') card.click(); });
    });
  },

  /* ---------- lifecycle ---------- */
  create(name = null, { animate = true, silent = false } = {}) {
    const n = Store.data.boards.length + 1;
    const b = {
      id: uid(), name: name || 'Board ' + n,
      created: Date.now(), edited: Date.now(), fav: false,
      bg: (this.prefs && this.prefs.lastBg) || 'blank',
      els: [], thumb: '', view: { x: 0, y: 0, s: 1 }
    };
    Store.data.boards.push(b);
    Store.data.counters.boardsMade += 1;
    if (silent) { this.activeId = b.id; return b; }
    Store.save();
    this.switchTo(b.id, animate ? 'new' : null);
    Toast.show('New board created — it autosaves as you draw.');
    Game.onCommit();
    return b;
  },

  switchTo(id, anim = null) {
    if (!Store.data.boards.some(b => b.id === id)) return;
    this.commitTextEditor();
    this.flush();
    const wasOther = this.activeId && this.activeId !== id;
    this.activeId = id;
    this.prefs.activeBoard = id;
    Store.save();
    const b = this.board();
    this.view = { ...b.view };
    this.undoStack.length = 0; this.redoStack.length = 0;
    this.setSel(new Set());
    this.closeLib();
    this.syncUI();
    this.render();
    if (this.fxOn()) {
      const wrapAnim = () => {
        this.wrap.classList.remove('board-slide-in'); void this.wrap.offsetWidth;
        this.wrap.classList.add('board-slide-in');
        setTimeout(() => this.wrap.classList.remove('board-slide-in'), 600);
      };
      if (anim === 'new') { this.catRunner('in', true); wrapAnim(); }
      else if (anim === 'open') { this.catRunner('in', true); wrapAnim(); }
      else if (wasOther) wrapAnim();
    }
  },

  duplicate(id) {
    const src = Store.data.boards.find(b => b.id === id);
    if (!src) return;
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = uid();
    copy.name = (src.name + ' copy').slice(0, 80);
    copy.created = copy.edited = Date.now();
    copy.fav = false;
    Store.data.boards.push(copy);
    Store.data.counters.boardsMade += 1;
    Store.save();
    Toast.show(`Duplicated “${src.name}”.`);
    this.renderLib();
    Game.onCommit();
  },

  async removeBoard(id) {
    const b = Store.data.boards.find(x => x.id === id);
    if (!b) return;
    const ok = await Modal.confirm({
      title: `Delete “${b.name}”?`,
      message: `${b.els.length} element${b.els.length === 1 ? '' : 's'} will be gone for good. Export it first if you might want it back.`,
      confirmLabel: 'Delete board', danger: true
    });
    if (!ok) return;
    if (this.fxOn() && id === this.activeId) this.catRunner('out', true);
    const doDelete = () => {
      Store.data.boards = Store.data.boards.filter(x => x.id !== id);
      if (!Store.data.boards.length) {
        this.create('My board', { animate: false, silent: true });
        Store.data.counters.boardsMade -= 1;   // a forced replacement is not an earned creation
      }
      if (this.activeId === id || !Store.data.boards.some(x => x.id === this.activeId)) {
        this.activeId = Store.data.boards[0].id;
        this.prefs.activeBoard = this.activeId;
        this.view = { ...this.board().view };
        this.undoStack.length = 0; this.redoStack.length = 0;
        this.setSel(new Set());
      }
      Store.save();
      this.syncUI();
      this.render();
      if (this._libOpen) this.renderLib();
      Toast.show('Board deleted.');
    };
    setTimeout(doDelete, this.fxOn() && id === this.activeId ? 550 : 0);
  },

  async clearBoard() {
    const b = this.board();
    if (!b || !b.els.length) return;
    const ok = await Modal.confirm({
      title: 'Clear this board?',
      message: 'Everything on it will be wiped. Undo can bring it back until you leave.',
      confirmLabel: 'Clear board', danger: true
    });
    if (!ok) return;
    const items = b.els.map((elx, i) => [i, elx]);
    b.els = [];
    this.setSel(new Set());
    this.pushOp({ t: 'remove', items });
    this.pawWipe();
    Sound.cue('pop');
  },

  /* ---------- paw theatre ---------- */
  pawsRoot() { return $('#board-paws'); },

  catRunner(dir, withBoard) {
    if (!this.fxOn()) return;
    const root = this.pawsRoot();
    if (!root) return;
    const d = el('div', 'cat-runner run-' + dir);
    d.innerHTML = (withBoard ? '<div style="position:absolute;left:84px;bottom:26px;width:64px;height:42px;background:#fff;border:2px solid var(--border-strong);border-radius:6px;box-shadow:0 6px 14px rgba(10,14,40,.18);transform:rotate(6deg)"></div>' : '') + Cat.svgMarkup();
    root.appendChild(d);
    setTimeout(() => d.remove(), 1200);
  },

  pawStamp() {
    if (!this.fxOn()) return;
    const root = this.pawsRoot();
    if (!root || this.studio.offsetParent === null) return;
    const d = el('div', 'paw-stamp');
    d.innerHTML = PAW_SVG;
    root.appendChild(d);
    Sound.cue('stamp');
    setTimeout(() => d.remove(), 1700);
  },

  pawWipe() {
    if (!this.fxOn()) return;
    const root = this.pawsRoot();
    if (!root) return;
    for (let i = 0; i < 3; i++) {
      const d = el('div', 'paw-clean');
      d.innerHTML = PAW_SVG;
      d.style.top = (14 + i * 28) + '%';
      d.style.animationDelay = (i * 0.14) + 's';
      root.appendChild(d);
      setTimeout(() => d.remove(), 1500 + i * 160);
    }
  },

  /* ---------- export & import ---------- */
  slug(name) { return (name || 'board').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'board'; },

  download(href, filename) {
    const a = document.createElement('a');
    a.href = href; a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); if (href.startsWith('blob:')) URL.revokeObjectURL(href); }, 400);
  },

  exportCanvas() {
    if (!this.ctx) return null;
    const b = this.board();
    const bb = this.contentBounds() || (() => {
      const [x0, y0] = this.toWorld(0, 0);
      const [x1, y1] = this.toWorld(this.cssW, this.cssH);
      return { x0, y0, x1, y1 };
    })();
    const pad = 32;
    const w = bb.x1 - bb.x0 + pad * 2, h = bb.y1 - bb.y0 + pad * 2;
    let scale = 2;
    if (Math.max(w, h) * scale > 4000) scale = 4000 / Math.max(w, h);
    const cnv = document.createElement('canvas');
    cnv.width = Math.max(2, Math.round(w * scale));
    cnv.height = Math.max(2, Math.round(h * scale));
    const c = cnv.getContext('2d');
    c.fillStyle = this.paperColor();
    c.fillRect(0, 0, cnv.width, cnv.height);
    c.setTransform(scale, 0, 0, scale, (pad - bb.x0) * scale, (pad - bb.y0) * scale);
    for (const elx of b.els) this.drawEl(c, elx);
    return cnv;
  },

  export(kind) {
    const b = this.board();
    if (!b) return;
    if (kind === 'import') { this.pickImport(); return; }
    this.flush();
    try {
      if (kind === 'png' || kind === 'jpeg') {
        const cnv = this.exportCanvas();
        if (!cnv) { Toast.show('Export needs canvas support in this browser.', { danger: true }); return; }
        this.download(cnv.toDataURL(kind === 'png' ? 'image/png' : 'image/jpeg', 0.92), `${this.slug(b.name)}.${kind === 'png' ? 'png' : 'jpg'}`);
      } else if (kind === 'svg') {
        const svg = this.toSVG();
        this.download(URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })), `${this.slug(b.name)}.svg`);
      } else if (kind === 'pdf') {
        const bytes = this.toPDF();
        if (!bytes) { Toast.show('Export needs canvas support in this browser.', { danger: true }); return; }
        this.download(URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })), `${this.slug(b.name)}.pdf`);
      } else if (kind === 'json') {
        const data = JSON.stringify({ app: 'revtrack-board', version: 2, board: { name: b.name, bg: b.bg, created: b.created, els: b.els } }, null, 1);
        this.download(URL.createObjectURL(new Blob([data], { type: 'application/json' })), `${this.slug(b.name)}.board.json`);
      }
      Store.data.counters.exports += 1;
      Store.save();
      Toast.show(`Exported “${b.name}” as ${kind.toUpperCase()}.`);
      this.pawStamp();
      Game.onCommit();
    } catch (e) {
      console.error(e);
      Toast.show('Export failed — see the console for details.', { danger: true });
    }
  },

  svgStrokeAttrs(elx) {
    const w = this.widthFor(elx);
    const op = (elx.op ?? 100) / 100;
    const alpha = elx.tool === 'highlighter' ? op * 0.32 : elx.tool === 'pencil' ? op * 0.8 : op;
    const cap = elx.tool === 'highlighter' || elx.tool === 'marker' ? 'butt' : 'round';
    return `fill="none" stroke-width="${w.toFixed(2)}" stroke-linecap="${cap}" stroke-linejoin="round" stroke-opacity="${alpha.toFixed(3)}"`;
  },

  strokePathD(pts) {
    if (pts.length === 1) {
      const [x, y] = pts[0];
      return `M ${x} ${y} L ${x + 0.01} ${y}`;
    }
    let d = `M ${pts[0][0]} ${pts[0][1]}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = ((pts[i][0] + pts[i + 1][0]) / 2).toFixed(2), my = ((pts[i][1] + pts[i + 1][1]) / 2).toFixed(2);
      d += ` Q ${pts[i][0]} ${pts[i][1]} ${mx} ${my}`;
    }
    const last = pts[pts.length - 1];
    d += ` L ${last[0]} ${last[1]}`;
    return d;
  },

  toSVG() {
    const b = this.board();
    const bb = this.contentBounds() || { x0: 0, y0: 0, x1: 800, y1: 500 };
    const pad = 32;
    const x = (bb.x0 - pad).toFixed(1), y = (bb.y0 - pad).toFixed(1);
    const w = (bb.x1 - bb.x0 + pad * 2).toFixed(1), h = (bb.y1 - bb.y0 + pad * 2).toFixed(1);
    const erasers = [], content = [];
    for (const elx of b.els) {
      if (elx.t === 'stroke') {
        const d = this.strokePathD(elx.pts);
        if (elx.tool === 'eraser') {
          erasers.push(`<path d="${d}" stroke="#000" fill="none" stroke-width="${this.widthFor(elx).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`);
        } else {
          content.push(`<path d="${d}" stroke="${elx.color}" ${this.svgStrokeAttrs(elx)}/>`);
        }
      } else if (elx.t === 'shape') {
        const a = `stroke="${elx.color}" fill="none" stroke-width="${elx.size || 4}" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="${((elx.op ?? 100) / 100).toFixed(3)}"`;
        const { x1, y1, x2, y2 } = elx;
        if (elx.kind === 'line') content.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${a}/>`);
        else if (elx.kind === 'arrow') {
          const ang = Math.atan2(y2 - y1, x2 - x1), hl = Math.max(10, (elx.size || 4) * 3.4);
          content.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${a}/>` +
            `<path d="M ${x2} ${y2} L ${(x2 - hl * Math.cos(ang - 0.44)).toFixed(1)} ${(y2 - hl * Math.sin(ang - 0.44)).toFixed(1)} M ${x2} ${y2} L ${(x2 - hl * Math.cos(ang + 0.44)).toFixed(1)} ${(y2 - hl * Math.sin(ang + 0.44)).toFixed(1)}" ${a}/>`);
        } else if (elx.kind === 'rect') content.push(`<rect x="${Math.min(x1, x2)}" y="${Math.min(y1, y2)}" width="${Math.abs(x2 - x1)}" height="${Math.abs(y2 - y1)}" ${a}/>`);
        else if (elx.kind === 'circle') content.push(`<ellipse cx="${(x1 + x2) / 2}" cy="${(y1 + y2) / 2}" rx="${Math.abs(x2 - x1) / 2}" ry="${Math.abs(y2 - y1) / 2}" ${a}/>`);
        else content.push(`<polygon points="${(x1 + x2) / 2},${Math.min(y1, y2)} ${Math.min(x1, x2)},${Math.max(y1, y2)} ${Math.max(x1, x2)},${Math.max(y1, y2)}" ${a}/>`);
      } else if (elx.t === 'text') {
        const size = elx.size || 18;
        const lines = String(elx.text || '').split('\n').map((ln, i) =>
          `<tspan x="${elx.x}" dy="${i === 0 ? size : size * 1.28}">${escapeHtml(ln)}</tspan>`).join('');
        content.push(`<text x="${elx.x}" y="${elx.y}" fill="${elx.color}" font-family="Instrument Sans, system-ui, sans-serif" font-size="${size}" font-weight="500">${lines}</text>`);
      }
    }
    const maskDef = erasers.length
      ? `<mask id="wipe"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#fff"/>${erasers.join('')}</mask>`
      : '';
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${w}" height="${h}">` +
      `<defs>${maskDef}</defs>` +
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${this.paperColor()}"/>` +
      `<g${erasers.length ? ' mask="url(#wipe)"' : ''}>${content.join('')}</g>` +
      `</svg>`;
  },

  /** A hand-rolled single-page PDF embedding a JPEG render — no libraries. */
  toPDF() {
    const cnv = this.exportCanvas();
    if (!cnv) return null;
    const dataURL = cnv.toDataURL('image/jpeg', 0.9);
    const jpegBin = atob(dataURL.split(',')[1]);
    const jpeg = new Uint8Array(jpegBin.length);
    for (let i = 0; i < jpegBin.length; i++) jpeg[i] = jpegBin.charCodeAt(i);

    const W = +(cnv.width * 72 / 96).toFixed(2), H = +(cnv.height * 72 / 96).toFixed(2);
    const enc = s => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff; return u; };
    const chunks = [];
    let pos = 0;
    const offsets = [0];
    const push = u => { chunks.push(u); pos += u.length; };
    const obj = s => { offsets.push(pos); push(enc(s)); };

    push(enc('%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n'));
    obj('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    obj('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
    obj(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`);
    offsets.push(pos);
    push(enc(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${cnv.width} /Height ${cnv.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`));
    push(jpeg);
    push(enc('\nendstream\nendobj\n'));
    const stream = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
    obj(`5 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);

    const xrefPos = pos;
    let xref = 'xref\n0 6\n0000000000 65535 f \n';
    for (let i = 1; i <= 5; i++) xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    xref += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
    push(enc(xref));

    const out = new Uint8Array(pos);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  },

  _importInput: null,

  pickImport() {
    if (!this._importInput) {
      this._importInput = document.createElement('input');
      this._importInput.type = 'file';
      this._importInput.accept = '.json,application/json';
      this._importInput.hidden = true;
      document.body.appendChild(this._importInput);
      this._importInput.addEventListener('change', () => {
        const f = this._importInput.files[0];
        this._importInput.value = '';
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => this.importJSON(String(reader.result), f.name);
        reader.readAsText(f);
      });
    }
    this._importInput.click();
  },

  importJSON(text, filename = 'import') {
    try {
      const raw = JSON.parse(text);
      const src = raw && raw.board && Array.isArray(raw.board.els) ? raw.board
        : (raw && Array.isArray(raw.els) ? raw : null);
      if (!src) throw new Error('Not a RevTrack board file');
      const b = {
        id: uid(),
        name: String(src.name || filename.replace(/\.board\.json$|\.json$/i, '')).slice(0, 80) || 'Imported board',
        created: Number.isFinite(+src.created) ? +src.created : Date.now(),
        edited: Date.now(), fav: false,
        bg: this.BGS[src.bg] ? src.bg : 'blank',
        els: src.els.filter(e => e && typeof e.t === 'string'),
        thumb: '', view: { x: 0, y: 0, s: 1 }
      };
      Store.data.boards.push(b);
      Store.data.counters.imports += 1;
      Store.save();
      this.switchTo(b.id, 'open');
      this.fit();
      Toast.show(`Imported “${b.name}” — ${b.els.length} elements.`);
      Game.onCommit();
    } catch (e) {
      console.error(e);
      Toast.show('That file is not a valid board export.', { danger: true });
    }
  }
});

function renderBoardView() {
  Board.mount($('#board-studio-slot'));
}



/* ═══ 36. Re-sync the companion layer after a data swap ═════════════════════
   importJSON and clearAllData replace Store.data wholesale, so the live
   references the studio and player hold must be re-pointed and re-rendered. */

function resyncCompanionState() {
  if (typeof Board !== 'undefined' && Board.studio) {
    const stored = Store.data.boardPrefs;
    Board.prefs = Object.assign(Board.defaultPrefs(), (stored && typeof stored === 'object') ? stored : {});
    if (!Array.isArray(Board.prefs.recent)) Board.prefs.recent = [];
    if (!Array.isArray(Board.prefs.favs)) Board.prefs.favs = [];
    Store.data.boardPrefs = Board.prefs;
    if (!Store.data.boards.length) Board.create('My first board', { animate: false, silent: true });
    Board.activeId = Store.data.boards.some(b => b.id === Board.prefs.activeBoard)
      ? Board.prefs.activeBoard : Store.data.boards[0].id;
    Board.prefs.activeBoard = Board.activeId;
    Board.view = { ...Board.board().view };
    Board.undoStack.length = 0; Board.redoStack.length = 0;
    Board.sel = new Set();
    Board.closeTextEditor(true);
    Board._libOpen = false;
    const lib = $('#board-library'); if (lib) lib.hidden = true;
    Board.syncUI();
    Board.render();
  }
  if (typeof Music !== 'undefined') {
    if (Music.iframe) { Music.iframe.remove(); Music.iframe = null; }
    Music.restore();
  }
  if (typeof Game !== 'undefined') { Game.ACH = Game.buildAch(); Game.init(); }
  if (typeof Cat !== 'undefined' && Cat.root) { Cat.refreshMood(); Pet.dressEverywhere(); }
}

/* ═══ 35. One-time bindings for the companion update ═════════════════════ */

function bindStaticV2() {
  /* Quest board tabs, achievement filter, pet chip. */
  $$('#quest-tabs .seg-btn').forEach(b => b.addEventListener('click', () => {
    Store.data.ui.questTab = b.dataset.tab;
    Store.save();
    renderQuestView();
  }));
  $$('#ach-filter .seg-btn').forEach(b => b.addEventListener('click', () => { achFilter = b.dataset.f; renderQuestView(); }));
  $('#pet-chip').addEventListener('click', () => { Store.data.ui.questTab = 'pet'; Store.save(); Router.go('quests'); });
  $('#pet-name').addEventListener('input', e => { Store.data.settings.catName = e.target.value.slice(0, 20); Store.save(); });
  $('#pet-name').addEventListener('change', () => { renderPetPanel(); Cat.say(`${Cat.name()}? I love it.`); });

  /* Tasks. */
  $('#add-task-form').addEventListener('submit', e => {
    e.preventDefault();
    const title = $('#new-task-title').value.trim();
    if (!title) return;
    Tasks.add({
      title: title.slice(0, 200),
      priority: +$('#new-task-priority').value,
      deadline: $('#new-task-deadline').value || null,
      subjectId: $('#new-task-subject').value,
      category: $('#new-task-category').value,
      recur: $('#new-task-recur').value
    });
    $('#new-task-title').value = '';
    $('#new-task-category').value = '';
    $('#new-task-deadline').value = '';
    $('#new-task-title').focus();
  });
  $('#tasklist-new').addEventListener('click', () => Tasks.newList());
  $('#tasklist-rename').addEventListener('click', () => Tasks.renameList());
  $('#tasklist-delete').addEventListener('click', () => Tasks.deleteList());

  /* Music. */
  $('#music-form').addEventListener('submit', e => {
    e.preventDefault();
    const p = Music.parse($('#music-url').value);
    if (!p) { Toast.show('That doesn\u2019t look like a Spotify link.', { danger: true }); return; }
    Music.load(p.type, p.id);
    $('#music-url').value = '';
  });
  $('#dock-mini-btn').addEventListener('click', () => Music.setDock(Music.iframe ? 'mini' : 'hidden'));
  $('#dock-hide-btn').addEventListener('click', () => Music.setDock('hidden'));
  $('#dock-close').addEventListener('click', () => Music.setDock('hidden'));
  $('#dock-expand').addEventListener('click', () => Router.go('music'));
  addEventListener('resize', debounce(() => Music.applyDock(), 150));
  addEventListener('scroll', () => { if (Store.data.music.dock === 'open' && currentView === 'music') Music.applyDock(); }, { passive: true });

  /* Home-page studio expand. */
  $('#dash-board-expand').addEventListener('click', () => Router.go('board'));

  /* Setup: companion & effects. */
  $('#set-cat-name').addEventListener('input', e => { Store.data.settings.catName = e.target.value.slice(0, 20); Store.save(); });
  $('#set-cat-name').addEventListener('change', () => Cat.say(`${Cat.name()}, at your service.`));
  $('#set-fx').addEventListener('change', e => { Store.data.settings.fx = e.target.checked; Store.save(); });
  $('#set-ambient').addEventListener('change', e => {
    Store.data.settings.ambient = e.target.checked;
    Store.save();
    Ambient.sync();
    Ambient.repaintStill();
  });
}

/* ═══ 21. Router ═════════════════════════════════════════════════════════ */

const VIEWS = ['dashboard', 'calendar', 'tasks', 'board', 'quests', 'music', 'stats', 'consistency', 'setup'];
let currentView = 'dashboard';

const Router = {
  go(view) {
    if (!VIEWS.includes(view)) view = 'dashboard';
    if (typeof Board !== 'undefined' && Board.studio) { Board.commitTextEditor(); Board.flush(); }
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
    if (typeof Music !== 'undefined') Music.applyDock();
    if (typeof Cat !== 'undefined' && Cat.root && Math.random() < 0.22) Cat.speakContext();
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
  else if (currentView === 'tasks') Tasks.render();
  else if (currentView === 'board') renderBoardView();
  else if (currentView === 'quests') renderQuestView();
  else if (currentView === 'music') Music.render();
  else if (currentView === 'stats') renderStats();
  else if (currentView === 'consistency') renderConsistency();
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
    Store.data.ui.mainRange = mainRange;
    Store.save();
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
      Game.onCommit();
      Cat.refreshMood();
      Cat.say('New day — fresh quests are up!');
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

  mainRange = Store.data.ui.mainRange;

  Theme.init();            // applies stored theme + palette
  bindStatic();
  bindStaticV2();
  Search.bind();
  bindShortcuts();
  Presence.bind();
  Ambient.init();
  FX.init();
  Cat.init();
  Board.init();
  Game.init();
  Music.restore();
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

// Expose a minimal debug handle (used by the offline test harness; harmless in production).
try { if (typeof window !== 'undefined') window.__RT__ = { Store, Board, Game, Pet, Tasks, Music, Cat, Ambient, Stats }; } catch (_) {}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();
