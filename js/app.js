import { createStore } from './store.js';
import {
  CHARACTERS, CHAR_BY_ID, ROOMS, ROOM_BY_ID, STAT_LABELS, SAVE_LABELS,
  PANIC_TABLE, WOUND_TABLE, EVENTS, GRETA_MODES, O2_START, initialChars
} from './data.js';

// ---------- утиліти ----------
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rnd = n => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };
const d100 = () => rnd(100);
const dN = n => rnd(n) + 1;
const pad2 = n => String(n).padStart(2, '0');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const IS_GM_PAGE = /[?&#]gm\b/.test(location.search + location.hash);

let store;
const S = { seats: {}, chars: {}, state: null, log: {}, secret: null, secrets: {}, gm: {}, isAdmin: false };
const UI = {
  pick: null, sheetOpen: true, secretOpen: false, target: null, skill: null,
  adv: false, dis: false, lastRoll: null, panicPrompt: false, cutTs: null, dismissedCut: null,
  gretaTs: null, voice: false, lastTurn: undefined, view: IS_GM_PAGE ? 'map' : 'loc', imgIdx: 0, mainKey: null, openSec: new Set(), gmSel: null, resetArm: false, gmLast: null
};
const subs = [];

function myCharId() {
  for (const [id, seat] of Object.entries(S.seats || {})) if (seat && seat.uid === store.uid) return id;
  return null;
}

// ---------- кістки ----------
function evalCheck(r, target) {
  if (r === 99) return 0;
  if (r === 0) return 3;
  const doubles = Math.floor(r / 10) === r % 10;
  const ok = r < target;
  return ok ? (doubles ? 3 : 2) : (doubles ? 0 : 1);
}
const RANK_LABEL = ['КРИТИЧНИЙ ПРОВАЛ', 'ПРОВАЛ', 'УСПІХ', 'КРИТИЧНИЙ УСПІХ'];

function logPush(text, kind = 'roll', charId = null) {
  const c = charId ? CHAR_BY_ID[charId] : null;
  return store.push('game/log', { uid: store.uid, who: c ? c.name : 'Ґрета', charId: charId || null, text, kind });
}

function targetInfo(cid) {
  const c = CHAR_BY_ID[cid];
  if (!UI.target) return null;
  const [kind, key] = UI.target;
  const base = kind === 'stat' ? c.stats[key] : c.saves[key];
  const label = kind === 'stat' ? STAT_LABELS[key] : SAVE_LABELS[key];
  const sk = UI.skill != null ? c.skills[UI.skill] : null;
  return { base, label, sk, total: base + (sk ? sk[1] : 0) };
}

async function doCheck() {
  const id = myCharId(); if (!id) return;
  const t = targetInfo(id); if (!t) return;
  const twice = UI.adv !== UI.dis;
  const rolls = twice ? [d100(), d100()] : [d100()];
  const ranks = rolls.map(r => evalCheck(r, t.total));
  let i = 0;
  if (twice) i = UI.adv ? (ranks[0] >= ranks[1] ? 0 : 1) : (ranks[0] <= ranks[1] ? 0 : 1);
  const rank = ranks[i];
  const st = S.chars[id];
  let extra = '';
  if (rank <= 1) {
    const ns = clamp((st.stress || 2) + 1, st.minStress || 2, 20);
    await store.update(`game/chars/${id}`, { stress: ns });
    extra = ` · +1 Стрес (${ns})`;
  }
  if (rank === 0) { UI.panicPrompt = true; extra += ' · КИДАЙ ПАНІКУ'; }
  const mod = twice ? (UI.adv ? ' [+]' : ' [−]') : '';
  const rollsTxt = rolls.map(pad2).join(' / ');
  UI.lastRoll = { big: pad2(rolls[i]), label: RANK_LABEL[rank], rank, sub: `${t.label}${t.sk ? ' + ' + t.sk[0] : ''} = ${t.total}${mod}` };
  await logPush(`${t.label}${t.sk ? ' + ' + t.sk[0] : ''} (${t.total})${mod}: ${rollsTxt} → ${RANK_LABEL[rank]}${extra}`, rank === 0 ? 'bad' : rank === 3 ? 'good' : 'roll', id);
  renderTray();
}

async function doPanic() {
  const id = myCharId(); if (!id) return;
  const st = S.chars[id];
  const d = dN(20);
  const stress = st.stress || 2;
  UI.panicPrompt = false;
  if (d > stress) {
    const ns = Math.max(st.minStress || 2, stress - 1);
    await store.update(`game/chars/${id}`, { stress: ns });
    UI.lastRoll = { big: d, label: 'ТРИМАЄТЬСЯ', rank: 2, sub: `Паніка d20 > Стрес ${stress}` };
    await logPush(`ПЕРЕВІРКА ПАНІКИ: d20 = ${d} > Стрес ${stress} → тримається. Стрес ${ns}`, 'good', id);
  } else {
    UI.lastRoll = { big: d, label: 'ПАНІКА', rank: 0, sub: PANIC_TABLE[d - 1] };
    await logPush(`ПАНІКА: d20 = ${d} ≤ Стрес ${stress} → ${PANIC_TABLE[d - 1]}`, 'bad', id);
  }
  renderTray();
}

async function doWound(id) {
  const c = CHAR_BY_ID[id]; const st = S.chars[id];
  const d = dN(10);
  const entry = WOUND_TABLE.find(w => d <= w[0])[1];
  const wounds = Math.min(2, (st.wounds || 0) + 1);
  await store.update(`game/chars/${id}`, { wounds, health: c.health });
  const dying = wounds >= 2 ? ' ПРИ СМЕРТІ: без медика — смерть за d5 раундів.' : '';
  await logPush(`РАНА: d10 = ${d} → ${entry}${dying}`, 'bad', id);
}

async function freeDie(n, hidden = false) {
  const r = n === 100 ? d100() : dN(n);
  const txt = `d${n} → ${n === 100 ? pad2(r) : r}`;
  if (hidden) {
    await store.push('game/gm/log', { text: txt });
    UI.gmLast = txt; renderGMControls();
    return;
  }
  const id = myCharId();
  UI.lastRoll = { big: n === 100 ? pad2(r) : r, label: `d${n}`, rank: -1, sub: 'вільний кидок' };
  await logPush(txt, 'roll', IS_GM_PAGE ? null : id);
  if (!IS_GM_PAGE) renderTray();
}

// ---------- спільні компоненти ----------
function ringHTML(mode) {
  return `<div class="ring mode-${esc(mode || 'assist')}" title="Ґрета: ${esc(GRETA_MODES[mode || 'assist'])}"><span></span></div>`;
}

function o2HTML() {
  const m = S.state ? S.state.o2 ?? O2_START : O2_START;
  const segs = Math.min(12, Math.ceil(m / 30));
  const crit = m <= 120;
  let bar = '';
  for (let i = 0; i < 12; i++) bar += `<i class="${i < segs ? 'on' : ''}"></i>`;
  return `<div class="o2 ${crit ? 'crit' : ''}"><span class="lbl">O2</span><span class="val">${pad2(Math.floor(m / 60))}:${pad2(m % 60)}:00</span><span class="bar">${bar}</span></div>`;
}

function portraitHTML(c, cls = '') {
  return `<div class="portrait ${cls}" style="--c:${c.color}">
    ${c.portrait ? `<img src="assets/portraits/${esc(c.portrait)}" alt="">` : ''}
    <svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="36" r="18"/><path d="M14 100c2-26 18-38 36-38s34 12 36 38z"/></svg>
  </div>`;
}

function mapHTML(clickable) {
  const tokensByRoom = {};
  for (const c of CHARACTERS) {
    const st = S.chars[c.id]; if (!st) continue;
    const seat = S.seats[c.id];
    if (!IS_GM_PAGE) {
      // гравець бачить лише себе і тих, хто в одній кімнаті з ним
      if (!seat) continue;
      const mine = S.chars[myCharId()];
      if (c.id !== myCharId() && (!mine || mine.loc !== st.loc)) continue;
    }
    (tokensByRoom[st.loc] ||= []).push(c);
  }
  const me = myCharId();
  let rooms = '';
  for (const r of ROOMS) {
    for (const [l, t, w, h] of r.rects) {
      rooms += `<button class="room ${r.outside ? 'outside' : ''}" style="left:${l}%;top:${t}%;width:${w}%;height:${h}%" data-act="${clickable ? 'room' : ''}" data-room="${r.id}" title="${esc(r.id + ' — ' + r.name)}"></button>`;
    }
  }
  let tokens = '';
  for (const [rid, list] of Object.entries(tokensByRoom)) {
    const r = ROOM_BY_ID[rid]; if (!r) continue;
    list.forEach((c, i) => {
      const x = r.anchor[0] + (i - (list.length - 1) / 2) * 2.4;
      const y = r.anchor[1];
      const sel = IS_GM_PAGE ? UI.gmSel === c.id : me === c.id;
      tokens += `<button class="token ${sel ? 'me' : ''}" data-act="${IS_GM_PAGE ? 'gmSel' : ''}" data-id="${c.id}" style="left:${x}%;top:${y}%;--c:${c.color}" title="${esc(c.name)}">${esc(c.name[0])}</button>`;
    });
  }
  const outside = ROOM_BY_ID.OUT.rects[0];
  return `<div class="map"><img src="assets/ship.png" alt="Схема корабля STS-187">${rooms}
    <div class="outside-label" style="left:${outside[0]}%;top:${outside[1] + outside[3] + 0.5}%">ЗОВНІ</div>${tokens}</div>
    <div class="map-hint">${clickable ? (IS_GM_PAGE ? 'Оберіть персонажа (фішку або картку), потім клікніть кімнату' : (turnId() && turnId() !== myCharId() ? 'Зараз хід ' + CHAR_BY_ID[turnId()].name + ' — переходити можна у свій хід' : 'Клікніть кімнату, щоб перейти. Інших видно, лише коли ви в одній кімнаті')) : ''}</div>`;
}

function turnId() { return (S.state && S.state.turn && S.seats[S.state.turn]) ? S.state.turn : null; }

function currentRoom() {
  if (IS_GM_PAGE) {
    const f = UI.gmSel || turnId();
    return f && S.chars[f] ? S.chars[f].loc : 'A1';
  }
  const t = turnId();
  if (t && S.chars[t]) return S.chars[t].loc;
  const id = myCharId();
  return id && S.chars[id] ? S.chars[id].loc : 'A1';
}

function locHTML(rid) {
  const r = ROOM_BY_ID[rid] || ROOM_BY_ID.A1;
  const here = CHARACTERS.filter(c => S.chars[c.id] && S.chars[c.id].loc === r.id && (S.seats[c.id] || IS_GM_PAGE));
  const img = r.imgs.length ? r.imgs[UI.imgIdx % r.imgs.length] : null;
  return `<div class="loc">
    ${img ? `<img src="${img}" alt="${esc(r.name)}">` : `<div class="noimg">${r.outside ? 'ЗОВНІ. ВАКУУМ.' : 'НЕМАЄ ЗОБРАЖЕННЯ З КАМЕРИ'}</div>`}
    <div class="loc-label"><small>${turnId() ? 'ХІД · ' + esc(CHAR_BY_ID[turnId()].name) : 'ЛОКАЦІЯ'}</small><b>${esc(r.id)} · ${esc(r.name)}</b></div>
    ${r.imgs.length > 1 ? `<button class="loc-next ghost" data-act="nextImg" title="Інший ракурс">${UI.imgIdx % r.imgs.length + 1}/${r.imgs.length} ▸</button>` : ''}
    <div class="loc-here">${here.map(c => `<span class="chipc" style="--c:${c.color}">${esc(c.name)}${S.seats[c.id] ? ' · ' + esc(S.seats[c.id].name) : ''}</span>`).join('')}</div>
    <button class="loc-map primary" data-act="view" data-v="map">МАПА КОРАБЛЯ</button>
  </div>`;
}

function renderMain(force) {
  const el = $('#map'); if (!el) return;
  const rid = currentRoom();
  const key = UI.view === 'map'
    ? 'map|' + JSON.stringify(S.chars) + JSON.stringify(Object.keys(S.seats || {})) + UI.gmSel
    : `loc|${rid}|${UI.imgIdx}|${turnId()}|` + CHARACTERS.map(c => (S.chars[c.id] || {}).loc + (S.seats[c.id] ? S.seats[c.id].name : '')).join(',');
  if (!force && key === UI.mainKey) return;
  UI.mainKey = key;
  const tabs = `<div class="viewtabs"><button class="tog ${UI.view === 'loc' ? 'on' : ''}" data-act="view" data-v="loc">ЛОКАЦІЯ</button><button class="tog ${UI.view === 'map' ? 'on' : ''}" data-act="view" data-v="map">МАПА</button></div>`;
  el.innerHTML = tabs + (UI.view === 'map' ? mapHTML(true) : locHTML(rid));
}

function logHTML(entries) {
  const list = Object.entries(entries || {}).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  if (!list.length) return '<div class="empty">Поки тихо.</div>';
  return list.map(([, e]) => {
    const c = e.charId ? CHAR_BY_ID[e.charId] : null;
    return `<div class="entry k-${esc(e.kind)}"><b style="--c:${c ? c.color : 'var(--accent)'}">${esc(e.who)}</b> ${esc(e.text)}</div>`;
  }).join('');
}

function gretaBanner() {
  const g = S.state && S.state.greta;
  const el = $('#greta');
  if (!el) return;
  if (!g || !g.text) { el.innerHTML = ''; return; }
  if (g.ts !== UI.gretaTs) {
    const first = UI.gretaTs === null;
    UI.gretaTs = g.ts;
    el.innerHTML = `<div class="greta-msg" data-act="closeGreta">${ringHTML(S.state.mode)}<div><small>ҐРЕТА</small>${esc(g.text)}</div></div>`;
    if (!first && g.voice && !IS_GM_PAGE) speak(g.text);
    clearTimeout(UI.gretaTimer);
    UI.gretaTimer = setTimeout(() => { if ($('#greta')) $('#greta').innerHTML = ''; }, 15000);
  }
}

function speak(text) {
  if (!UI.voice || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  const v = speechSynthesis.getVoices().find(v => /^uk/i.test(v.lang));
  if (v) u.voice = v;
  u.lang = 'uk-UA'; u.rate = 0.95; u.pitch = 0.9;
  speechSynthesis.cancel(); speechSynthesis.speak(u);
}

function youtubeId(url) {
  const m = String(url).match(/(?:youtu\.be\/|v=|embed\/|shorts\/)([\w-]{11})/);
  return m ? m[1] : null;
}

function renderCutscene() {
  const cut = S.state && S.state.cutscene;
  const el = $('#cut'); if (!el) return;
  const ts = cut ? cut.ts : null;
  if (ts === UI.cutTs) return;
  UI.cutTs = ts;
  if (!cut || IS_GM_PAGE || UI.dismissedCut === ts) { el.innerHTML = ''; return; }
  const yt = youtubeId(cut.url);
  const media = yt
    ? `<iframe src="https://www.youtube.com/embed/${yt}?autoplay=1&rel=0&modestbranding=1&playsinline=1" allow="autoplay; fullscreen" allowfullscreen></iframe>`
    : `<video src="${esc(cut.url)}" autoplay playsinline controls></video>`;
  el.innerHTML = `<div class="cutscene"><div class="cut-title">${esc(cut.title || '')}</div>${media}<button class="ghost" data-act="skipCut">Закрити</button></div>`;
}

// ---------- ГРАВЕЦЬ ----------
function renderPlayer() {
  const id = myCharId();
  if (!S.state) {
    $('#app').innerHTML = `<div class="center-msg cover"><div style="flex:1"></div>${ringHTML('evade')}<p>Ведучий ще не запустив гру. Сторінка оновиться сама.</p></div>`;
    return;
  }
  if (!id) return renderJoin();
  if (!$('#playerRoot')) {
    $('#app').innerHTML = `<div id="playerRoot" class="screen player">
      <header class="topbar"><div class="brand">STS-187</div><div id="o2"></div><div class="spacer"></div><div id="turn"></div>
        <button class="ghost small" data-act="voice" id="voiceBtn"></button><div id="who" class="who"></div><div id="ring"></div></header>
      <div id="greta"></div>
      <main class="layout"><section class="mapcol" id="map"></section>
        <aside class="sheet" id="sheet"></aside><aside class="logcol"><h4>ЖУРНАЛ</h4><div id="log" class="log"></div></aside></main>
      <footer class="tray" id="tray"></footer><div id="cut"></div></div>`;
  }
  const c = CHAR_BY_ID[id];
  $('#o2').innerHTML = o2HTML();
  $('#ring').innerHTML = ringHTML(S.state.mode);
  $('#who').innerHTML = `<span style="color:${c.color}">${esc(c.name)}</span> · ${esc(S.seats[id].name)}`;
  $('#voiceBtn').textContent = UI.voice ? 'ГОЛОС ҐРЕТИ: ON' : 'ГОЛОС ҐРЕТИ: OFF';
  renderTurn();
  renderMain();
  $('#log').innerHTML = logHTML(S.log);
  renderSheet(); renderTray(); gretaBanner(); renderCutscene();
}

function turnBadge() {
  const t = turnId();
  if (!t) return '<div class="turn free">ВІЛЬНИЙ РЕЖИМ</div>';
  const c = CHAR_BY_ID[t];
  const mine = !IS_GM_PAGE && t === myCharId();
  return `<div class="turn ${mine ? 'mine' : ''}" style="--c:${c.color}"><small>ХІД</small><b>${mine ? 'ВАШ ХІД' : esc(c.name)}</b></div>`;
}
function renderTurn() {
  const el = $('#turn'); if (!el) return;
  const t = turnId();
  if (t !== UI.lastTurn) {           // хід змінився — всі дивляться на локацію активного персонажа
    UI.lastTurn = t; UI.imgIdx = 0;
    if (t && !IS_GM_PAGE) UI.view = 'loc';
  }
  el.innerHTML = turnBadge();
}

function renderJoin() {
  const sel = UI.pick;
  const cards = CHARACTERS.map(c => {
    const taken = !!S.seats[c.id];
    return `<button class="crew-card ${taken ? 'taken' : ''} ${sel === c.id ? 'sel' : ''}" data-act="${taken ? '' : 'pick'}" data-id="${c.id}" ${taken ? 'disabled' : ''}>
      ${portraitHTML(c)}<div class="cc-name">${esc(c.name)}</div><div class="cc-role">${esc(c.role)}</div>
      <div class="tag">${taken ? 'ЗАЙНЯТО · ' + esc(S.seats[c.id].name) : 'ВІЛЬНО'}</div></button>`;
  }).join('');
  const name = $('#joinName') ? $('#joinName').value : (localStorage.getItem('kvitka-name') || '');
  $('#app').innerHTML = `<div class="screen join">
    <header class="join-head"><h1><small>STS-187 · ДЕНЬ 547</small>CREW MANIFEST <em>///</em></h1><div class="ai">AI ${ringHTML(S.state.mode)}</div></header>
    <div class="cards">${cards}</div>
    <footer class="join-foot"><input id="joinName" maxlength="24" placeholder="ВАШЕ ІМ'Я" value="${esc(name)}">
      <button class="primary" data-act="join" ${sel ? '' : 'disabled'}>НА БОРТ</button></footer>
    <div id="joinErr" class="err"></div></div>`;
}

function renderSheet() {
  const id = myCharId(); const el = $('#sheet'); if (!id || !el) return;
  const c = CHAR_BY_ID[id]; const st = S.chars[id] || {};
  el.classList.toggle('closed', !UI.sheetOpen);
  if (!UI.sheetOpen) { el.innerHTML = `<button class="sheet-toggle" data-act="toggleSheet" title="Відкрити лист">◂ ЛИСТ</button>`; return; }
  const isT = (k, key) => UI.target && UI.target[0] === k && UI.target[1] === key;
  const stats = Object.entries(STAT_LABELS).map(([k, l]) => `<button class="stat ${isT('stat', k) ? 'sel' : ''}" data-act="target" data-k="stat" data-key="${k}"><small>${l}</small><b>${c.stats[k]}</b></button>`).join('');
  const saves = Object.entries(SAVE_LABELS).map(([k, l]) => `<button class="stat save ${isT('save', k) ? 'sel' : ''}" data-act="target" data-k="save" data-key="${k}"><small>${l}</small><b>${c.saves[k]}</b></button>`).join('');
  const skills = c.skills.map(([n, b], i) => `<button class="chip ${UI.skill === i ? 'sel' : ''}" data-act="skill" data-i="${i}">${esc(n)} <b>+${b}</b></button>`).join('');
  const stress = st.stress ?? 2;
  let meter = '';
  for (let i = 1; i <= 20; i++) meter += `<i class="${i <= stress ? 'on' : ''} ${i <= (st.minStress || 2) ? 'min' : ''}"></i>`;
  const wounds = [0, 1].map(i => `<span class="wbox ${i < (st.wounds || 0) ? 'on' : ''}"></span>`).join('');
  const secret = S.secret ? (UI.secretOpen ? `<div class="secret">${esc(S.secret)}</div>` : '') : '<div class="muted">Ведучий ще не надіслав.</div>';
  el.innerHTML = `
    <div class="sheet-head">${portraitHTML(c, 'sm')}<div><b>${esc(c.name)}</b><small>${esc(c.role)} · ${esc(c.cls)}</small></div>
      <button class="ghost small" data-act="toggleSheet" title="Сховати">▸</button></div>
    <h4>STATS <span class="muted">— оберіть для перевірки</span></h4><div class="stats">${stats}</div>
    <h4>SAVES</h4><div class="stats three">${saves}</div>
    <h4>СТАН</h4>
    <div class="track"><span>HEALTH</span><button class="ghost small" data-act="hp" data-d="-1">−</button><b>${st.health ?? c.health} / ${c.health}</b><button class="ghost small" data-act="hp" data-d="1">+</button></div>
    <div class="track"><span>WOUNDS</span>${wounds}<button class="ghost small warn" data-act="wound">РАНА d10</button></div>
    <div class="track"><span>STRESS</span><button class="ghost small" data-act="stress" data-d="-1">−</button><b class="${stress >= 10 ? 'hot' : ''}">${stress}</b><button class="ghost small" data-act="stress" data-d="1">+</button></div>
    <div class="meter">${meter}</div>
    <h4>НАВИЧКИ <span class="muted">— одна на кидок</span></h4><div class="chips">${skills}</div>
    <h4>СПОРЯДЖЕННЯ</h4><ul class="gear">${c.gear.map(g => `<li>${esc(g)}</li>`).join('')}</ul>
    <h4>ОСОБЛИВІСТЬ</h4><p class="trait">${esc(c.trait)}</p>
    <h4>ТАЄМНА ЦІЛЬ ${S.secret ? `<button class="ghost small" data-act="secret">${UI.secretOpen ? 'СХОВАТИ' : 'ПОКАЗАТИ'}</button>` : ''}</h4>${secret}
    <button class="ghost small leave" data-act="leave">Звільнити персонажа</button>`;
}

function renderTray() {
  const id = myCharId(); const el = $('#tray'); if (!id || !el) return;
  const t = targetInfo(id);
  const lr = UI.lastRoll;
  const rankCls = lr ? (lr.rank === 3 || lr.rank === 2 ? 'ok' : lr.rank === -1 ? '' : 'fail') : '';
  el.innerHTML = `
    <div class="check">${t ? `<small>ПЕРЕВІРКА</small><b>${esc(t.label)} ${t.base}${t.sk ? ` + ${esc(t.sk[0])} ${t.sk[1]}` : ''} = <span class="tgt">${t.total}</span></b><small>треба викинути менше</small>` : '<small>ПЕРЕВІРКА</small><b class="muted">Оберіть характеристику або спаску в листі</b>'}</div>
    <div class="mods"><button class="tog ${UI.adv ? 'on' : ''}" data-act="adv">ПЕРЕВАГА +</button><button class="tog ${UI.dis ? 'on' : ''}" data-act="dis">ПЕРЕШКОДА −</button></div>
    <button class="primary big" data-act="check" ${t ? '' : 'disabled'}>КИНУТИ d100</button>
    <button class="danger ${UI.panicPrompt ? 'pulse' : ''}" data-act="panic">ПАНІКА d20</button>
    <div class="free">${[100, 20, 10, 5].map(n => `<button class="die" data-act="die" data-n="${n}">d${n}</button>`).join('')}</div>
    <div class="result ${rankCls}">${lr ? `<b>${esc(lr.big)}</b><div><span>${esc(lr.label)}</span><small>${esc(lr.sub)}</small></div>` : '<small class="muted">Останній кидок з\'явиться тут</small>'}</div>`;
}

async function bootPlayer() {
  await store.ensureAnon();
  subs.push(store.on('game/state', v => { S.state = v; renderPlayer(); }));
  subs.push(store.on('game/seats', v => {
    S.seats = v || {};
    const id = myCharId();
    if (id && S._secretFor !== id) {
      S._secretFor = id;
      if (S._secretOff) S._secretOff();
      S._secretOff = store.on(`game/secrets/${id}`, s => { S.secret = s && s.text; renderSheet(); });
    }
    if (!$('#playerRoot') || !id) $('#app').innerHTML = '';
    renderPlayer();
  }));
  subs.push(store.on('game/chars', v => { S.chars = v || {}; if ($('#playerRoot')) { renderMain(); renderSheet(); } }));
  subs.push(store.on('game/log', v => { S.log = v || {}; if ($('#log')) $('#log').innerHTML = logHTML(S.log); }, 80));
}

// ---------- ВЕДУЧИЙ ----------
function renderGM() {
  if (!$('#gmRoot')) {
    $('#app').innerHTML = `<div id="gmRoot" class="screen gm">
      <header class="topbar"><div class="brand">WARDEN // GRETA CORE</div><div id="o2"></div>
        <div class="o2ctl"><button class="ghost small" data-act="o2" data-d="-30">−30</button><button class="ghost small" data-act="o2" data-d="30">+30</button><button class="ghost small" data-act="o2set">6:00</button></div>
        <div class="spacer"></div><div id="turn"></div>
        <div class="o2ctl"><button class="primary small" data-act="nextTurn">НАСТУПНИЙ ХІД ▸</button><button class="ghost small" data-act="freeTurn">ВІЛЬНО</button></div>
        <div id="modes" class="modes"></div><div id="ring"></div></header>
      <div id="greta"></div>
      <main class="layout gm-layout"><aside class="crewcol" id="crew"></aside><section class="mapcol" id="map"></section>
        <aside class="ctlcol" id="ctl"></aside></main></div>`;
  }
  $('#o2').innerHTML = o2HTML();
  const mode = S.state ? S.state.mode : 'assist';
  $('#ring').innerHTML = ringHTML(mode);
  renderTurn();
  $('#modes').innerHTML = Object.entries(GRETA_MODES).map(([k, l]) => `<button class="tog ${mode === k ? 'on' : ''}" data-act="mode" data-m="${k}">${l}</button>`).join('');
  renderMain();
  renderCrew(); renderGMControls(); gretaBanner();
}

function renderCrew() {
  const el = $('#crew'); if (!el) return;
  el.innerHTML = '<h4>ЕКІПАЖ</h4>' + CHARACTERS.map(c => {
    const st = S.chars[c.id] || {}; const seat = S.seats[c.id];
    const sec = (S.secrets[c.id] && S.secrets[c.id].text) || '';
    const room = ROOM_BY_ID[st.loc];
    return `<div class="crew ${UI.gmSel === c.id ? 'sel' : ''}" style="--c:${c.color}">
      <div class="crew-top" data-act="gmSel" data-id="${c.id}"><b>${esc(c.name)}${turnId() === c.id ? ' <span class="turn-dot">ХІД</span>' : ''}</b><span>${seat ? esc(seat.name) : '<i class="muted">вільно</i>'}</span></div>
      <div class="crew-loc muted">${room ? esc(room.id + ' · ' + room.name) : '—'}</div>
      <div class="crew-row"><span>HP</span><button class="ghost xs" data-act="gHp" data-id="${c.id}" data-d="-1">−</button><b>${st.health ?? '?'}/${c.health}</b><button class="ghost xs" data-act="gHp" data-id="${c.id}" data-d="1">+</button>
        <span>W</span><b>${st.wounds ?? 0}/2</b><button class="ghost xs" data-act="gWound" data-id="${c.id}" data-d="1">+</button><button class="ghost xs" data-act="gWound" data-id="${c.id}" data-d="-1">−</button></div>
      <div class="crew-row"><span>STRESS</span><button class="ghost xs" data-act="gStress" data-id="${c.id}" data-d="-1">−</button><b class="${(st.stress || 0) >= 10 ? 'hot' : ''}">${st.stress ?? '?'}</b><button class="ghost xs" data-act="gStress" data-id="${c.id}" data-d="1">+</button>
        <span>MIN</span><b>${st.minStress ?? 2}</b><button class="ghost xs" data-act="gMin" data-id="${c.id}" data-d="1">+</button></div>
      <details data-sec="${c.id}" ${UI.openSec.has(c.id) ? 'open' : ''}><summary>ТАЄМНА ЦІЛЬ ${sec ? '✓' : ''}</summary><textarea id="sec-${c.id}" rows="5" placeholder="Текст побачить тільки гравець цього персонажа">${esc(sec)}</textarea>
        <button class="ghost small" data-act="saveSecret" data-id="${c.id}">ЗБЕРЕГТИ</button></details>
      ${seat ? `<button class="ghost xs" data-act="setTurn" data-id="${c.id}">дати хід</button> <button class="ghost xs" data-act="kick" data-id="${c.id}">звільнити місце</button>` : ''}
    </div>`;
  }).join('');
}

function renderGMControls() {
  const el = $('#ctl'); if (!el) return;
  const cuts = Object.entries((S.gm && S.gm.cutscenes) || {});
  const playing = S.state && S.state.cutscene;
  const hidden = Object.entries((S.gm && S.gm.log) || {}).sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 6);
  const keepOpen = el.querySelector('#gretaText') ? el.querySelector('#gretaText').value : '';
  el.innerHTML = `
    <h4>ҐРЕТА КАЖЕ</h4>
    <textarea id="gretaText" rows="2" placeholder="Текст з'явиться в усіх на екрані">${esc(keepOpen)}</textarea>
    <div class="row"><label class="chk"><input type="checkbox" id="gretaVoice" checked> озвучити</label><button class="primary small" data-act="gretaSay">СКАЗАТИ</button><button class="ghost small" data-act="gretaClear">ПРИБРАТИ</button></div>
    <h4>КАТ-СЦЕНИ</h4>
    <div class="cuts">${cuts.length ? cuts.map(([k, v]) => `<div class="cutrow"><span>${esc(v.title)}</span><button class="ghost xs" data-act="playCut" data-k="${k}">▶ ДЛЯ ВСІХ</button><button class="ghost xs" data-act="delCut" data-k="${k}">✕</button></div>`).join('') : '<div class="muted">Додайте відео (YouTube або пряме посилання .mp4).</div>'}</div>
    <div class="row"><input id="cutTitle" placeholder="Назва"><input id="cutUrl" placeholder="URL відео"><button class="ghost small" data-act="addCut">+</button></div>
    ${playing ? `<div class="row"><span class="live">ЗАРАЗ: ${esc(playing.title)}</span><button class="danger small" data-act="stopCut">ЗУПИНИТИ</button></div>` : ''}
    <h4>ПОДІЇ</h4>
    <div class="events">${EVENTS.map((e, i) => `<button class="ghost ev" data-act="event" data-i="${i}" title="${esc(e)}"><b>${i + 1}</b> ${esc(e)}</button>`).join('')}
      <button class="ghost small" data-act="eventRnd">ВИПАДКОВА d6</button></div>
    <h4>ПРИХОВАНИЙ КИДОК</h4>
    <div class="free">${[100, 20, 10, 5].map(n => `<button class="die" data-act="hdie" data-n="${n}">d${n}</button>`).join('')}</div>
    <div class="hidden-log">${hidden.map(([, v]) => `<div>${esc(v.text)}</div>`).join('') || '<span class="muted">—</span>'}</div>
    <h4>ГРА</h4>
    <button class="${UI.resetArm ? 'danger' : 'ghost'} small" data-act="reset">${UI.resetArm ? 'ТОЧНО? НАТИСНІТЬ ЩЕ РАЗ' : (S.state ? 'НОВА ГРА (скинути все)' : 'ЗАПУСТИТИ ГРУ')}</button>
    <h4>ЖУРНАЛ</h4><div class="log">${logHTML(S.log)}</div>`;
}

async function setTurnTo(id) {
  await store.update('game/state', { turn: id });
  const c = CHAR_BY_ID[id];
  await store.push('game/log', { uid: store.uid, who: 'Хід', charId: id, text: `${c.name} (${S.seats[id] ? S.seats[id].name : '—'})`, kind: 'turn' });
}

async function gmReset() {
  await store.update('game', {
    chars: initialChars(), seats: null, log: null,
    state: { o2: O2_START, mode: 'assist', cutscene: null, greta: null, started: Date.now() }
  });
  await store.push('game/log', { uid: store.uid, who: 'Ґрета', text: 'Новий сеанс. Екіпаж STS-187, доповідайте.', kind: 'system' });
}

async function bootGM() {
  if (store.mode === 'firebase' && !store.isGoogle) {
    $('#app').innerHTML = `<div class="center-msg">${ringHTML('control')}<h1>WARDEN</h1><p>Пульт ведучого. Увійдіть акаунтом Google.</p>
      <button class="primary" data-act="gmLogin">УВІЙТИ ЧЕРЕЗ GOOGLE</button><div id="joinErr" class="err"></div></div>`;
    return;
  }
  if (store.mode === 'firebase') {
    const ok = await new Promise(res => { const off = store.on(`admins/${store.uid}`, v => { setTimeout(() => off && off(), 0); res(!!v); }); });
    if (!ok) {
      $('#app').innerHTML = `<div class="center-msg">${ringHTML('control')}<h1>ДОСТУП ЗАБОРОНЕНО</h1>
        <p>Цей акаунт ще не ведучий. Ваш UID:</p><code class="uid">${esc(store.uid)}</code>
        <p class="muted">Firebase Console → Realtime Database → Data → додайте вузол <b>admins</b> → ключ = цей UID, значення = true. Потім оновіть сторінку.</p>
        <button class="ghost" data-act="gmLogout">ВИЙТИ</button></div>`;
      return;
    }
  }
  S.isAdmin = true;
  subs.push(store.on('game/state', v => { S.state = v; renderGM(); }));
  subs.push(store.on('game/seats', v => { S.seats = v || {}; if ($('#gmRoot')) renderCrew(); }));
  subs.push(store.on('game/chars', v => { S.chars = v || {}; if ($('#gmRoot')) { renderMain(); renderCrew(); } }));
  subs.push(store.on('game/secrets', v => { S.secrets = v || {}; if ($('#gmRoot') && !document.activeElement?.matches('textarea[id^=sec-]')) renderCrew(); }));
  subs.push(store.on('game/gm', v => { S.gm = v || {}; if ($('#gmRoot')) renderGMControls(); }));
  subs.push(store.on('game/log', v => { S.log = v || {}; if ($('#gmRoot') && !document.activeElement?.matches('#ctl input, #ctl textarea')) renderGMControls(); }, 120));
}

// ---------- дії ----------
const actions = {
  async pick(el) { UI.pick = el.dataset.id; renderJoin(); },
  async join() {
    const name = ($('#joinName').value || '').trim();
    if (!name) { $('#joinErr').textContent = 'Введіть ім\'я.'; return; }
    localStorage.setItem('kvitka-name', name);
    const ok = await store.claim(`game/seats/${UI.pick}`, { uid: store.uid, name, ts: Date.now() });
    if (!ok) { $('#joinErr').textContent = 'Цього персонажа щойно зайняли. Оберіть іншого.'; UI.pick = null; }
    else await logPush(`${name} на борту.`, 'system', UI.pick);
  },
  async leave() {
    const id = myCharId(); if (!id) return;
    await store.remove(`game/seats/${id}`);
    UI.target = null; UI.skill = null; UI.lastRoll = null;
  },
  toggleSheet() { UI.sheetOpen = !UI.sheetOpen; renderSheet(); },
  secret() { UI.secretOpen = !UI.secretOpen; renderSheet(); },
  target(el) {
    const t = [el.dataset.k, el.dataset.key];
    UI.target = UI.target && UI.target[0] === t[0] && UI.target[1] === t[1] ? null : t;
    renderSheet(); renderTray();
  },
  skill(el) { const i = +el.dataset.i; UI.skill = UI.skill === i ? null : i; renderSheet(); renderTray(); },
  adv() { UI.adv = !UI.adv; if (UI.adv) UI.dis = false; renderTray(); },
  dis() { UI.dis = !UI.dis; if (UI.dis) UI.adv = false; renderTray(); },
  check: doCheck,
  panic: doPanic,
  die(el) { return freeDie(+el.dataset.n); },
  hdie(el) { return freeDie(+el.dataset.n, true); },
  async hp(el) {
    const id = myCharId(); const c = CHAR_BY_ID[id]; const st = S.chars[id];
    await store.update(`game/chars/${id}`, { health: clamp((st.health ?? c.health) + +el.dataset.d, 0, c.health) });
  },
  async stress(el) {
    const id = myCharId(); const st = S.chars[id];
    await store.update(`game/chars/${id}`, { stress: clamp((st.stress ?? 2) + +el.dataset.d, st.minStress || 2, 20) });
  },
  wound() { return doWound(myCharId()); },
  async room(el) {
    const rid = el.dataset.room;
    const id = IS_GM_PAGE ? UI.gmSel : myCharId();
    if (!id) return;
    if (!IS_GM_PAGE && turnId() && turnId() !== id) { toast('Зараз не ваш хід — переходити можна лише у свій хід.'); return; }
    if (!IS_GM_PAGE) { UI.view = 'loc'; UI.imgIdx = 0; }
    await store.update(`game/chars/${id}`, { loc: rid });
    renderMain(true);
  },
  view(el) { UI.view = el.dataset.v; renderMain(true); },
  nextImg() { UI.imgIdx++; renderMain(true); },
  voice() { UI.voice = !UI.voice; if (UI.voice) speak('Голос Ґрети увімкнено.'); renderPlayer(); },
  skipCut() { UI.dismissedCut = UI.cutTs; $('#cut').innerHTML = ''; },
  closeGreta() { $('#greta').innerHTML = ''; },
  // ведучий
  async gmLogin() {
    try { await store.signInGoogle(); location.reload(); }
    catch (e) { $('#joinErr').textContent = e.message; }
  },
  async gmLogout() { await store.signOut(); location.reload(); },
  gmSel(el) { UI.gmSel = UI.gmSel === el.dataset.id ? null : el.dataset.id; UI.imgIdx = 0; renderMain(true); renderCrew(); },
  async o2(el) { await store.update('game/state', { o2: clamp((S.state.o2 ?? O2_START) + +el.dataset.d, 0, 999) }); },
  async o2set() { await store.update('game/state', { o2: O2_START }); },
  async mode(el) { await store.update('game/state', { mode: el.dataset.m }); },
  async gHp(el) {
    const c = CHAR_BY_ID[el.dataset.id]; const st = S.chars[c.id];
    await store.update(`game/chars/${c.id}`, { health: clamp((st.health ?? c.health) + +el.dataset.d, 0, c.health) });
  },
  async gWound(el) { const st = S.chars[el.dataset.id]; await store.update(`game/chars/${el.dataset.id}`, { wounds: clamp((st.wounds || 0) + +el.dataset.d, 0, 2) }); },
  async setTurn(el) { await setTurnTo(el.dataset.id); },
  async nextTurn() {
    const seated = CHARACTERS.map(c => c.id).filter(id => S.seats[id]);
    if (!seated.length) return toast('Ще ніхто не сів за стіл.');
    const i = seated.indexOf(turnId());
    await setTurnTo(seated[(i + 1) % seated.length]);
  },
  async freeTurn() { await store.update('game/state', { turn: null }); await store.push('game/log', { uid: store.uid, who: 'Ґрета', text: 'Вільний режим: кожен діє сам.', kind: 'system' }); },
  async gStress(el) { const st = S.chars[el.dataset.id]; await store.update(`game/chars/${el.dataset.id}`, { stress: clamp((st.stress ?? 2) + +el.dataset.d, st.minStress || 2, 20) }); },
  async gMin(el) { const st = S.chars[el.dataset.id]; const m = clamp((st.minStress || 2) + 1, 2, 20); await store.update(`game/chars/${el.dataset.id}`, { minStress: m, stress: Math.max(m, st.stress || 2) }); },
  async saveSecret(el) { const id = el.dataset.id; await store.set(`game/secrets/${id}`, { text: $('#sec-' + id).value.trim() }); },
  async kick(el) { await store.remove(`game/seats/${el.dataset.id}`); },
  async gretaSay() {
    const text = $('#gretaText').value.trim(); if (!text) return;
    await store.update('game/state', { greta: { text, voice: $('#gretaVoice').checked, ts: Date.now() } });
    await store.push('game/log', { uid: store.uid, who: 'Ґрета', text, kind: 'greta' });
    $('#gretaText').value = '';
  },
  async gretaClear() { await store.update('game/state', { greta: null }); UI.gretaTs = null; },
  async addCut() {
    const title = $('#cutTitle').value.trim(); const url = $('#cutUrl').value.trim();
    if (!url) return;
    await store.push('game/gm/cutscenes', { title: title || 'Кат-сцена', url });
  },
  async delCut(el) { await store.remove(`game/gm/cutscenes/${el.dataset.k}`); },
  async playCut(el) {
    const v = S.gm.cutscenes[el.dataset.k];
    await store.update('game/state', { cutscene: { title: v.title, url: v.url, ts: Date.now() } });
  },
  async stopCut() { await store.update('game/state', { cutscene: null }); },
  async event(el) { await store.push('game/log', { uid: store.uid, who: 'Подія', text: EVENTS[+el.dataset.i], kind: 'event' }); },
  async eventRnd() { const i = rnd(6); await store.push('game/log', { uid: store.uid, who: `Подія d6=${i + 1}`, text: EVENTS[i], kind: 'event' }); },
  async reset() {
    if (S.state && !UI.resetArm) { UI.resetArm = true; renderGMControls(); setTimeout(() => { UI.resetArm = false; renderGMControls(); }, 4000); return; }
    UI.resetArm = false; await gmReset();
  }
};

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el || !el.dataset.act || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (!fn) return;
  try { await fn(el); } catch (err) { console.error(err); toast('Помилка: ' + err.message); }
});
document.addEventListener('toggle', e => {
  const d = e.target; if (!d.matches || !d.matches('details[data-sec]')) return;
  if (d.open) UI.openSec.add(d.dataset.sec); else UI.openSec.delete(d.dataset.sec);
}, true);
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'joinName' && UI.pick) actions.join(); });

const introStart = Date.now();
function introReady() {
  const m = $('#introMsg'); if (!m) return;
  setTimeout(() => { m.innerHTML = '<button class="primary big" data-act="enter">ПІДНЯТИСЯ НА БОРТ</button>'; }, Math.max(0, 1800 - (Date.now() - introStart)));
}
function closeIntro(now) {
  const el = $('#intro'); if (!el) return;
  if (now) { el.remove(); return; }
  el.classList.add('out'); setTimeout(() => el.remove(), 900);
}
actions.enter = () => { closeIntro(); if ('speechSynthesis' in window) speechSynthesis.getVoices(); };

function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 4000);
}

// ---------- старт ----------
(async () => {
  try {
    store = await createStore();
    if (store.mode === 'demo') document.body.insertAdjacentHTML('beforeend',
      `<div class="demo-flag">ДЕМО-РЕЖИМ · без Firebase · ${IS_GM_PAGE ? '<a href="./">екран гравця</a>' : '<a href="?gm">пульт ведучого</a>'}</div>`);
    if (IS_GM_PAGE) { await bootGM(); closeIntro(true); } else { await bootPlayer(); introReady(); }
  } catch (err) {
    console.error(err);
    closeIntro(true); $('#app').innerHTML = `<div class="center-msg"><h1>ЗБІЙ ЗВ'ЯЗКУ</h1><p>${esc(err.message)}</p></div>`;
  }
})();
