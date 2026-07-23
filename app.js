'use strict';

/* ------------------------------------------------------------------
   Mölkky scorekeeper.

   The whole app is one plain object (players, their throws, config,
   whose turn it is). Every change replaces that object with a new copy
   and pushes the old one onto an undo stack, so undo/redo is uniform:
   throws, name edits, player removal and rule changes all rewind the
   same way. Scores are never stored -- they are recomputed from the
   throw lists on every render, which is what makes correcting a throw
   from ten turns ago work.
------------------------------------------------------------------ */

const STORE_KEY = 'molgu.history.v1';
const MAX_HISTORY = 300;

const $ = (sel, root = document) => root.querySelector(sel);
const uid = () => Math.random().toString(36).slice(2, 9);
const clone = (o) => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const defaultConfig = () => ({ target: 50, resetTo: 25, maxMisses: 3 });
const newState = () => ({ players: [], turn: null, config: defaultConfig(), acknowledged: 0 });

/* ---------- persistence ---------- */

function load() {
  try {
    const h = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!h || !h.present || !Array.isArray(h.present.players)) return null;
    h.past = Array.isArray(h.past) ? h.past : [];
    h.future = Array.isArray(h.future) ? h.future : [];
    for (const s of [...h.past, h.present, ...h.future]) {
      s.config = { ...defaultConfig(), ...(s.config || {}) };
      s.acknowledged = Number(s.acknowledged) || 0;
      s.players = (s.players || []).map((p) => ({
        id: p.id || uid(),
        name: String(p.name ?? '?'),
        throws: (p.throws || []).map(Number).filter(Number.isFinite),
      }));
    }
    return h;
  } catch {
    return null;
  }
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(H));
  } catch { /* private mode / quota -- game still works in memory */ }
}

let H = load() || { past: [], present: newState(), future: [] };
const openDrawers = new Set();

/* ---------- scoring ---------- */

function computePlayer(player, cfg) {
  let score = 0, misses = 0, eliminated = false, won = false, wonAt = null;
  const rows = [];
  for (const pins of player.throws) {
    if (eliminated || won) {
      // Throws recorded after the player was already done are shown but ignored.
      rows.push({ pins, score, void: true });
      continue;
    }
    if (pins === 0) {
      misses++;
      // maxMisses <= 0 disables elimination entirely (unlimited misses).
      if (cfg.maxMisses > 0 && misses >= cfg.maxMisses) eliminated = true;
    } else {
      misses = 0;
      score += pins;
      if (score > cfg.target) score = cfg.resetTo;
      else if (score === cfg.target) { won = true; wonAt = rows.length; }
    }
    rows.push({ pins, score, misses, eliminated, won, void: false });
  }
  return { score, misses, eliminated, won, wonAt, rows };
}

function compute(s) {
  const byId = {};
  for (const p of s.players) byId[p.id] = computePlayer(p, s.config);

  // In finishing order, not list order. There is no global clock in the data
  // model, so order by which throw sealed the win (everyone throws once per
  // round, so a lower index means an earlier round) and break ties by
  // throwing order. Exact for a normal rotation.
  const winners = s.players
    .map((p, i) => ({ p, i, at: byId[p.id].wonAt }))
    .filter((x) => x.at !== null)
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map((x) => x.p);

  const alive = s.players.filter((p) => !byId[p.id].eliminated);
  const active = alive.filter((p) => !byId[p.id].won);   // can still throw

  // Everyone else eliminated: the last one standing wins without reaching the target.
  const lastStanding = (s.players.length > 1 && alive.length === 1 && !byId[alive[0].id].won)
    ? alive[0] : null;

  // A win no longer stops the game -- the others may keep playing for the
  // remaining places. Play only ends when nobody is left who could throw.
  const over = s.players.length > 0 && (active.length === 0 || !!lastStanding);

  // How many finishes have happened; compared against `acknowledged` to decide
  // whether the banner still owes the room an announcement.
  const pending = winners.length + (lastStanding ? 1 : 0);

  // Placement, 1-based, in finishing order. A last-one-standing survivor
  // takes the next place after everyone who reached the target.
  const placeOf = {};
  winners.forEach((p, i) => { placeOf[p.id] = i + 1; });
  if (lastStanding) placeOf[lastStanding.id] = winners.length + 1;

  return { byId, winners, winner: winners[0] || lastStanding, lastStanding, alive, active, over, pending, placeOf };
}

const isActive = (p, st) => !st.byId[p.id].eliminated && !st.byId[p.id].won;

/* ---------- turn handling ---------- */

function advance(s) {
  const st = compute(s);
  if (st.over) { s.turn = null; return; }
  const n = s.players.length;
  const i = s.players.findIndex((p) => p.id === s.turn);
  for (let k = 1; k <= n; k++) {
    const p = s.players[(i + k + n) % n];
    if (isActive(p, st)) { s.turn = p.id; return; }
  }
  s.turn = null;
}

/** Keeps `turn` pointing at somebody who can actually throw. */
function normalize(s) {
  const st = compute(s);
  // A correction can undo a win, so never leave more finishes acknowledged than exist.
  s.acknowledged = Math.min(Number(s.acknowledged) || 0, st.pending);
  if (st.over) { s.turn = null; return; }
  const valid = s.turn && s.players.some((p) => p.id === s.turn && isActive(p, st));
  if (!valid) {
    const next = s.players.find((p) => isActive(p, st));
    s.turn = next ? next.id : null;
  }
}

/* ---------- history ---------- */

/**
 * `rerender: false` updates state and storage but leaves the player list DOM
 * alone. Needed for the rename field: it commits on blur, and rebuilding the
 * list mid-click destroys the button being pressed before `mouseup`, so the
 * click never lands. Callers that pass it must patch the affected DOM.
 */
function commit(mutate, { rerender = true } = {}) {
  const next = clone(H.present);
  mutate(next);
  normalize(next);
  H.past.push(H.present);
  if (H.past.length > MAX_HISTORY) H.past.shift();
  H.present = next;
  H.future = [];
  save();
  if (rerender) render();
}

function undo() {
  if (!H.past.length) return;
  H.future.unshift(H.present);
  H.present = H.past.pop();
  save();
  render();
}

function redo() {
  if (!H.future.length) return;
  H.past.push(H.present);
  H.present = H.future.shift();
  save();
  render();
}

/* ---------- actions ---------- */

const addPlayer = (name) => commit((s) => {
  s.players.push({ id: uid(), name, throws: [] });
});

const removePlayer = (id) => commit((s) => {
  s.players = s.players.filter((p) => p.id !== id);
});

// Rebuilding the list here would swallow the click that caused the blur.
const renamePlayer = (id, name) => commit((s) => {
  const p = s.players.find((x) => x.id === id);
  if (p) p.name = name;
}, { rerender: false });

const movePlayer = (id, dir) => commit((s) => {
  const i = s.players.findIndex((p) => p.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= s.players.length) return;
  [s.players[i], s.players[j]] = [s.players[j], s.players[i]];
});

function recordThrow(pins) {
  if (!H.present.turn) return;
  commit((s) => {
    const p = s.players.find((x) => x.id === s.turn);
    if (!p) return;
    p.throws.push(pins);
    advance(s);
  });
}

const setThrow = (id, i, pins) => commit((s) => {
  const p = s.players.find((x) => x.id === id);
  if (!p) return;
  if (i === null || i >= p.throws.length) p.throws.push(pins);
  else p.throws[i] = pins;
});

const deleteThrow = (id, i) => commit((s) => {
  const p = s.players.find((x) => x.id === id);
  if (p) p.throws.splice(i, 1);
});

const setConfig = (patch) => commit((s) => {
  Object.assign(s.config, patch);
});

const startNewGame = () => commit((s) => {
  for (const p of s.players) p.throws = [];
  s.turn = s.players.length ? s.players[0].id : null;
  s.acknowledged = 0;
});

/** Dismiss the finish announcement; whoever is left carries on. */
const acknowledge = () => commit((s) => {
  s.acknowledged = compute(s).pending;
});

/* ---------- rendering ---------- */

function padHTML(selected) {
  let h = '';
  for (let i = 1; i <= 12; i++) {
    h += `<button class="key${selected === i ? ' sel' : ''}" data-pins="${i}">${i}</button>`;
  }
  h += `<button class="key key-miss${selected === 0 ? ' sel' : ''}" data-pins="0">Miss (0)</button>`;
  return h;
}

function renderTurn(s, st) {
  const info = $('#turnInfo');
  const pad = $('#pad');
  const current = s.players.find((p) => p.id === s.turn);

  if (st.over) {
    info.innerHTML = `<div class="turn-label">Game over</div>
      <div class="turn-name">${st.winner ? esc(st.winner.name) + ' wins' : 'Everybody eliminated'}</div>`;
  } else if (!current) {
    info.innerHTML = `<div class="turn-label">Waiting</div>
      <div class="turn-name">Add players to start</div>`;
  } else {
    const d = st.byId[current.id];
    const left = s.config.target - d.score;
    const place = st.winners.length ? `Playing for ${ordinal(st.winners.length + 1)} place` : 'Now throwing';
    info.innerHTML = `<div class="turn-label">${place}</div>
      <div class="turn-name">${esc(current.name)}</div>
      <div class="turn-sub">Score <b>${d.score}</b> · needs <b>${left}</b>${d.misses ? ` · <b>${d.misses}</b>${s.config.maxMisses > 0 ? `/${s.config.maxMisses}` : ''} misses` : ''}</div>`;
  }

  pad.innerHTML = padHTML(null);
  const disabled = st.over || !current;
  for (const key of pad.querySelectorAll('.key')) key.disabled = disabled;
}

function playerHTML(p, s, st, idx) {
  const d = st.byId[p.id];
  const cls = [
    'player',
    p.id === s.turn ? 'current' : '',
    d.eliminated ? 'out' : '',
    d.won ? 'won' : '',
  ].filter(Boolean).join(' ');

  let badges = '';
  const place = st.placeOf[p.id];
  if (place) badges += `<span class="badge won">${place === 1 ? '🏆 ' : ''}${ordinal(place)}</span>`;
  if (d.eliminated) badges += '<span class="badge out">out</span>';
  else if (d.misses) badges += `<span class="badge miss">${'•'.repeat(d.misses)} miss</span>`;

  const chips = d.rows.map((r, i) => {
    const c = ['chip', r.pins === 0 ? 'miss' : '', r.void ? 'void' : ''].filter(Boolean).join(' ');
    const label = r.pins === 0 ? '–' : r.pins;
    return `<button class="${c}" data-act="edit" data-i="${i}" title="Throw ${i + 1} → ${r.void ? 'ignored' : r.score}">${label}</button>`;
  }).join('');

  const open = openDrawers.has(p.id);
  const drawer = `
    <div class="drawer"${open ? '' : ' hidden'}>
      <div class="drawer-row">
        <input type="text" value="${esc(p.name)}" data-act="rename" maxlength="24" aria-label="Rename player">
      </div>
      <div class="drawer-row">
        <button class="btn ghost small" data-act="up"${idx === 0 ? ' disabled' : ''}>↑ Up</button>
        <button class="btn ghost small" data-act="down"${idx === s.players.length - 1 ? ' disabled' : ''}>↓ Down</button>
        <button class="btn ghost small" data-act="setturn">Make it their turn</button>
        <button class="btn danger small" data-act="remove">Remove</button>
      </div>
    </div>`;

  return `<li class="${cls}" data-id="${p.id}">
    <div class="phead">
      <span class="pos">${idx + 1}</span>
      <span class="pname">${esc(p.name)}</span>
      ${badges}
      <span class="pscore">${d.score}</span>
      <button class="icon" data-act="toggle" aria-expanded="${open}" aria-label="Player options">⋯</button>
    </div>
    <div class="throws">
      ${chips}
      <button class="chip add" data-act="append" title="Add a throw for this player">+</button>
    </div>
    ${drawer}
  </li>`;
}

function renderPlayers(s, st) {
  const list = $('#players');
  list.innerHTML = s.players.length
    ? s.players.map((p, i) => playerHTML(p, s, st, i)).join('')
    : '<li class="empty">No players yet. Add the first one below — the order here is the throwing order, top to bottom.</li>';
}

const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');

function renderBanner(s, st) {
  const b = $('#banner');
  if (st.pending <= s.acknowledged) { b.innerHTML = ''; return; }

  let msg;
  if (st.lastStanding) msg = `${esc(st.lastStanding.name)} wins — everybody else is out. 🎉`;
  else if (st.winners.length === 1) msg = `${esc(st.winners[0].name)} reaches ${s.config.target}! 🎉`;
  else {
    const latest = st.winners[st.winners.length - 1];
    msg = `${esc(latest.name)} finishes ${ordinal(st.winners.length)}.`;
  }

  // While others can still throw, dismissing the banner just resumes play.
  const dismissLabel = st.over ? 'Dismiss' : `Keep playing (${st.active.length} left)`;
  b.innerHTML = `<b>${msg}</b>
    <button class="btn" id="bannerDismiss" type="button">${dismissLabel}</button>
    <button class="btn" id="bannerNew" type="button">New game</button>`;
  $('#bannerDismiss').addEventListener('click', acknowledge);
  $('#bannerNew').addEventListener('click', startNewGame);
}

/** Everything outside the player list -- safe to refresh mid-interaction. */
function renderChrome() {
  const s = H.present;
  const st = compute(s);
  $('#undo').disabled = !H.past.length;
  $('#redo').disabled = !H.future.length;
  renderTurn(s, st);
  renderBanner(s, st);
}

function render() {
  const s = H.present;
  const st = compute(s);
  renderChrome();
  renderPlayers(s, st);
}

/* ---------- throw editor ---------- */

let editTarget = null; // { id, index } — index null means "append"

function openEditor(id, index) {
  const s = H.present;
  const p = s.players.find((x) => x.id === id);
  if (!p) return;
  editTarget = { id, index };
  const current = index === null ? null : p.throws[index];
  $('#editTitle').textContent = index === null
    ? `Add a throw — ${p.name}`
    : `Throw ${index + 1} — ${p.name}`;
  $('#editPad').innerHTML = padHTML(current);
  $('#editDelete').hidden = index === null;
  $('#editDlg').showModal();
}

/* ---------- events ---------- */

$('#undo').addEventListener('click', undo);
$('#redo').addEventListener('click', redo);

$('#pad').addEventListener('click', (e) => {
  const key = e.target.closest('.key');
  if (key && !key.disabled) recordThrow(Number(key.dataset.pins));
});

$('#addPlayer').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#newName');
  const name = input.value.trim();
  if (!name) return;
  addPlayer(name);
  input.value = '';
  input.focus();
});

$('#players').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('.player').dataset.id;
  switch (btn.dataset.act) {
    case 'toggle': {
      if (openDrawers.has(id)) openDrawers.delete(id);
      else openDrawers.add(id);
      render();
      break;
    }
    case 'edit': openEditor(id, Number(btn.dataset.i)); break;
    case 'append': openEditor(id, null); break;
    case 'up': movePlayer(id, -1); break;
    case 'down': movePlayer(id, 1); break;
    case 'remove': openDrawers.delete(id); removePlayer(id); break;
    case 'setturn': commit((s) => { s.turn = id; }); break;
  }
});

$('#players').addEventListener('change', (e) => {
  const input = e.target.closest('[data-act="rename"]');
  if (!input) return;
  const li = input.closest('.player');
  const id = li.dataset.id;
  const name = input.value.trim();
  const player = H.present.players.find((p) => p.id === id);
  if (!player) return;
  if (!name) { input.value = player.name; return; }   // reject a blank name
  renamePlayer(id, name);
  li.querySelector('.pname').textContent = name;      // patch in place
  renderChrome();
});

$('#editPad').addEventListener('click', (e) => {
  const key = e.target.closest('.key');
  if (!key || !editTarget) return;
  setThrow(editTarget.id, editTarget.index, Number(key.dataset.pins));
  $('#editDlg').close();
});

$('#editDelete').addEventListener('click', () => {
  if (editTarget && editTarget.index !== null) deleteThrow(editTarget.id, editTarget.index);
  $('#editDlg').close();
});

$('#editCancel').addEventListener('click', () => $('#editDlg').close());
$('#editDlg').addEventListener('close', () => { editTarget = null; });

/* settings */
$('#settingsBtn').addEventListener('click', () => {
  const c = H.present.config;
  $('#cfgTarget').value = c.target;
  $('#cfgResetTo').value = c.resetTo;
  $('#cfgMisses').value = c.maxMisses;
  $('#settingsDlg').showModal();
  // Keep focus off the number inputs so Android doesn't raise the keyboard.
  $('#settingsClose').focus({ preventScroll: true });
});

$('#settingsClose').addEventListener('click', () => $('#settingsDlg').close());

for (const [sel, key] of [['#cfgTarget', 'target'], ['#cfgResetTo', 'resetTo'], ['#cfgMisses', 'maxMisses']]) {
  $(sel).addEventListener('change', (e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v) && v >= 0) setConfig({ [key]: Math.round(v) });
    else e.target.value = H.present.config[key];
  });
}

$('#newGame').addEventListener('click', () => {
  startNewGame();
  $('#settingsDlg').close();
});

$('#clearAll').addEventListener('click', () => {
  if (!confirm('Remove all players and throws? This is still undoable.')) return;
  commit((s) => { s.players = []; s.turn = null; });
  $('#settingsDlg').close();
});

/* keyboard */
document.addEventListener('keydown', (e) => {
  const typing = e.target.matches('input, textarea');
  const key = e.key.toLowerCase();

  if ((e.ctrlKey || e.metaKey) && key === 'z') {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && key === 'y') { e.preventDefault(); redo(); return; }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;

  if (/^[0-9]$/.test(e.key)) {
    const pins = Number(e.key);
    if ($('#editDlg').open && editTarget) {
      setThrow(editTarget.id, editTarget.index, pins);
      $('#editDlg').close();
    } else if (!$('#settingsDlg').open) {
      recordThrow(pins);
    }
    e.preventDefault();
  }
});

render();
