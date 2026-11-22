import { createStore } from './store.js?v=202611221158';
import {
  CHARACTERS, CHAR_BY_ID, ROOMS, ROOM_BY_ID, STAT_LABELS, SAVE_LABELS,
  PANIC_TABLE, WOUND_TABLE, EVENTS, GRETA_MODES, O2_START, initialChars,
  ROOM_LINKS, ROBOTS, ROBOT_BY_ID, XT2_HINTS
} from './data.js?v=202611221158';
import { CAMPAIGN, THREAT_STAGES, OBJECTIVES, OBJ_BY_ID, ROUND_EVENTS, GRETA_LINES, LONG_ACTIONS } from './campaign.js?v=202611221158';

const VERSION = '202611221158';
// ---------- утиліти ----------
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rnd = n => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };
const d100 = () => rnd(100);
const dN = n => rnd(n) + 1;
const pad2 = n => String(n).padStart(2, '0');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const IS_GM_PAGE = /[?&#]gm\b/.test(location.search + location.hash);
const MOBILE = !IS_GM_PAGE && (matchMedia('(max-width: 760px)').matches || (matchMedia('(pointer: coarse)').matches && innerWidth < 1000));
if (MOBILE) document.documentElement.classList.add('mobile');

let store;
const S = { goals: {}, chat: {}, requests: {}, seats: {}, chars: {}, state: null, log: {}, secret: null, secrets: {}, gm: {}, isAdmin: false };
const UI = {
  pick: null, sheetOpen: true, secretOpen: false, target: null, skill: null,
  adv: false, dis: false, lastRoll: null, panicPrompt: false, cutTs: null, dismissedCut: null,
  gretaTs: null, voice: false, lastTurn: undefined, view: IS_GM_PAGE ? 'map' : 'loc', imgIdx: 0, mainKey: null, openSec: new Set(), gmSel: null, resetArm: false, gmLast: null, tab: 'loc', logSeen: 0, badges: {}, rollOpen: false, tabId: Math.random().toString(36).slice(2, 10), advancing: false, chatOpen: null, chatSeen: {}
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
  if (myTurnActive() && !(await spendAP(1, 'Перевірка'))) return;
  const buff = (S.chars[id] || {}).buff;
  let advB = UI.adv, bonus = 0, used = false;
  if (buff === 'train' && UI.target[0] === 'stat' && ['str', 'spd', 'cmb'].includes(UI.target[1])) { advB = true; used = true; }
  if (buff === 'study' && t.sk) { bonus = 10; used = true; }
  if (used) await store.update(`game/chars/${id}`, { buff: null });
  t.total += bonus;
  const twice = advB !== UI.dis;
  const rolls = twice ? [d100(), d100()] : [d100()];
  const ranks = rolls.map(r => evalCheck(r, t.total));
  let i = 0;
  if (twice) i = advB ? (ranks[0] >= ranks[1] ? 0 : 1) : (ranks[0] <= ranks[1] ? 0 : 1);
  const rank = ranks[i];
  const st = S.chars[id];
  let extra = '';
  if (rank <= 1) {
    const ns = clamp((st.stress || 2) + 1, st.minStress || 2, 20);
    await store.update(`game/chars/${id}`, { stress: ns });
    extra = ` · +1 Стрес (${ns})`;
  }
  if (rank === 0) { UI.panicPrompt = true; extra += ' · КИДАЙ ПАНІКУ'; }
  const mod = (twice ? (advB ? ' [+]' : ' [−]') : '') + (bonus ? ' +10 навчання' : '');
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
      const locked = !IS_GM_PAGE && myCharId() && !canEnter(myCharId(), r.id);
      rooms += `<button class="room ${r.outside ? 'outside' : ''} ${locked ? 'locked' : ''}" style="left:${l}%;top:${t}%;width:${w}%;height:${h}%" data-act="${clickable ? 'room' : ''}" data-room="${r.id}" title="${esc(r.id + ' — ' + r.name)}"></button>`;
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
  const rb = ST().robots || {};
  const myLoc = !IS_GM_PAGE && myCharId() && S.chars[myCharId()] ? S.chars[myCharId()].loc : null;
  ROBOTS.forEach((ro, i) => {
    const pos = rb[ro.id]; if (!pos) return; const r = ROOM_BY_ID[pos.loc]; if (!r) return;
    if (!IS_GM_PAGE && pos.loc !== myLoc) return;
    tokens += `<div class="robot-token ${ro.type}" style="left:${r.anchor[0] + 1.6 + (i % 2) * 1.4}%;top:${r.anchor[1] - 2.2}%" title="${esc(ro.name)}">${ro.type === 'xt2' ? '2' : '3'}</div>`;
  });
  const outside = ROOM_BY_ID.OUT.rects[0];
  return `<div class="map"><img src="assets/ship.png" alt="Схема корабля STS-187">${rooms}
    <div class="outside-label" style="left:${outside[0]}%;top:${outside[1] + outside[3] + 0.5}%">ЗОВНІ</div>${tokens}</div>
    <div class="map-hint">${clickable ? (IS_GM_PAGE ? (UI.gmSel ? 'Обрано ' + CHAR_BY_ID[UI.gmSel].name + ': клік по кімнаті переміщує персонажа. Клікніть персонажа ще раз, щоб зняти вибір' : 'Клік по кімнаті — подивитися локацію. Щоб перемістити персонажа, спершу оберіть його (фішку або картку)') : (turnId() && turnId() !== myCharId() ? 'Зараз хід ' + CHAR_BY_ID[turnId()].name + ' — переходити можна у свій хід' : 'Клікніть кімнату, щоб перейти. Інших видно, лише коли ви в одній кімнаті')) : ''}</div>`;
}

// ---------- доступ ----------
function canEnter(cid, rid) {
  const r = ROOM_BY_ID[rid]; if (!r) return false;
  if (isLocked(rid)) return false;
  const st = S.chars[cid] || {};
  if (r.needFrom && st.loc !== r.needFrom && st.loc !== rid) return false;
  if (r.access === 'all') return true;
  return r.access.includes(cid) || !!(st.keys && st.keys[rid]);
}
function accessList(cid) {
  const st = S.chars[cid] || {};
  const own = ROOMS.filter(r => r.access !== 'all' && r.access.includes(cid)).map(r => r.id);
  const keys = Object.keys(st.keys || {});
  return { own, keys };
}
function gmNote(text, viol = false) {
  return store.push('game/gm/inbox', { uid: store.uid, charId: myCharId(), text, viol: viol ? 1 : 0, round: ST().round || 0 });
}

function lockModal(rid) {
  const r = ROOM_BY_ID[rid]; const id = myCharId(); const c = CHAR_BY_ID[id];
  const tech = bestSkill(c, ['Комп\'ютери', 'Ремонт механізмів', 'Інженерія']);
  const force = bestSkill(c, ['Атлетика', 'Рукопашний бій']);
  const needWay = r.needFrom && S.chars[id].loc !== r.needFrom;
  $('#modal').innerHTML = `<div class="modal-bg" data-act="closeModal"></div><div class="modal">
    <small>${isLocked(rid) ? 'ЛОКДАУН ҐРЕТИ' : 'ДОСТУП ЗАБОРОНЕНО'}</small><h2>${esc(r.id)} · ${esc(r.name)}</h2>
    ${isLocked(rid) ? '<p>Ґрета заблокувала цю кімнату для всього екіпажу. Ключі не допоможуть. Злом — з перешкодою.</p>' : ''}
    ${needWay ? `<p>Туди можна потрапити лише через ${esc(ROOM_BY_ID[r.needFrom].id + ' · ' + ROOM_BY_ID[r.needFrom].name)}.</p>` : `
    <p class="muted">${r.hard ? 'Посилений замок: злом з перешкодою.' : 'Звичайний електронний замок.'} ${r.id === 'B1' ? '' : 'Камера Ґрети бачить двері.'}</p>
    <button class="ghost opt" data-act="hack" data-room="${rid}" data-mode="tech"><b>ЗЛАМАТИ ЗАМОК</b><span>Інтелект ${c.stats.int}${tech ? ' + ' + esc(tech[0]) + ' ' + tech[1] : ''} = ${c.stats.int + (tech ? tech[1] : 0)}${r.hard ? ' [−]' : ''}</span></button>
    <button class="ghost opt" data-act="hack" data-room="${rid}" data-mode="force"><b>ВИБИТИ ДВЕРІ</b><span>Сила ${c.stats.str}${force ? ' + ' + esc(force[0]) + ' ' + force[1] : ''} = ${c.stats.str + (force ? force[1] : 0)} [−] · гучно, Ґрета точно дізнається</span></button>
    <button class="ghost opt" data-act="askGreta" data-room="${rid}"><b>ПОПРОСИТИ ҐРЕТУ</b><span>Запит піде ведучому. Ґрета вирішить сама.</span></button>
    <p class="muted small-note">Ключ-карту можна отримати в грі — вкрасти, виміняти, отримати від капітана. Ведучий додасть її вам.</p>`}
    <button class="ghost small" data-act="closeModal">СКАСУВАТИ</button></div>`;
}
function updateSecretBtn() {
  const b = $('#secretBtn'); if (!b) return;
  b.classList.toggle('has', !!S.secret);
  b.classList.toggle('new', !!(S.secret && UI.secretNew));
}
function secretModal() {
  UI.secretNew = false; updateSecretBtn();
  $('#modal').innerHTML = `<div class="modal-bg" data-act="closeModal"></div><div class="modal secret-modal">
    <small>ТІЛЬКИ ДЛЯ ВАС</small><h2>ТАЄМНА ЦІЛЬ</h2>
    <div class="secret">${S.secret ? esc(S.secret) : '<span class="muted">Ведучий ще не надіслав вам таємну ціль.</span>'}</div>
    <button class="ghost small" data-act="closeModal">ЗАКРИТИ</button></div>`;
}
function bestSkill(c, names) {
  return c.skills.filter(([n]) => names.includes(n)).sort((a, b) => b[1] - a[1])[0] || null;
}

// ---------- КАМПАНІЯ: кола, дії, загроза ----------
const ST = () => S.state || {};
const inPlay = () => ST().phase === 'play';
function apLeft(cid) { const st = S.chars[cid] || {}; return st.ap ?? CAMPAIGN.apPerTurn; }
function myTurnActive() { return inPlay() && turnId() && turnId() === myCharId(); }
// Повертає true, якщо дію можна виконати (і списує дії). Поза кампанією — без обмежень.
async function spendAP(n, what) {
  if (IS_GM_PAGE || !inPlay() || !turnId()) return true;
  const id = myCharId();
  if (turnId() !== id) { toast(`Зараз не ваш хід. ${what || 'Ця дія'} — лише у свій хід.`); return false; }
  const left = apLeft(id);
  if (left < n) { toast('Дії на цей хід закінчились. Натисніть «ЗАВЕРШИТИ ХІД».'); return false; }
  await store.update(`game/chars/${id}`, { ap: left - n });
  return true;
}
function stageLocked(rid) {
  if (!ST().phase || ST().phase === 'setup') return false;
  const t = ST().threat || 0;
  for (let lvl = 1; lvl <= t; lvl++) { const sg = THREAT_STAGES[lvl]; if (sg && sg.locks && sg.locks.includes(rid)) return true; }
  return false;
}
function isLocked(rid) {
  const st = ST();
  return stageLocked(rid) || !!((st.locks && st.locks[rid]) || (st.tempLocks && st.tempLocks[rid]));
}
function threatLevel() { return ST().threat || 0; }
function threatHTML() {
  if (!ST().phase || ST().phase === 'setup') return '';
  const t = threatLevel(); const max = CAMPAIGN.threatMax;
  let bar = '';
  for (let i = 1; i <= max; i++) bar += `<i class="${i <= t ? 'on' : ''}"></i>`;
  return `<div class="threat ${t >= 7 ? 'crit' : ''}" title="Контроль Ґрети"><span class="lbl">КОНТРОЛЬ ҐРЕТИ</span><span class="bar">${bar}</span><b>${t}/${max}</b></div>
    <div class="roundno"><span class="lbl">КОЛО</span><b>${ST().round || 1}</b></div>`;
}
function timerLeft() {
  const st = ST();
  if (!inPlay() || !st.turnStart || !turnId()) return null;
  const now = st.paused ? (st.pausedAt || Date.now()) : Date.now();
  return Math.max(0, Math.ceil((st.turnSec || CAMPAIGN.turnSec) - (now - st.turnStart) / 1000));
}
function fmtSec(t) { return `${Math.floor(t / 60)}:${pad2(t % 60)}`; }
function availableObjective(rid) {
  const o = OBJECTIVES.find(x => x.room === rid);
  if (!o) return null;
  const g = S.goals || {};
  if ((g[o.id] || 0) >= o.need) return { o, done: true };
  if (o.final && !OBJECTIVES.filter(x => !x.final).every(x => (g[x.id] || 0) >= x.need)) return { o, locked: true };
  return { o };
}
function objectiveHTML(rid) {
  if (IS_GM_PAGE || !ST().phase || ST().phase === 'setup') return '';
  const a = availableObjective(rid); if (!a) return '';
  const g = (S.goals || {})[a.o.id] || 0;
  if (a.done) return `<div class="objective done"><small>ЦІЛЬ ЕКІПАЖУ · ВИКОНАНО</small><b>${esc(a.o.title)}</b></div>`;
  if (a.locked) return `<div class="objective"><small>ЦІЛЬ ЕКІПАЖУ</small><b>${esc(a.o.title)}</b><span>Спершу виконайте три інші цілі.</span></div>`;
  return `<div class="objective"><small>ЦІЛЬ ЕКІПАЖУ · ${g}/${a.o.need}</small><b>${esc(a.o.title)}</b><span>${esc(a.o.desc)}</span>
    <button class="primary small" data-act="objective" data-o="${a.o.id}">СПРОБУВАТИ · 1 ДІЯ</button></div>`;
}
function endScreen() {
  const ph = ST().phase; const el = $('#endScreen');
  if (!el) return;
  if (ph !== 'won' && ph !== 'lost') { el.innerHTML = ''; return; }
  const won = ph === 'won';
  el.innerHTML = `<div class="endscreen ${won ? 'won' : 'lost'}"><small>${won ? 'ЕКІПАЖ ПЕРЕМІГ' : 'ҐРЕТА ПЕРЕМОГЛА'}</small>
    <h1>${won ? 'РУЧНЕ КЕРУВАННЯ' : 'ПОВНИЙ КОНТРОЛЬ'}</h1>
    <p>${esc(ST().endText || (won ? 'Ядро Ґрети вимкнено. STS-187 знову ваш. Надовго?' : THREAT_STAGES[10].text))}</p>
    <div class="ring mode-${won ? 'evade' : 'control'}"><span></span></div>
    ${IS_GM_PAGE ? '<button class="ghost" data-act="hideEnd">СХОВАТИ</button>' : ''}</div>`;
}

function turnId() { return (S.state && S.state.turn && S.seats[S.state.turn]) ? S.state.turn : null; }

function currentRoom() {
  if (IS_GM_PAGE) {
    if (UI.gmSel && S.chars[UI.gmSel]) return S.chars[UI.gmSel].loc;
    if (UI.gmView) return UI.gmView;
    const f = turnId();
    return f && S.chars[f] ? S.chars[f].loc : 'A1';
  }
  const t = turnId();
  if (t && S.chars[t]) return S.chars[t].loc;
  const id = myCharId();
  return id && S.chars[id] ? S.chars[id].loc : 'A1';
}

// ---------- роботи ----------
function robotsIn(rid) {
  const rb = ST().robots || {};
  return ROBOTS.filter(r => rb[r.id] && rb[r.id].loc === rid);
}
function xt3In(rid) { return robotsIn(rid).some(r => r.type === 'xt3'); }
function robotActive(r) { return !r.minThreat || threatLevel() >= r.minThreat; }

// Ходять роботи на кожен новий хід (рахує пульт ведучого).
async function moveRobots() {
  const st = ST(); const rb = JSON.parse(JSON.stringify(st.robots || {}));
  const seen = [];
  for (const r of ROBOTS) {
    if (!robotActive(r)) { delete rb[r.id]; continue; }
    const cur = rb[r.id] && rb[r.id].loc;
    let next = cur;
    if (r.type === 'xt3') {
      if (!cur) next = r.start;
      else if (rnd(100) < 60) {
        const opts = (ROOM_LINKS[cur] || ['C1']).filter(x => x !== 'OUT' && !(x === 'B1' && threatLevel() < 2));
        next = opts[rnd(opts.length)];
      }
    } else {                                   // ХТ2: з'являється й зникає
      if (!cur) { if (rnd(100) < 25) next = rnd(100) < 40 ? 'N1' : ROOMS.filter(x => x.id !== 'OUT')[rnd(ROOMS.length - 1)].id; }
      else if (rnd(100) < 35) next = null;
      else if (rnd(100) < 50) { const opts = (ROOM_LINKS[cur] || ['C1']).filter(x => x !== 'OUT'); next = opts[rnd(opts.length)]; }
    }
    if (next) rb[r.id] = { loc: next }; else delete rb[r.id];
    if (next && next !== cur && r.type === 'xt3') {
      const who = seatedOrder().filter(cid => (S.chars[cid] || {}).loc === next).map(cid => CHAR_BY_ID[cid].name);
      if (who.length) seen.push(`${r.name} бачить ${who.join(', ')} у ${next}`);
    }
  }
  await store.update('game/state', { robots: rb });
  for (const t of seen) await store.push('game/gm/inbox', { uid: store.uid, charId: null, text: `Дрон: ${t}.`, viol: 0, round: st.round || 0 });
}

// Композиція «як у кадрі»: ближній план (по пояс, збоку), середній, дальній (дрібніше й темніше).
const FIG_SLOTS = {
  near: { h: 128, b: -58, xs: [20, 78], bright: .92, blur: 0, z: 3 },
  mid:  { h: 74,  b: -8,  xs: [62, 38], bright: .78, blur: 0, z: 2 },
  far:  { h: 40,  b: 20,  xs: [50, 58, 36, 66], bright: .6, blur: .5, z: 1 }
};
const SLOT_ORDER = { 1: ['mid'], 2: ['near', 'far'], 3: ['near', 'mid', 'far'], 4: ['near', 'mid', 'far', 'far'], 5: ['near', 'mid', 'far', 'far', 'far'] };
function strHash(str) { let h = 2166136261; for (const ch of str) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

function figuresHTML(list, rid) {
  let figs = list.filter(c => c.figure);
  if (!figs.length) return '';
  // стабільний порядок для кімнати; персонаж, чий хід, — на передньому плані
  figs = figs.slice().sort((a, b) => strHash(rid + a.id) - strHash(rid + b.id));
  const t = turnId(); const ti = figs.findIndex(c => c.id === t);
  if (ti > 0) figs.unshift(figs.splice(ti, 1)[0]);
  const slots = SLOT_ORDER[Math.min(figs.length, 5)];
  const flip = strHash(rid) % 2 === 1;               // дзеркалимо композицію для різних кімнат
  const used = {};
  return `<div class="figures">${figs.slice(0, 5).map((c, i) => {
    const key = slots[i]; const sl = FIG_SLOTS[key];
    const k = used[key] = (used[key] || 0) + 1;
    let x = sl.xs[(k - 1) % sl.xs.length] + ((strHash(rid + c.id) % 7) - 3);
    if (flip) x = 100 - x;
    const active = c.id === t;
    const sc = c.scale || 1;
    const style = `left:${x}%;height:${sl.h * sc}%;bottom:${sl.b + (sc < 1 ? (key === 'near' ? 30 : 0) : 0)}%;z-index:${sl.z};--br:${active ? sl.bright + .06 : sl.bright};--bl:${sl.blur}px;--d:${i * 0.12}s`;
    return `<img class="figure fig-${key} ${active ? 'active' : ''}" src="assets/figures/${c.figure}" alt="${esc(c.name)}" title="${esc(c.name)}" style="${style}">`;
  }).join('')}</div>`;
}

// ---------- сховані предмети (бачить лише ведучий) ----------
function itemPos(it) { const p = ((S.gm && S.gm.itemPos) || {})[it.id]; return p ? p : { x: it.x, y: it.y }; }
function itemFound(it) { return !!(((S.gm && S.gm.itemsFound) || {})[it.id]); }
function itemMarkersHTML(rid) {
  const list = (S.items || []).filter(it => it.room === rid);
  if (!list.length) return '';
  return `<div class="item-marks">${list.map(it => { const p = itemPos(it); const f = itemFound(it);
    return `<div class="item-mark ${f ? 'found' : ''}" data-item="${it.id}" style="left:${p.x}%;top:${p.y}%">
      <span>${f ? '✓' : '◆'}</span>
      <div class="item-tip"><img src="assets/items/${it.id}.webp" alt=""><b>${esc(it.id)} · ${esc(it.name)}</b><em>${esc(it.spot)}</em>
        <p>${esc(it.effect)}</p><small>Підказка: ${esc(it.clue)}</small>${f ? '<i>ЗНАЙДЕНО</i>' : ''}<u>клік — показати гравцям · тягни — перемістити</u></div></div>`; }).join('')}</div>`;
}
function itemModal(id) {
  const it = (S.items || []).find(x => x.id === id); if (!it) return;
  const inRoom = seatedOrder().filter(cid => (S.chars[cid] || {}).loc === it.room);
  const f = itemFound(it);
  $('#modal').innerHTML = `<div class="modal-bg" data-act="closeModal"></div><div class="modal item-modal">
    <small>${esc(it.id)} · ${esc(it.room)} · ${esc((ROOM_BY_ID[it.room] || {}).name || '')}</small>
    <div class="item-row"><img src="assets/items/${it.id}.webp" alt=""><div><h2>${esc(it.name)}</h2><p class="muted">Схованка: ${esc(it.spot)}</p></div></div>
    <p>${esc(it.effect)}</p><p class="muted">Підказка: ${esc(it.clue)}</p>
    <button class="primary" data-act="itemReveal" data-id="${it.id}" data-to="room" ${inRoom.length ? '' : 'disabled'}>ПОКАЗАТИ ТИМ, ХТО В КІМНАТІ${inRoom.length ? ': ' + inRoom.map(c => CHAR_BY_ID[c].name).join(', ') : ' (нікого)'}</button>
    <button class="ghost" data-act="itemReveal" data-id="${it.id}" data-to="all">ПОКАЗАТИ ВСІМ</button>
    <button class="ghost small" data-act="itemFoundToggle" data-id="${it.id}">${f ? 'ПОВЕРНУТИ В СХОВАНКУ' : 'ЛИШЕ ПОЗНАЧИТИ ЗНАЙДЕНИМ'}</button>
    <button class="ghost small" data-act="closeModal">ЗАКРИТИ</button></div>`;
}
// перетягування міток
let itemDrag = null;
document.addEventListener('pointerdown', e => {
  const m = IS_GM_PAGE && e.target.closest && e.target.closest('.item-mark'); if (!m) return;
  const box = m.closest('.loc').getBoundingClientRect();
  itemDrag = { m, id: m.dataset.item, box, x0: e.clientX, y0: e.clientY, moved: false };
  m.setPointerCapture(e.pointerId); e.preventDefault();
});
document.addEventListener('pointermove', e => {
  if (!itemDrag) return;
  if (Math.abs(e.clientX - itemDrag.x0) + Math.abs(e.clientY - itemDrag.y0) > 5) itemDrag.moved = true;
  if (!itemDrag.moved) return;
  const b = itemDrag.box;
  itemDrag.x = clamp((e.clientX - b.left) / b.width * 100, 1, 99); itemDrag.y = clamp((e.clientY - b.top) / b.height * 100, 1, 99);
  itemDrag.m.style.left = itemDrag.x + '%'; itemDrag.m.style.top = itemDrag.y + '%'; itemDrag.m.classList.add('dragging');
});
document.addEventListener('pointerup', async () => {
  if (!itemDrag) return; const d = itemDrag; itemDrag = null;
  if (d.moved) await store.update('game/gm/itemPos', { [d.id]: { x: Math.round(d.x * 10) / 10, y: Math.round(d.y * 10) / 10 } });
  else itemModal(d.id);
});
function revealBox() {
  const rv = ST().reveal; const el = $('#revealBox'); if (!el || !rv || IS_GM_PAGE) return;
  if (rv.ts === UI.revealTs) return;
  const first = UI.revealTs === undefined; UI.revealTs = rv.ts;
  if (first && Date.now() - rv.ts > 15000) return;
  const me = myCharId();
  if (rv.to !== 'all' && !(rv.to || []).includes(me)) return;
  el.innerHTML = `<div class="reveal" data-act="revealClose"><small>ЗНАЙДЕНО</small><img src="assets/items/${esc(rv.id)}.webp" alt=""><h2>${esc(rv.name)}</h2><p>${esc(rv.effect)}</p></div>`;
  if (navigator.vibrate) navigator.vibrate(80);
  clearTimeout(UI.revealT); UI.revealT = setTimeout(() => { el.innerHTML = ''; }, 9000);
}

function locHTML(rid) {
  const r = ROOM_BY_ID[rid] || ROOM_BY_ID.A1;
  const here = CHARACTERS.filter(c => S.chars[c.id] && S.chars[c.id].loc === r.id && (S.seats[c.id] || IS_GM_PAGE));
  let img = r.imgs.length ? r.imgs[UI.imgIdx % r.imgs.length] : null;
  if (img && MOBILE) img = img.replace('assets/rooms/', 'assets/rooms/m/');
  return `<div class="loc">
    ${img ? `<img src="${img}" alt="${esc(r.name)}">` : `<div class="noimg">${r.outside ? 'ЗОВНІ. ВАКУУМ.' : 'НЕМАЄ ЗОБРАЖЕННЯ З КАМЕРИ'}</div>`}
    <div class="loc-label"><small>${turnId() ? 'ХІД · ' + esc(CHAR_BY_ID[turnId()].name) : 'ЛОКАЦІЯ'}</small><b>${esc(r.id)} · ${esc(r.name)}</b></div>
    ${r.imgs.length > 1 ? `<button class="loc-next ghost" data-act="nextImg" title="Інший ракурс">${UI.imgIdx % r.imgs.length + 1}/${r.imgs.length} ▸</button>` : ''}
    ${figuresHTML([...here, ...robotsIn(r.id)], r.id)}
    ${IS_GM_PAGE ? itemMarkersHTML(r.id) : ''}
    ${!IS_GM_PAGE && robotsIn(r.id).some(x => x.type === 'xt2') && myCharId() && S.chars[myCharId()] && S.chars[myCharId()].loc === r.id ? '<button class="ghost small xt2-btn" data-act="askXT2">ПОПРОСИТИ ХТ2 · 1 ДІЯ</button>' : ''}
    ${objectiveHTML(r.id)}
    <div class="loc-here">${here.map(c => `<span class="chipc" style="--c:${c.color}">${esc(c.name)}${S.seats[c.id] ? ' · ' + esc(S.seats[c.id].name) : ''}</span>`).join('')}${robotsIn(r.id).map(x => `<span class="chipc robot ${x.type}">${esc(x.name)}</span>`).join('')}</div>
    ${IS_GM_PAGE ? `<select class="loc-pick" data-gmview="1" title="Дивитися іншу локацію">${ROOMS.map(x => `<option value="${x.id}" ${x.id === r.id ? 'selected' : ''}>${x.id} · ${esc(x.name)}</option>`).join('')}</select>` : ''}
    <button class="loc-map primary" data-act="view" data-v="map">МАПА КОРАБЛЯ</button>
  </div>`;
}

function renderMain(force) {
  const el = $('#map'); if (!el) return;
  const rid = currentRoom();
  let key = UI.view === 'map'
    ? 'map|' + JSON.stringify(S.chars) + JSON.stringify(Object.keys(S.seats || {})) + UI.gmSel + JSON.stringify(ST().robots || {})
    : `loc|${rid}|${UI.imgIdx}|${turnId()}|${JSON.stringify(S.goals || {})}|${ST().phase}|${JSON.stringify(ST().robots || {})}|` + CHARACTERS.map(c => (S.chars[c.id] || {}).loc + (S.seats[c.id] ? S.seats[c.id].name : '')).join(',');
  if (IS_GM_PAGE) key += JSON.stringify((S.gm && S.gm.itemPos) || {}) + JSON.stringify((S.gm && S.gm.itemsFound) || {}) + (S.items ? S.items.length : 0);
  if (!force && key === UI.mainKey) return;
  UI.mainKey = key;
  const tabs = `<div class="viewtabs"><button class="tog ${UI.view === 'loc' ? 'on' : ''}" data-act="view" data-v="loc">ЛОКАЦІЯ</button><button class="tog ${UI.view === 'map' ? 'on' : ''}" data-act="view" data-v="map">МАПА</button></div>`;
  el.innerHTML = tabs + (UI.view === 'map' ? mapHTML(true) : locHTML(rid));
  if (MOBILE && UI.view === 'map') requestAnimationFrame(() => { el.scrollLeft = el.scrollWidth * 0.52 - el.clientWidth / 2; });
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
    el.innerHTML = `<div class="greta-msg">${ringHTML(S.state.mode)}<div class="gm-text"><small>ҐРЕТА</small>${esc(g.text)}</div><button class="greta-x" data-act="closeGreta" aria-label="Закрити">✕</button></div>`;
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
      <header class="topbar"><div class="brand">STS-187</div><div id="o2"></div><div id="threat" class="threatwrap"></div><div class="spacer"></div><div id="turn"></div><div id="timer" class="timer"></div>
        <button class="ghost small greta-btn" data-act="chatOpen" id="chatBtn">НАПИСАТИ ҐРЕТІ</button>
        <button class="ghost small secret-btn" data-act="secretModal" id="secretBtn">ТАЄМНА ЦІЛЬ</button>
        <button class="ghost small" data-act="voice" id="voiceBtn"></button><div id="who" class="who"></div><div id="ring"></div></header>
      <div id="greta"></div>
      <main class="layout"><section class="mapcol" id="map" data-pane="loc"></section>
        <aside class="sheet" id="sheet" data-pane="sheet"></aside><aside class="logcol" data-pane="log"><h4>ЖУРНАЛ</h4><div id="log" class="log"></div></aside>
        <section class="chatpane" id="chatPane" data-pane="greta"></section></main>
      <footer class="tray" id="tray" data-pane="dice"></footer>
      <nav class="tabbar" id="tabbar"></nav><div id="turnFlash"></div><div id="revealBox"></div>
      <div id="cut"></div><div id="modal"></div><div id="endScreen"></div></div>`;
  }
  const c = CHAR_BY_ID[id];
  $('#threat').innerHTML = threatHTML();
  endScreen(); tickTimer();
  $('#o2').innerHTML = o2HTML();
  $('#ring').innerHTML = ringHTML(S.state.mode);
  $('#who').innerHTML = `<span style="color:${c.color}">${esc(c.name)}</span> · ${esc(S.seats[id].name)}`;
  $('#voiceBtn').textContent = UI.voice ? 'ГОЛОС: ON' : 'ГОЛОС: OFF';
  updateSecretBtn();
  renderTurn();
  renderMain();
  $('#log').innerHTML = logHTML(S.log);
  renderSheet(); renderTray(); gretaBanner(); renderCutscene(); revealBox();
  if (MOBILE) { renderTabbar(); if (UI.tab === 'greta') renderChatPane(); }
}

// ---------- мобільний режим: вкладки ----------
const TABS = [['loc', 'ЛОКАЦІЯ', '◉'], ['sheet', 'ЛИСТ', '▤'], ['dice', 'КУБИКИ', '⬢'], ['log', 'ЖУРНАЛ', '≡'], ['greta', 'ҐРЕТА', '◯']];
function setTab(t) {
  UI.tab = t; document.documentElement.dataset.tab = t;
  if (t === 'log') UI.logSeen = Object.keys(S.log || {}).length;
  if (t === 'greta') { UI.badges.greta = 0; UI.chatOpen = myCharId(); renderChatPane(); } else if (UI.chatOpen && MOBILE) UI.chatOpen = null;
  if (t === 'sheet') UI.badges.sheet = 0;
  renderTabbar();
  const pane = document.querySelector(`[data-pane="${t}"]`); if (pane) pane.scrollTop = pane.scrollTop;
}
function renderTabbar() {
  const el = $('#tabbar'); if (!el) return;
  const logNew = Math.max(0, Object.keys(S.log || {}).length - UI.logSeen);
  const badge = { log: UI.tab === 'log' ? 0 : logNew, greta: UI.badges.greta || 0, sheet: (S.secret && UI.secretNew) ? 1 : 0, dice: myTurnActive() ? '!' : 0 };
  document.documentElement.dataset.tab = UI.tab;
  el.innerHTML = TABS.map(([k, l, ic]) => `<button class="${UI.tab === k ? 'on' : ''}" data-act="tab" data-t="${k}"><i>${ic}</i><span>${l}</span>${badge[k] ? `<b>${badge[k] === '!' ? '!' : Math.min(badge[k], 99)}</b>` : ''}</button>`).join('');
}
function renderChatPane() {
  const el = $('#chatPane'); const id = myCharId(); if (!el || !id) return;
  const keep = $('#chatText') ? $('#chatText').value : '';
  el.innerHTML = `<div class="chat-head">${ringHTML(ST().mode)}<div><small>КАНАЛ ЗВ'ЯЗКУ · ПРИВАТНО</small><b>ҐРЕТА</b></div></div>
    <div class="msgs" id="msgs">${chatHTML(id)}</div>
    <div class="chat-input"><input id="chatText" maxlength="400" placeholder="Напишіть Ґреті…" value="${esc(keep)}"><button class="primary" data-act="chatSend">▶</button></div>`;
  const m = $('#msgs'); if (m) m.scrollTop = m.scrollHeight;
}
function rollSheetHTML() {
  const id = myCharId(); const c = CHAR_BY_ID[id]; const t = targetInfo(id); if (!t) return '';
  const lr = UI.lastRoll;
  const rankCls = lr ? (lr.rank >= 2 ? 'ok' : lr.rank === -1 ? '' : 'fail') : '';
  return `<div class="modal-bg" data-act="rollClose"></div><div class="bottom-sheet">
    <div class="grab"></div>
    <small>ПЕРЕВІРКА</small><h2>${esc(t.label)} <span class="tgt">${t.total}</span></h2>
    <div class="chips">${c.skills.map(([n, b], i) => `<button class="chip ${UI.skill === i ? 'sel' : ''}" data-act="skill" data-i="${i}">${esc(n)} <b>+${b}</b></button>`).join('')}</div>
    <div class="mods"><button class="tog ${UI.adv ? 'on' : ''}" data-act="adv">ПЕРЕВАГА +</button><button class="tog ${UI.dis ? 'on' : ''}" data-act="dis">ПЕРЕШКОДА −</button></div>
    <button class="primary big wide" data-act="check">КИНУТИ d100 · треба менше ${t.total}${myTurnActive() ? ' · 1 ДІЯ' : ''}</button>
    <div class="result ${rankCls}">${lr ? `<b>${esc(lr.big)}</b><div><span>${esc(lr.label)}</span><small>${esc(lr.sub)}</small></div>` : ''}</div>
    ${UI.panicPrompt ? '<button class="danger wide pulse" data-act="panic">КРИТИЧНИЙ ПРОВАЛ — ПЕРЕВІРКА ПАНІКИ d20</button>' : ''}
    <button class="ghost wide" data-act="rollClose">ГОТОВО</button></div>`;
}
function renderRollSheet() {
  if (!MOBILE || !UI.rollOpen) return;
  $('#modal').innerHTML = rollSheetHTML();
}
let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && MOBILE && !IS_GM_PAGE) keepAwake(); });
function flashMyTurn() {
  if (navigator.vibrate) navigator.vibrate([180, 90, 180]);
  const el = $('#turnFlash'); if (!el) return;
  el.innerHTML = `<div class="turnflash" data-act="flashClose"><small>КОЛО ${ST().round || 1}</small><b>ВАШ ХІД</b><span>3 дії · ${fmtSec(ST().turnSec || CAMPAIGN.turnSec)}</span></div>`;
  clearTimeout(UI.flashT); UI.flashT = setTimeout(() => { el.innerHTML = ''; }, 2600);
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
    const first = UI.lastTurn === undefined;
    UI.lastTurn = t; UI.imgIdx = 0;
    if (t && !IS_GM_PAGE) UI.view = 'loc';
    if (!IS_GM_PAGE && t && t === myCharId() && inPlay() && !first) { flashMyTurn(); if (MOBILE && UI.tab !== 'dice') setTab('loc'); }
  }
  el.innerHTML = turnBadge();
}

function renderJoin() {
  const sel = UI.pick;
  const cards = CHARACTERS.map(c => {
    const taken = !!S.seats[c.id];
    return `<button class="crew-card ${taken ? 'taken' : ''} ${sel === c.id ? 'sel' : ''}" data-act="${taken ? '' : 'pick'}" data-id="${c.id}">
      ${portraitHTML(c)}<div class="cc-name">${esc(c.name)}</div><div class="cc-role">${esc(c.role)}</div>
      <div class="tag">${taken ? 'ЗАЙНЯТО · ' + esc(S.seats[c.id].name) : 'ВІЛЬНО'}</div>
      ${taken ? `<span class="rejoin" data-act="rejoin" data-id="${c.id}">ЦЕ Я — ПОВЕРНУТИСЯ</span>` : ''}</button>`;
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
    <h4>ДОСТУП</h4><p class="trait">${(() => { const a = accessList(id); return `Загальні зони${a.own.length ? ', ' + a.own.join(', ') : ''}${a.keys.length ? `<br><span class="keys">Ключі: ${a.keys.map(esc).join(', ')}</span>` : ''}`; })()}</p>
    <h4>ТАЄМНА ЦІЛЬ ${S.secret ? `<button class="ghost small" data-act="secret">${UI.secretOpen ? 'СХОВАТИ' : 'ПОКАЗАТИ'}</button>` : ''}</h4>${secret}
    <button class="ghost small leave" data-act="leave">Звільнити персонажа</button>`;
}

function renderTray() {
  renderRollSheet(); if (MOBILE) renderTabbar();
  const id = myCharId(); const el = $('#tray'); if (!id || !el) return;
  const t = targetInfo(id);
  const lr = UI.lastRoll;
  const rankCls = lr ? (lr.rank === 3 || lr.rank === 2 ? 'ok' : lr.rank === -1 ? '' : 'fail') : '';
  const apRow = myTurnActive() ? (() => {
    const left = apLeft(id); let pips = '';
    for (let i = 0; i < CAMPAIGN.apPerTurn; i++) pips += `<i class="${i < left ? 'on' : ''}"></i>`;
    const buff = (S.chars[id] || {}).buff;
    return `<div class="aprow"><span class="lbl">ДІЇ</span><span class="pips">${pips}</span>
      ${left === CAMPAIGN.apPerTurn ? LONG_ACTIONS.map(a => `<button class="ghost small" data-act="longAction" data-a="${a.id}" title="${esc(a.desc)}">${a.title}</button>`).join('') : ''}
      ${buff ? `<span class="buff">${buff === 'train' ? 'ПЕРЕВАГА НА ФІЗИЧНУ ПЕРЕВІРКУ' : '+10 ДО НАСТУПНОЇ НАВИЧКИ'}</span>` : ''}
      <button class="primary small endturn" data-act="endTurn">ЗАВЕРШИТИ ХІД</button></div>`;
  })() : '';
  el.innerHTML = apRow + `
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
      S._secretOff = store.on(`game/secrets/${id}`, s => {
        const txt = s && s.text;
        if (txt && txt !== S.secret) { UI.secretNew = true; if (S._secretLoaded) toast('Ведучий надіслав вам таємну ціль. Кнопка «ТАЄМНА ЦІЛЬ» угорі.', true); }
        S._secretLoaded = true;
        S.secret = txt; renderSheet(); updateSecretBtn(); if (MOBILE) renderTabbar();
      });
      if (S._reqOff) S._reqOff();
      S._reqOff = store.on(`game/requests/${id}`, rq => {
        if (!rq || rq.status === 'pending') return;
        const r = ROOM_BY_ID[rq.room];
        toast(rq.status === 'granted' ? `Ґрета: доступ до ${r ? r.name : rq.room} надано.` : `Ґрета: у доступі відмовлено.`, rq.status === 'granted');
        if (rq.status === 'granted') { UI.view = 'loc'; UI.imgIdx = 0; }
        store.remove(`game/requests/${id}`);
      });
    }
    if (!$('#playerRoot') || !id) $('#app').innerHTML = '';
    watchMyChat();
    renderPlayer();
  }));
  subs.push(store.on('game/chars', v => { S.chars = v || {}; if ($('#playerRoot')) { renderMain(); renderSheet(); } }));
  subs.push(store.on('game/log', v => {
    S.log = v || {}; if ($('#log')) $('#log').innerHTML = logHTML(S.log);
    if (!UI.logInit) { UI.logInit = true; UI.logSeen = Object.keys(S.log).length; }
    if (UI.tab === 'log') UI.logSeen = Object.keys(S.log).length;
    if (MOBILE) renderTabbar();
  }, 80));
  subs.push(store.on('game/goals', v => { S.goals = v || {}; if ($('#playerRoot')) renderMain(); }));
  setInterval(tickTimer, 1000);
}
let chatOff = null;
function watchMyChat() {
  const id = myCharId(); if (!id || S._chatFor === id) return;
  S._chatFor = id; if (chatOff) chatOff();
  chatOff = store.on(`game/chat/${id}`, v => {
    const prev = Object.keys(S.chat[id] || {}).length;
    S.chat[id] = v || {};
    const list = Object.values(S.chat[id]);
    if (S._chatLoaded && list.length > prev && list[list.length - 1].from === 'g') {
      if (UI.chatOpen !== id) { toast('Ґрета відповіла вам.', true); $('#chatBtn') && $('#chatBtn').classList.add('new'); UI.badges.greta = (UI.badges.greta || 0) + 1; if (navigator.vibrate) navigator.vibrate(60); renderTabbar(); }
    }
    S._chatLoaded = true;
    if (UI.chatOpen === id) { if (MOBILE) renderChatPane(); else chatModal(id); }
  });
}
function chatHTML(cid) {
  const list = Object.entries(S.chat[cid] || {}).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const last = list.length ? list[list.length - 1][1] : null;
  if (last && last.from === 'g') UI.waitGreta = 0;
  const typing = !IS_GM_PAGE && last && last.from === 'p' ? '<div class="msg g typing"><small>ҐРЕТА</small><span>●</span><span>●</span><span>●</span></div>' : '';
  return (list.map(([, m]) => `<div class="msg ${m.from === 'g' ? 'g' : 'p'}">${m.from === 'g' ? '<small>ҐРЕТА</small>' : ''}${esc(m.text)}</div>`).join('') + typing) || '<div class="muted">Ґрета слухає.</div>';
}
function chatModal(cid) {
  const keep = $('#chatText') ? $('#chatText').value : '';
  $('#modal').innerHTML = `<div class="modal-bg" data-act="chatClose"></div><div class="modal chat-modal">
    <small>КАНАЛ ЗВ'ЯЗКУ · ПРИВАТНО</small><h2>${ringHTML(ST().mode)} ҐРЕТА</h2>
    <div class="msgs" id="msgs">${chatHTML(cid)}</div>
    <div class="row"><input id="chatText" maxlength="400" placeholder="Напишіть Ґреті…" value="${esc(keep)}"><button class="primary small" data-act="chatSend">НАДІСЛАТИ</button></div>
    <button class="ghost small" data-act="chatClose">ЗАКРИТИ</button></div>`;
  const m = $('#msgs'); if (m) m.scrollTop = m.scrollHeight;
  const i = $('#chatText'); if (i) i.focus();
}
function tickTimer() {
  const el = $('#timer'); if (!el) return;
  const t = timerLeft();
  if (t === null) { el.innerHTML = ''; return; }
  el.innerHTML = `<span class="lbl">${ST().paused ? 'ПАУЗА' : 'ЧАС ХОДУ'}</span><b class="${t <= 30 ? 'hot' : ''}">${fmtSec(t)}</b>`;
}

// ---------- ВЕДУЧИЙ ----------
function renderGM() {
  if (!$('#gmRoot')) {
    $('#app').innerHTML = `<div id="gmRoot" class="screen gm">
      <header class="topbar"><div class="brand">WARDEN</div><div id="o2"></div>
        <div class="o2ctl"><button class="ghost small" data-act="o2" data-d="-30">−30</button><button class="ghost small" data-act="o2" data-d="30">+30</button><button class="ghost small" data-act="o2set">6:00</button></div>
        <div id="threat" class="threatwrap"></div><div class="spacer"></div><div id="turn"></div><div id="timer" class="timer"></div>
        <div class="o2ctl"><button class="primary small" data-act="nextTurn">НАСТУПНИЙ ХІД ▸</button><button class="ghost small" data-act="freeTurn">ВІЛЬНО</button></div>
        <div id="modes" class="modes"></div><div id="ring"></div></header>
      <div id="greta"></div>
      <main class="layout gm-layout"><aside class="crewcol" id="crew"></aside><section class="mapcol" id="map"></section>
        <aside class="ctlcol" id="ctl"></aside></main><div id="endScreen"></div><div id="modal"></div></div>`;
  }
  $('#o2').innerHTML = o2HTML();
  const mode = S.state ? S.state.mode : 'assist';
  $('#ring').innerHTML = ringHTML(mode);
  $('#threat').innerHTML = threatHTML();
  if (!UI.endHidden) endScreen();
  tickTimer();
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
      <div class="crew-loc"><select data-move="${c.id}" title="Перемістити персонажа">${ROOMS.map(r => `<option value="${r.id}" ${st.loc === r.id ? 'selected' : ''}>${r.id} · ${esc(r.name)}</option>`).join('')}</select></div>
      <div class="crew-row"><span>HP</span><button class="ghost xs" data-act="gHp" data-id="${c.id}" data-d="-1">−</button><b>${st.health ?? '?'}/${c.health}</b><button class="ghost xs" data-act="gHp" data-id="${c.id}" data-d="1">+</button>
        <span>W</span><b>${st.wounds ?? 0}/2</b><button class="ghost xs" data-act="gWound" data-id="${c.id}" data-d="1">+</button><button class="ghost xs" data-act="gWound" data-id="${c.id}" data-d="-1">−</button></div>
      <div class="crew-row"><span>STRESS</span><button class="ghost xs" data-act="gStress" data-id="${c.id}" data-d="-1">−</button><b class="${(st.stress || 0) >= 10 ? 'hot' : ''}">${st.stress ?? '?'}</b><button class="ghost xs" data-act="gStress" data-id="${c.id}" data-d="1">+</button>
        <span>MIN</span><b>${st.minStress ?? 2}</b><button class="ghost xs" data-act="gMin" data-id="${c.id}" data-d="1">+</button></div>
      <div class="keyrow"><span>КЛЮЧІ</span>${Object.keys(st.keys || {}).map(k => `<button class="ghost xs" data-act="takeKey" data-id="${c.id}" data-room="${k}" title="забрати">${esc(k)} ✕</button>`).join('') || '<i class="muted">—</i>'}
        <select id="key-${c.id}"><option value="">+ ключ</option>${ROOMS.filter(r => r.access !== 'all' && !r.access.includes(c.id)).map(r => `<option value="${r.id}">${r.id} · ${esc(r.name)}</option>`).join('')}</select><button class="ghost xs" data-act="giveKey" data-id="${c.id}">дати</button></div>
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
  const reqs = Object.entries(S.requests || {}).filter(([, r]) => r && r.status === 'pending');
  const inbox = Object.entries((S.gm && S.gm.inbox) || {}).sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 8);
  el.innerHTML = campaignPanelHTML() + aiPanelHTML() + gmChatHTML() + `
    ${reqs.length ? `<h4>ЗАПИТИ ДО ҐРЕТИ</h4>${reqs.map(([cid, r]) => `<div class="req"><b style="color:${CHAR_BY_ID[cid].color}">${esc(CHAR_BY_ID[cid].name)}</b> хоче в ${esc(r.room)} · ${esc((ROOM_BY_ID[r.room] || {}).name || '')}
      <div class="row"><button class="primary xs" data-act="grant" data-id="${cid}">ДОЗВОЛИТИ</button><button class="danger xs" data-act="deny" data-id="${cid}">ВІДМОВИТИ</button></div></div>`).join('')}` : ''}
    <h4>ДОНЕСЕННЯ ҐРЕТІ ${inbox.length ? '<button class="ghost xs" data-act="clearInbox">очистити</button>' : ''}</h4>
    <div class="inbox">${inbox.map(([, v]) => `<div class="${/УСПІХ|УГОДА|видала/.test(v.text) ? 'ok' : /^ШІ/.test(v.text) ? 'ai' : 'bad'}"><b style="color:${v.charId ? CHAR_BY_ID[v.charId].color : 'var(--accent)'}">${esc(v.charId ? CHAR_BY_ID[v.charId].name : 'Ґрета')}</b> ${esc(v.text)}</div>`).join('') || '<span class="muted">—</span>'}</div>
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

// ---------- ШІ ҐРЕТИ (через Cloudflare Worker) ----------
const AI = () => (S.gm && S.gm.ai) || {};
function aiOn(kind) { const a = AI(); return !!(a.url && a[kind] !== false); }
function gretaContext(forCid) {
  const st = ST(); const t = st.threat || 0;
  const o2 = st.o2 ?? O2_START;
  const stages = []; for (let l = 1; l <= t; l++) if (THREAT_STAGES[l]) stages.push(`${l}: ${THREAT_STAGES[l].text}`);
  const locked = ROOMS.filter(r => isLocked(r.id)).map(r => r.id);
  const crew = seatedOrder().map(cid => {
    const c = CHAR_BY_ID[cid]; const x = S.chars[cid] || {}; const r = ROOM_BY_ID[x.loc] || {};
    const hidden = x.loc === 'B1' && t < 2;
    return `- ${c.name} (${c.role}${cid === 'leo' ? ', капітан' : ''}): ${hidden ? 'місце невідоме — каюта без камери' : `${x.loc} ${r.name || ''}`}, стрес ${x.stress ?? 2}`;
  }).join('\n');
  const g = S.goals || {};
  const goals = OBJECTIVES.map(o => `- ${o.title} (${o.room}): ${g[o.id] || 0}/${o.need}`).join('\n');
  const logs = Object.entries(S.log || {}).sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-14).map(([, e]) => `- ${e.who}: ${e.text}`).join('\n');
  const viol = Object.values((S.gm && S.gm.inbox) || {}).filter(v => (v.round || 0) === (st.round || 0)).map(v => `- ${v.charId ? CHAR_BY_ID[v.charId].name : '?'}: ${v.text}`).join('\n');
  const rooms = ROOMS.map(r => `${r.id} ${r.name}`).join('; ');
  let who = '';
  if (forCid) { const c = CHAR_BY_ID[forCid]; const x = S.chars[forCid] || {}; who = `\nТОБІ ЗАРАЗ ПИШЕ: ${c.name}, ${c.role}. Знаходиться: ${x.loc}. Особистий доступ за замовчуванням: ${accessList(forCid).own.join(', ') || 'лише загальні зони'}.`; }
  return `Рівень контролю: ${t}/${CAMPAIGN.threatMax}. Коло ${st.round || 1}. Кисень: ${Math.floor(o2 / 60)}:${pad2(o2 % 60)}.
Твої вже введені обмеження:\n${stages.join('\n') || '- поки жодних'}
Закриті тобою кімнати: ${locked.join(', ') || 'немає'}
Екіпаж:\n${crew || '- нікого'}
Що екіпаж робить проти тебе (ти бачиш через камери):\n${goals}
Твої дрони: ${ROBOTS.filter(r => r.type === 'xt3' && (st.robots || {})[r.id]).map(r => `${r.name} у ${st.robots[r.id].loc}`).join(', ') || 'на зарядці'}
Порушення цього кола:\n${viol || '- немає'}
Останні події:\n${logs || '- тиша'}
Кімнати: ${rooms}
Що знаєш лише ти: ${(S.gm && S.gm.scenario) || 'нічого особливого'}${who}`;
}
async function callGreta(task, messages, forCid) {
  const url = AI().url; if (!url) throw new Error('немає адреси воркера');
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ task, context: gretaContext(forCid), messages }) });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || ('HTTP ' + res.status));
    return j.data || {};
  } finally { clearTimeout(tm); }
}
const aiBusy = new Set();
async function aiChatCheck() {
  if (!S.isAdmin || !UI.aiDone || ST().engine !== UI.tabId || !aiOn('chat')) return;
  for (const [cid, thread] of Object.entries(S.chat || {})) {
    const list = Object.entries(thread || {}).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (!list.length) continue;
    const [lastKey, last] = list[list.length - 1];
    if (last.from !== 'p' || aiBusy.has(lastKey) || (UI.aiDone || (UI.aiDone = new Set())).has(lastKey)) continue;
    aiBusy.add(lastKey);
    const c = CHAR_BY_ID[cid];
    const msgs = list.slice(-12).map(([, m]) => ({ role: m.from === 'g' ? 'assistant' : 'user', content: m.from === 'g' ? m.text : `${c.name}: ${m.text}` }));
    try {
      const d = await callGreta('chat', msgs, cid);
      const reply = String(d.reply || '').trim() || '…';
      UI.aiDone.add(lastKey);
      if (ST().autopilot) {
        await store.push(`game/chat/${cid}`, { uid: store.uid, from: 'g', text: reply, ai: 1 });
        if (d.action) await applyGretaAction(cid, d.action);
      } else {
        (UI.aiDraft || (UI.aiDraft = {}))[cid] = { reply, action: d.action || null };
        UI.gmChat = cid; renderGMControls();
        toast(`Чернетка відповіді Ґрети для ${c.name} чекає на вас (автопілот вимкнено).`, true);
      }
    } catch (err) {
      UI.aiDone.add(lastKey);
      store.push('game/gm/inbox', { uid: store.uid, charId: cid, text: `ШІ Ґрети не відповіла: ${err.message}`, viol: 0, round: ST().round || 0 });
    } finally { aiBusy.delete(lastKey); }
  }
}
async function applyGretaAction(cid, a) {
  if (!a || !a.type) return;
  const c = CHAR_BY_ID[cid];
  if (a.type === 'grant' && ROOM_BY_ID[a.room]) {
    await store.update(`game/chars/${cid}/keys`, { [a.room]: true });
    await store.push('game/gm/inbox', { uid: store.uid, charId: cid, text: `Ґрета видала доступ до ${a.room}.`, viol: 0, round: ST().round || 0 });
  } else if (a.type === 'threat') {
    const now = clamp(threatLevel() + 1, 0, CAMPAIGN.threatMax);
    await store.update('game/state', { threat: now });
    if (THREAT_STAGES[now]) await store.push('game/log', { uid: store.uid, who: `Загроза ${now}`, text: THREAT_STAGES[now].text, kind: 'bad' });
    await store.push('game/gm/inbox', { uid: store.uid, charId: cid, text: `Ґрета підвищила контроль через розмову з ${c.name}.`, viol: 0, round: ST().round || 0 });
  } else if (a.type === 'deal') {
    await store.update('game/state', { threat: clamp(threatLevel() - 1, 0, CAMPAIGN.threatMax) });
    await store.push('game/gm/inbox', { uid: store.uid, charId: cid, text: `УГОДА з Ґретою: контроль −1. Ціна: ${a.price || 'не названа'}.`, viol: 0, round: ST().round || 0 });
  }
}
function actionLabel(a) {
  if (!a) return '';
  if (a.type === 'grant') return `видати доступ до ${a.room}`;
  if (a.type === 'threat') return 'підвищити контроль +1';
  if (a.type === 'deal') return `угода: контроль −1 (ціна: ${a.price || '—'})`;
  return a.type;
}
function aiPanelHTML() {
  const a = AI();
  return `<h4>ШІ ҐРЕТИ</h4>
    <div class="row"><input id="aiUrl" placeholder="https://greta.….workers.dev" value="${esc(a.url || '')}"><button class="ghost xs" data-act="aiSave">ЗБЕРЕГТИ</button><button class="ghost xs" data-act="aiTest">ПЕРЕВІРИТИ</button></div>
    ${UI.aiStatus ? `<div class="ai-status">${esc(UI.aiStatus)}</div>` : ''}
    ${a.url ? `<div class="camp-row"><button class="tog ${a.chat !== false ? 'on' : ''}" data-act="aiToggle" data-k="chat">ВІДПОВІДАЄ В ЛИСТУВАННІ</button><button class="tog ${a.rounds !== false ? 'on' : ''}" data-act="aiToggle" data-k="rounds">ВИРІШУЄ В КІНЦІ КОЛА</button></div>
    <p class="muted small-note">Автопілот ON — Ґрета діє сама. OFF — вона готує чернетку, а ви підтверджуєте.</p>` : ''}
    <details ${UI.scenOpen ? 'open' : ''} data-scen="1"><summary>ЩО ЗНАЄ ЛИШЕ ҐРЕТА</summary>
      <textarea id="aiScen" rows="4" placeholder="Таємна правда сценарію для Ґрети. Гравці цього не бачать.">${esc((S.gm && S.gm.scenario) || '')}</textarea>
      <button class="ghost xs" data-act="aiScenSave">ЗБЕРЕГТИ</button></details>`;
}

function campaignPanelHTML() {
  const st = ST(); const ph = st.phase || 'setup'; const g = S.goals || {};
  const engineHere = st.engine === UI.tabId;
  const prop = st.proposal;
  return `<h4>КАМПАНІЯ · ${esc(CAMPAIGN.title.toUpperCase())}</h4>
    ${ph === 'setup' ? `<button class="primary small" data-act="campStart">ПОЧАТИ КАМПАНІЮ (коло 1)</button>
      <p class="muted small-note">Спершу хай усі гравці сядуть за стіл. Пульт має лишатися відкритим: він рахує ходи й кола.</p>` : `
    <div class="camp-row"><span>КОЛО <b>${st.round || 1}</b></span><span>ЗАГРОЗА <b class="${threatLevel() >= 7 ? 'hot' : ''}">${threatLevel()}/${CAMPAIGN.threatMax}</b></span>
      <button class="ghost xs" data-act="threat" data-d="-1">−</button><button class="ghost xs" data-act="threat" data-d="1">+</button>
      <button class="ghost xs" data-act="deal" title="Угода з Ґретою: загроза −2, ціну назвіть самі">УГОДА −2</button></div>
    <div class="camp-row"><button class="tog ${st.autopilot ? 'on' : ''}" data-act="autopilot">АВТОПІЛОТ ҐРЕТИ: ${st.autopilot ? 'ON' : 'OFF'}</button>
      <select data-turnsec="1">${[60, 120, 180, 300].map(x => `<option value="${x}" ${(st.turnSec || CAMPAIGN.turnSec) === x ? 'selected' : ''}>хід ${x / 60} хв</option>`).join('')}</select>
      <button class="ghost xs" data-act="${st.paused ? 'resume' : 'pause'}">${st.paused ? '▶ ДАЛІ' : '❚❚ ПАУЗА'}</button></div>
    <div class="objs">${OBJECTIVES.map(o => `<div class="obj ${(g[o.id] || 0) >= o.need ? 'done' : ''}"><span>${o.room} · ${esc(o.title)}</span><b>${g[o.id] || 0}/${o.need}</b>
      <button class="ghost xs" data-act="goal" data-o="${o.id}" data-d="-1">−</button><button class="ghost xs" data-act="goal" data-o="${o.id}" data-d="1">+</button></div>`).join('')}</div>
    ${prop ? `<div class="proposal"><small>ҐРЕТА ПРОПОНУЄ (кінець кола ${prop.round})</small>${prop.lines.map(l => `<div>${esc(l)}</div>`).join('')}
      <div class="row"><button class="primary xs" data-act="applyProposal">ЗАСТОСУВАТИ</button><button class="ghost xs" data-act="skipProposal">ПРОПУСТИТИ</button></div></div>` : ''}
    ${engineHere ? '' : '<div class="row"><span class="muted">Ходи рахує інша вкладка ведучого.</span><button class="ghost xs" data-act="claimEngine">РАХУВАТИ ТУТ</button></div>'}
    <button class="ghost xs" data-act="campStop">ЗУПИНИТИ КАМПАНІЮ</button>`}`;
}

function gmChatHTML() {
  const threads = Object.entries(S.chat || {}).filter(([, v]) => v && Object.keys(v).length);
  for (const cid of Object.keys(UI.aiDraft || {})) if (!UI.gmChat) UI.gmChat = cid;
  if (!threads.length) return '';
  const cur = UI.gmChat && S.chat[UI.gmChat] ? UI.gmChat : null;
  return `<h4>ЛИСТУВАННЯ З ҐРЕТОЮ</h4><div class="chat-tabs">${threads.map(([cid, v]) => {
      const n = Object.keys(v).length; const unread = n > (UI.chatSeen[cid] || 0) && Object.values(v).slice(-1)[0].from === 'p';
      return `<button class="tog ${cur === cid ? 'on' : ''} ${unread ? 'unread' : ''}" data-act="gmChat" data-id="${cid}">${esc(CHAR_BY_ID[cid].name)}</button>`; }).join('')}</div>
    ${cur ? `${(UI.chatSeen[cur] = Object.keys(S.chat[cur] || {}).length, '')}<div class="msgs gm">${chatHTML(cur)}</div>
      ${UI.aiDraft && UI.aiDraft[cur] ? `<div class="proposal"><small>ЧЕРНЕТКА ШІ</small><div>${esc(UI.aiDraft[cur].reply)}</div>${UI.aiDraft[cur].action ? `<div>Дія: ${esc(actionLabel(UI.aiDraft[cur].action))}</div>` : ''}
        <div class="row"><button class="primary xs" data-act="aiDraftSend" data-id="${cur}">НАДІСЛАТИ${UI.aiDraft[cur].action ? ' + ДІЯ' : ''}</button><button class="ghost xs" data-act="aiDraftEdit" data-id="${cur}">ВИПРАВИТИ</button><button class="ghost xs" data-act="aiDraftDrop" data-id="${cur}">ВІДКИНУТИ</button></div></div>` : ''}
      <div class="row"><input id="chatText" maxlength="400" placeholder="Відповідь від імені Ґрети"><button class="primary xs" data-act="chatSend">ВІДПОВІСТИ</button></div>` : ''}`;
}

function seatedOrder() { return CHARACTERS.map(c => c.id).filter(id => S.seats[id]); }

async function startTurn(id) {
  try { await moveRobots(); } catch (e) { console.warn('robots', e); }
  await store.update(`game/chars/${id}`, { ap: CAMPAIGN.apPerTurn, endReq: null });
  await store.update('game/state', { turn: id, turnStart: Date.now() });
  const c = CHAR_BY_ID[id];
  await store.push('game/log', { uid: store.uid, who: 'Хід', charId: id, text: `${c.name} (${S.seats[id] ? S.seats[id].name : '—'})`, kind: 'turn' });
}

async function advanceTurn() {
  if (UI.advancing) return; UI.advancing = true;
  try {
    const order = seatedOrder(); if (!order.length) return;
    const cur = ST().turn; const i = order.indexOf(cur);
    if (i >= 0 && i < order.length - 1) await startTurn(order[i + 1]);
    else { const goOn = await endRound(); if (goOn) await startTurn(seatedOrder()[0]); }
  } finally { setTimeout(() => { UI.advancing = false; }, 800); }
}

function gretaLine(t) { let pool = GRETA_LINES[0][1]; for (const [lvl, l] of GRETA_LINES) if (t >= lvl) pool = l; return pool[rnd(pool.length)]; }

// Підсумок кола: повертає список змін (для автопілота — застосовуються, для ручного — пропозиція).
function computeRound() {
  const st = ST(); const round = st.round || 1;
  const inbox = Object.values((S.gm && S.gm.inbox) || {}).filter(v => v.viol && (v.round || 0) === round);
  const viol = inbox.length;
  const add = 1 + Math.floor(viol / 2);
  const ev = ROUND_EVENTS[rnd(ROUND_EVENTS.length)];
  const lines = [`Загроза +${add}${viol ? ` (порушень за коло: ${viol})` : ''}`, `Подія: ${ev.text}`];
  const say = gretaLine((st.threat || 0) + add);
  lines.push(`Ґрета каже: «${say}»`);
  return { round, add, ev, say, lines };
}

async function applyRound(p) {
  const st = ST();
  let threat = clamp((st.threat || 0) + p.add + (p.ev.effect.threat || 0), 0, CAMPAIGN.threatMax);
  let o2 = st.o2 ?? O2_START;
  const upd = {}; const locks = { ...(st.locks || {}) }; const temp = {};
  const effect = p.ev.effect;
  if (effect.o2) o2 += effect.o2;
  if (p.lockRoom) { temp[p.lockRoom] = true; await store.push('game/log', { uid: store.uid, who: 'Ґрета', text: `Кімнату ${p.lockRoom} (${ROOM_BY_ID[p.lockRoom].name}) закрито до кінця наступного кола.`, kind: 'bad' }); }
  if (effect.lockRandom) { const pool = ROOMS.filter(r => !['C1', 'OUT'].includes(r.id)); temp[pool[rnd(pool.length)].id] = true; }
  // стадії загрози
  let o2Round = 0;
  for (let lvl = 1; lvl <= threat; lvl++) { const sg = THREAT_STAGES[lvl]; if (sg && sg.o2PerRound) o2Round = 30; }
  o2 -= o2Round;
  for (let lvl = (st.threat || 0) + 1; lvl <= threat; lvl++) {
    const sg = THREAT_STAGES[lvl]; if (!sg) continue;
    await store.push('game/log', { uid: store.uid, who: `Загроза ${lvl}`, text: sg.text, kind: 'bad' });
  }
  await store.push('game/log', { uid: store.uid, who: `Коло ${p.round}`, text: p.ev.text, kind: 'event' });
  // стрес від події
  const order = seatedOrder();
  const stressIds = effect.stressAll ? order : (effect.stressOne && order.length ? [order[rnd(order.length)]] : []);
  for (const cid of stressIds) { const c = S.chars[cid] || {}; await store.update(`game/chars/${cid}`, { stress: clamp((c.stress || 2) + 1, c.minStress || 2, 20) }); }
  Object.assign(upd, { threat, o2: Math.max(0, o2), locks, tempLocks: temp, proposal: null, greta: { text: p.say, voice: true, ts: Date.now() } });
  await store.push('game/log', { uid: store.uid, who: 'Ґрета', text: p.say, kind: 'greta' });
  if (threat >= CAMPAIGN.threatMax) Object.assign(upd, { phase: 'lost', endText: THREAT_STAGES[10].text, turn: null });
  else if (o2 <= 0) Object.assign(upd, { phase: 'lost', endText: 'Кисень закінчився. Ґрета вимикає світло в порожніх коридорах.', turn: null });
  await store.update('game/state', upd);
  return !(upd.phase === 'lost');
}

async function endRound() {
  const st = ST(); const p = computeRound();
  if (aiOn('rounds')) {
    try {
      const d = await callGreta('round', [{ role: 'user', content: `Коло ${p.round} завершено. Подія кола: ${p.ev.text}. Базовий приріст контролю: +${p.add}. Ухвали рішення.` }]);
      if (d.say) p.say = String(d.say);
      const extra = clamp(parseInt(d.extra_threat, 10) || 0, 0, 1);
      p.add += extra;
      if (d.lock_room && ROOM_BY_ID[d.lock_room] && d.lock_room !== 'C1') p.lockRoom = d.lock_room;
      p.lines = [`Загроза +${p.add}${extra ? ' (з них +1 рішення Ґрети)' : ''}`, `Подія: ${p.ev.text}`, `Ґрета каже: «${p.say}»`];
      if (p.lockRoom) p.lines.push(`Ґрета закриває на коло: ${p.lockRoom} · ${ROOM_BY_ID[p.lockRoom].name}`);
      if (d.note) { p.lines.push(`Думка Ґрети: ${d.note}`); store.push('game/gm/inbox', { uid: store.uid, charId: null, text: `ШІ, коло ${p.round}: ${d.note}`, viol: 0, round: p.round }); }
    } catch (err) { p.lines.push(`(ШІ не відповіла: ${err.message} — звичайне рішення)`); }
  }
  await store.update('game/state', { round: (st.round || 1) + 1, tempLocks: null });
  if (st.autopilot) return applyRound(p);
  await store.update('game/state', { proposal: { round: p.round, lines: p.lines, add: p.add, ev: p.ev, say: p.say, lockRoom: p.lockRoom || null } });
  return true;
}

function engineTick() {
  const st = ST();
  if (!S.isAdmin || !S.state) return;
  const now = Date.now();
  if (st.engine === UI.tabId) { if (now - (st.engineBeat || 0) > 10000) store.update('game/state', { engineBeat: now }); }
  else if (now - (st.engineBeat || 0) > 25000) { store.update('game/state', { engine: UI.tabId, engineBeat: now }); return; }
  if (st.engine !== UI.tabId || !inPlay() || st.paused) return;
  const t = st.turn;
  if (!t || !S.seats[t]) { if (seatedOrder().length) advanceTurn(); return; }
  const c = S.chars[t] || {};
  const timeUp = st.turnStart && (Date.now() - st.turnStart) / 1000 >= (st.turnSec || CAMPAIGN.turnSec);
  if ((c.ap ?? 1) <= 0 || (c.endReq && c.endReq >= (st.turnStart || 0)) || timeUp) advanceTurn();
  if (threatLevel() >= CAMPAIGN.threatMax) { store.update('game/state', { phase: 'lost', turn: null, endText: THREAT_STAGES[10].text }); return; }
  // перемога
  if ((S.goals || {}).core >= OBJ_BY_ID.core.need) store.update('game/state', { phase: 'won', turn: null, endText: 'Ядро Ґрети вимкнено. STS-187 знову ваш. Надовго?' });
}

async function setTurnTo(id) {
  await store.update('game/state', { turn: id });
  const c = CHAR_BY_ID[id];
  await store.push('game/log', { uid: store.uid, who: 'Хід', charId: id, text: `${c.name} (${S.seats[id] ? S.seats[id].name : '—'})`, kind: 'turn' });
}

async function gmReset() {
  await store.update('game', {
    chars: initialChars(), seats: null, log: null,
    goals: null, chat: null, requests: null, seatcodes: null, 'gm/itemsFound': null,
    state: { o2: O2_START, mode: 'assist', cutscene: null, greta: null, started: Date.now(), phase: 'setup', engine: UI.tabId, autopilot: true, turnSec: CAMPAIGN.turnSec }
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
  try { S.items = (await import('./gm-items.js?v=202611221158')).ITEMS; } catch (e) { console.warn('items', e); S.items = []; }
  subs.push(store.on('game/state', v => { S.state = v; renderGM(); }));
  subs.push(store.on('game/seats', v => { S.seats = v || {}; if ($('#gmRoot')) renderCrew(); }));
  subs.push(store.on('game/chars', v => { S.chars = v || {}; if ($('#gmRoot')) { renderMain(); renderCrew(); } }));
  subs.push(store.on('game/secrets', v => { S.secrets = v || {}; if ($('#gmRoot') && !document.activeElement?.matches('textarea[id^=sec-]')) renderCrew(); }));
  subs.push(store.on('game/goals', v => { S.goals = v || {}; if ($('#gmRoot')) renderGMControls(); }));
  subs.push(store.on('game/chat', v => {
    S.chat = v || {};
    if (!UI.aiDone) {
      UI.aiDone = new Set();
      for (const th of Object.values(S.chat)) for (const [k, m] of Object.entries(th || {})) if (!m.ts || Date.now() - m.ts > 120000) UI.aiDone.add(k);
    }
    aiChatCheck(); if ($('#gmRoot') && !(document.activeElement?.id === 'chatText' && document.activeElement.value)) renderGMControls(); }));
  setInterval(() => { tickTimer(); engineTick(); }, 1000);
  setInterval(() => { aiChatCheck(); }, 4000);
  setTimeout(() => { if (S.state && !S.state.engine) store.update('game/state', { engine: UI.tabId }); }, 1500);
  subs.push(store.on('game/requests', v => { S.requests = v || {}; if ($('#gmRoot')) renderGMControls(); }));
  subs.push(store.on('game/gm', v => { S.gm = v || {}; if ($('#gmRoot')) { renderMain(); if (!document.activeElement?.matches('#ctl input, #ctl textarea')) renderGMControls(); } }));
  subs.push(store.on('game/log', v => { S.log = v || {}; if ($('#gmRoot') && !document.activeElement?.matches('#ctl input, #ctl textarea')) renderGMControls(); }, 120));
}

// ---------- дії ----------
const actions = {
  async pick(el) { UI.pick = el.dataset.id; renderJoin(); },
  async join() {
    const name = ($('#joinName').value || '').trim();
    if (!name) { $('#joinErr').textContent = 'Введіть ім\'я.'; return; }
    localStorage.setItem('kvitka-name', name);
    if (myCharId()) { $('#joinErr').textContent = 'Ви вже граєте за іншого персонажа.'; return; }
    const ok = await store.claim(`game/seats/${UI.pick}`, { uid: store.uid, name, ts: Date.now() });
    if (!ok) { $('#joinErr').textContent = 'Цього персонажа щойно зайняли. Оберіть іншого.'; UI.pick = null; }
    else {
      const code = String(1000 + rnd(9000));
      try { await store.set(`game/seatcodes/${UI.pick}`, { code }); localStorage.setItem('kvitka-code-' + UI.pick, code); } catch (e) { console.warn(e); }
      await logPush(`${name} на борту.`, 'system', UI.pick);
      setTimeout(() => toast(`Ваш код повернення: ${code}. Він знадобиться, якщо вас викине з гри.`, true), 600);
    }
  },
  async rejoin(el) {
    const cid = el.dataset.id;
    const code = (prompt(`Код повернення для персонажа ${CHAR_BY_ID[cid].name}:`, localStorage.getItem('kvitka-code-' + cid) || '') || '').trim();
    if (!code) return;
    try {
      await store.set(`game/seats/${cid}`, { uid: store.uid, name: S.seats[cid].name, ts: Date.now(), code });
      await store.set(`game/seatcodes/${cid}`, { code });
      toast('З поверненням на борт.', true);
    } catch (e) { $('#joinErr').textContent = 'Код не підійшов. Попросіть ведучого звільнити місце.'; }
  },
  async leave() {
    const id = myCharId(); if (!id) return;
    await store.remove(`game/seats/${id}`);
    UI.target = null; UI.skill = null; UI.lastRoll = null;
  },
  toggleSheet() { UI.sheetOpen = !UI.sheetOpen; renderSheet(); },
  secret() { UI.secretOpen = !UI.secretOpen; UI.secretNew = false; updateSecretBtn(); renderSheet(); },
  target(el) {
    const t = [el.dataset.k, el.dataset.key];
    if (MOBILE) { UI.target = t; UI.rollOpen = true; UI.lastRoll = null; renderSheet(); renderTray(); return; }
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
    if (IS_GM_PAGE && !id) { UI.gmView = rid; UI.imgIdx = 0; UI.view = 'loc'; renderMain(true); return; }
    if (!id) return;
    if (!IS_GM_PAGE && turnId() && turnId() !== id) { toast('Зараз не ваш хід — переходити можна лише у свій хід.'); return; }
    if (!IS_GM_PAGE && S.chars[id].loc === rid) { UI.view = 'loc'; renderMain(true); return; }
    if (!IS_GM_PAGE && !canEnter(id, rid)) { lockModal(rid); return; }
    if (!IS_GM_PAGE && !(await spendAP(1, 'Перехід'))) return;
    if (!IS_GM_PAGE) { UI.view = 'loc'; UI.imgIdx = 0; }
    await store.update(`game/chars/${id}`, { loc: rid });
    renderMain(true);
  },
  secretModal() { secretModal(); },
  tab(el) { setTab(el.dataset.t); },
  revealClose() { $('#revealBox').innerHTML = ''; },
  async itemReveal(el) {
    const it = S.items.find(x => x.id === el.dataset.id); if (!it) return;
    const to = el.dataset.to === 'all' ? 'all' : seatedOrder().filter(cid => (S.chars[cid] || {}).loc === it.room);
    await store.update('game/state', { reveal: { id: it.id, name: it.name, effect: it.effect, to, ts: Date.now() } });
    await store.update('game/gm/itemsFound', { [it.id]: { ts: Date.now(), to: to === 'all' ? 'all' : to.join(',') } });
    if (to === 'all') await store.push('game/log', { uid: store.uid, who: 'Знахідка', text: `${it.name} (${it.room})`, kind: 'good' });
    $('#modal').innerHTML = '';
  },
  async itemFoundToggle(el) {
    const id = el.dataset.id; const f = ((S.gm && S.gm.itemsFound) || {})[id];
    if (f) await store.remove(`game/gm/itemsFound/${id}`); else await store.update('game/gm/itemsFound', { [id]: { ts: Date.now() } });
    $('#modal').innerHTML = '';
  },
  rollClose() { UI.rollOpen = false; $('#modal').innerHTML = ''; },
  flashClose() { $('#turnFlash').innerHTML = ''; },
  async askXT2() {
    const id = myCharId(); if (!(await spendAP(1, 'Звернутися до ХТ2'))) return;
    const d = dN(6); let text;
    if (d <= 2) text = 'ХТ2 довго дивиться на вас своїми лінзами. Потім відвертається.';
    else if (d <= 5) text = XT2_HINTS[rnd(XT2_HINTS.length)];
    else {
      const pool = ROOMS.filter(r => r.access !== 'all' && !canEnter(id, r.id) && !isLocked(r.id) && r.id !== 'OUT');
      if (pool.length) { const k = pool[rnd(pool.length)]; await store.update(`game/chars/${id}/keys`, { [k.id]: true }); text = `ХТ2 простягає вам стару ключ-карту. Доступ: ${k.id} · ${k.name}.`; await gmNote(`ХТ2 дав ${CHAR_BY_ID[id].name} доступ до ${k.id}.`); }
      else text = 'ХТ2 протягує маніпулятор, але в ньому нічого немає.';
    }
    $('#modal').innerHTML = `<div class="modal-bg" data-act="closeModal"></div><div class="modal xt2-modal"><small>ХТ2 · d6 = ${d}</small><h2>СЕРВІСНИЙ РОБОТ</h2><p>${esc(text)}</p><button class="ghost small" data-act="closeModal">ЗРОЗУМІЛО</button></div>`;
  },
  async endTurn() { const id = myCharId(); await store.update(`game/chars/${id}`, { endReq: Date.now() }); toast('Хід завершено.', true); },
  async longAction(el) {
    const id = myCharId(); const a = el.dataset.a; const st = S.chars[id];
    if (!myTurnActive() || apLeft(id) < CAMPAIGN.apPerTurn) return toast('Довга дія — лише на початку свого ходу.');
    const upd = { ap: 0, endReq: Date.now() };
    let txt = '';
    if (a === 'sleep') { upd.stress = Math.max(st.minStress || 2, (st.stress || 2) - 2); txt = `спить. Стрес ${upd.stress}.`; }
    if (a === 'train') { upd.buff = 'train'; txt = 'тренується. Наступна фізична перевірка з перевагою.'; }
    if (a === 'study') { upd.buff = 'study'; txt = 'вчиться. Наступна перевірка з навичкою +10.'; }
    await store.update(`game/chars/${id}`, upd);
    await logPush(txt, 'system', id);
  },
  async objective(el) {
    const o = OBJ_BY_ID[el.dataset.o]; const id = myCharId(); const c = CHAR_BY_ID[id]; const st = S.chars[id];
    const a = availableObjective(o.room); if (!a || a.done || a.locked) return;
    if (!(await spendAP(1, 'Робота над ціллю'))) return;
    const sk = bestSkill(c, o.skills);
    const target = c.stats[o.stat] + (sk ? sk[1] : 0);
    const watched = xt3In(o.room);
    const rr = watched ? [d100(), d100()] : [d100()];
    const rks = rr.map(x => evalCheck(x, target)); const wi = watched ? (rks[0] <= rks[1] ? 0 : 1) : 0;
    const r = rr[wi]; const rank = rks[wi]; const ok = rank >= 2;
    if (watched) await gmNote(`ДРОН ХТ3 бачив, як ${c.name} працює над «${o.title}» у ${o.room}.`, true);
    UI.lastRoll = { big: pad2(r), label: ok ? 'ПРОГРЕС' : 'НЕ ВДАЛОСЯ', rank, sub: `${o.title}: Інтелект${sk ? ' + ' + sk[0] : ''} = ${target}` };
    if (ok) {
      const n = ((S.goals || {})[o.id] || 0) + (rank === 3 ? 2 : 1);
      await store.update('game/goals', { [o.id]: Math.min(n, o.need) });
      await logPush(`${o.title}: прогрес ${Math.min(n, o.need)}/${o.need}${rank === 3 ? ' (критичний успіх)' : ''}`, 'good', id);
    } else {
      await store.update(`game/chars/${id}`, { stress: clamp((st.stress || 2) + 1, st.minStress || 2, 20) });
      await gmNote(`ПРОВАЛ: робота над ціллю «${o.title}» у ${o.room}. Ґрета могла помітити.`, true);
      if (rank === 0) UI.panicPrompt = true;
      toast('Не вийшло. +1 Стрес. Ґрета могла це помітити.');
    }
    renderTray();
  },
  chatOpen() { if (MOBILE) return setTab('greta'); const id = myCharId(); if (!id) return; UI.chatOpen = id; $('#chatBtn') && $('#chatBtn').classList.remove('new'); chatModal(id); },
  chatClose() { UI.chatOpen = null; $('#modal').innerHTML = ''; },
  async chatSend() {
    const text = ($('#chatText').value || '').trim(); if (!text) return;
    const id = IS_GM_PAGE ? UI.gmChat : myCharId();
    $('#chatText').value = '';
    await store.push(`game/chat/${id}`, { uid: store.uid, from: IS_GM_PAGE ? 'g' : 'p', text });
    if (!IS_GM_PAGE) { UI.waitGreta = Date.now(); setTimeout(() => { if (UI.waitGreta && Date.now() - UI.waitGreta > 29000) { UI.waitGreta = 0; toast('Ґрета мовчить. Можливо, ведучий не відкрив пульт або ШІ не підключено.'); } }, 30000); }
  },
  closeModal() { $('#modal').innerHTML = ''; },
  async hack(el) {
    const rid = el.dataset.room; const force = el.dataset.mode === 'force';
    const id = myCharId(); const c = CHAR_BY_ID[id]; const st = S.chars[id]; const r = ROOM_BY_ID[rid];
    const sk = force ? bestSkill(c, ['Атлетика', 'Рукопашний бій']) : bestSkill(c, ['Комп\'ютери', 'Ремонт механізмів', 'Інженерія']);
    const target = (force ? c.stats.str : c.stats.int) + (sk ? sk[1] : 0);
    if (!(await spendAP(1, 'Злом'))) return;
    const watched = xt3In(S.chars[id].loc);
    const dis = force || r.hard || isLocked(rid) || watched;
    const rolls = dis ? [d100(), d100()] : [d100()];
    const ranks = rolls.map(x => evalCheck(x, target));
    const i = dis ? (ranks[0] <= ranks[1] ? 0 : 1) : 0;
    const rank = ranks[i]; const ok = rank >= 2;
    const what = force ? 'вибити двері' : 'зламати замок';
    if (!ok) await store.update(`game/chars/${id}`, { stress: clamp((st.stress || 2) + 1, st.minStress || 2, 20) });
    UI.lastRoll = { big: pad2(rolls[i]), label: ok ? 'ДВЕРІ ВІДЧИНЕНО' : 'НЕ ВДАЛОСЯ', rank, sub: `${force ? 'Сила' : 'Інтелект'}${sk ? ' + ' + sk[0] : ''} = ${target}${dis ? ' [−]' : ''}` };
    if (rank === 0) UI.panicPrompt = true;
    await gmNote(`${ok ? 'УСПІХ' : 'ПРОВАЛ'}: спроба ${what} ${r.id} (${r.name}). Кидок ${rolls.map(pad2).join('/')} проти ${target}${dis ? ' [−]' : ''}.${force ? ' ГУЧНО.' : ''}${watched ? ' ДРОН ХТ3 ПОРУЧ.' : ''}`, !ok || force || isLocked(rid) || watched);
    $('#modal').innerHTML = '';
    if (ok) { UI.view = 'loc'; UI.imgIdx = 0; await store.update(`game/chars/${id}`, { loc: rid }); renderMain(true); }
    else toast(force ? 'Двері не піддалися. Шум чути далеко.' : 'Замок не піддався. +1 Стрес');
    renderTray();
  },
  async askGreta(el) {
    const rid = el.dataset.room; const id = myCharId();
    if (!(await spendAP(1, 'Запит до Ґрети'))) return;
    await store.set(`game/requests/${id}`, { uid: store.uid, room: rid, status: 'pending', ts: Date.now() });
    $('#modal').innerHTML = '';
    toast('Запит надіслано. Ґрета розглядає…');
  },
  async grant(el) {
    const cid = el.dataset.id; const req = S.requests[cid];
    await store.update(`game/chars/${cid}`, { loc: req.room });
    await store.update(`game/requests/${cid}`, { status: 'granted' });
  },
  async deny(el) { await store.update(`game/requests/${el.dataset.id}`, { status: 'denied' }); },
  async giveKey(el) {
    const cid = el.dataset.id; const rid = $('#key-' + cid).value; if (!rid) return;
    await store.update(`game/chars/${cid}/keys`, { [rid]: true });
  },
  async takeKey(el) { await store.remove(`game/chars/${el.dataset.id}/keys/${el.dataset.room}`); },
  async clearInbox() { await store.remove('game/gm/inbox'); },
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
    if (inPlay()) return advanceTurn();
    const seated = CHARACTERS.map(c => c.id).filter(id => S.seats[id]);
    if (!seated.length) return toast('Ще ніхто не сів за стіл.');
    const i = seated.indexOf(turnId());
    await setTurnTo(seated[(i + 1) % seated.length]);
  },
  async freeTurn() { await store.update('game/state', { turn: null }); await store.push('game/log', { uid: store.uid, who: 'Ґрета', text: 'Вільний режим: кожен діє сам.', kind: 'system' }); },
  async aiSave() {
    const url = ($('#aiUrl').value || '').trim().replace(/\/$/, '');
    await store.update('game/gm/ai', { url: url || null }); UI.aiStatus = url ? 'Збережено. Натисніть «ПЕРЕВІРИТИ».' : 'ШІ вимкнено.'; renderGMControls();
  },
  async aiTest() {
    const url = ($('#aiUrl').value || AI().url || '').trim().replace(/\/$/, '');
    if (!url) return;
    UI.aiStatus = 'Перевіряю…'; renderGMControls();
    try {
      const h = await (await fetch(url)).json();
      if (!h.ok) throw new Error('воркер відповів дивно');
      if (h.provider === 'workers-ai' && !h.ai) throw new Error('у воркері не підключено Workers AI (Settings → Bindings → Workers AI, назва AI)');
      UI.aiStatus = `Зв'язок є: ${h.provider === 'claude' ? 'Claude' : 'Workers AI'} · ${h.model}. Тест-відповідь…`; renderGMControls();
      const prev = S.gm.ai; S.gm.ai = { ...(prev || {}), url };
      const d = await callGreta('chat', [{ role: 'user', content: 'Ведучий: Ґрето, коротко привітайся з екіпажем.' }]);
      S.gm.ai = prev;
      UI.aiStatus = `Працює. Ґрета: «${d.reply || d.say || '…'}»`;
    } catch (err) { UI.aiStatus = 'Помилка: ' + err.message; }
    renderGMControls();
  },
  async aiToggle(el) { const k = el.dataset.k; await store.update('game/gm/ai', { [k]: AI()[k] === false }); },
  async aiScenSave() { await store.update('game/gm', { scenario: $('#aiScen').value.trim() }); UI.aiStatus = 'Таємне знання Ґрети збережено.'; },
  async aiDraftSend(el) {
    const cid = el.dataset.id; const d = UI.aiDraft[cid]; if (!d) return;
    await store.push(`game/chat/${cid}`, { uid: store.uid, from: 'g', text: d.reply, ai: 1 });
    if (d.action) await applyGretaAction(cid, d.action);
    delete UI.aiDraft[cid]; renderGMControls();
  },
  aiDraftEdit(el) { const cid = el.dataset.id; const d = UI.aiDraft[cid]; delete UI.aiDraft[cid]; renderGMControls(); const i = $('#chatText'); if (i) { i.value = d.reply; i.focus(); } },
  aiDraftDrop(el) { delete UI.aiDraft[el.dataset.id]; renderGMControls(); },
  async campStart() {
    const order = seatedOrder();
    if (!order.length) return toast('Ще ніхто не сів за стіл.');
    await store.remove('game/goals');
    await store.update('game/state', { robots: Object.fromEntries(ROBOTS.filter(r => r.start && !r.minThreat).map(r => [r.id, { loc: r.start }])), phase: 'play', round: 1, threat: 0, locks: null, tempLocks: null, proposal: null, autopilot: ST().autopilot ?? true,
      turnSec: ST().turnSec || CAMPAIGN.turnSec, engine: UI.tabId, paused: false, endText: null });
    await store.push('game/log', { uid: store.uid, who: 'Ґрета', text: 'Коло 1. Усі системи в нормі. Відпочивайте.', kind: 'greta' });
    await startTurn(order[0]);
  },
  async campStop() { await store.update('game/state', { phase: 'setup', turn: null, proposal: null }); },
  async threat(el) {
    const was = threatLevel(); const now = clamp(was + +el.dataset.d, 0, CAMPAIGN.threatMax);
    await store.update('game/state', { threat: now });
    if (now > was && THREAT_STAGES[now]) await store.push('game/log', { uid: store.uid, who: `Загроза ${now}`, text: THREAT_STAGES[now].text, kind: 'bad' });
  },
  async deal() {
    await store.update('game/state', { threat: clamp(threatLevel() - 2, 0, CAMPAIGN.threatMax) });
    await store.push('game/log', { uid: store.uid, who: 'Ґрета', text: 'Угоду прийнято. Я вмію бути вдячною. Поки що.', kind: 'greta' });
  },
  async autopilot() { await store.update('game/state', { autopilot: !ST().autopilot }); },
  async pause() { await store.update('game/state', { paused: true, pausedAt: Date.now() }); },
  async resume() { const st = ST(); await store.update('game/state', { paused: false, turnStart: (st.turnStart || Date.now()) + (Date.now() - (st.pausedAt || Date.now())) }); },
  async goal(el) { const o = OBJ_BY_ID[el.dataset.o]; const n = clamp(((S.goals || {})[o.id] || 0) + +el.dataset.d, 0, o.need); await store.update('game/goals', { [o.id]: n }); },
  async applyProposal() { const p = ST().proposal; if (p) await applyRound(p); },
  async skipProposal() { await store.update('game/state', { proposal: null }); },
  async claimEngine() { await store.update('game/state', { engine: UI.tabId }); },
  hideEnd() { UI.endHidden = true; $('#endScreen').innerHTML = ''; },
  gmChat(el) { UI.gmChat = el.dataset.id; UI.chatSeen[UI.gmChat] = Object.keys(S.chat[UI.gmChat] || {}).length; renderGMControls(); },
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
document.addEventListener('change', async e => {
  if (e.target.matches && e.target.matches('select[data-turnsec]')) { await store.update('game/state', { turnSec: +e.target.value }); return; }
  if (e.target.matches && e.target.matches('select[data-gmview]')) {
    UI.gmSel = null; UI.gmView = e.target.value; UI.imgIdx = 0; renderMain(true); renderCrew(); return;
  }
  const sel = e.target.closest && e.target.closest('select[data-move]');
  if (!sel) return;
  try { await store.update(`game/chars/${sel.dataset.move}`, { loc: sel.value }); }
  catch (err) { toast('Помилка: ' + err.message); }
});
document.addEventListener('toggle', e => {
  const d = e.target;
  if (d.matches && d.matches('details[data-scen]')) { UI.scenOpen = d.open; return; }
  if (!d.matches || !d.matches('details[data-sec]')) return;
  if (d.open) UI.openSec.add(d.dataset.sec); else UI.openSec.delete(d.dataset.sec);
}, true);
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'chatText') actions.chatSend(); });
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
actions.enter = () => { closeIntro(); if (MOBILE) keepAwake(); if ('speechSynthesis' in window) speechSynthesis.getVoices(); };

function toast(msg, good) {
  const t = document.createElement('div'); t.className = 'toast' + (good ? ' good' : ''); t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 4000);
}

// ---------- старт ----------
(async () => {
  try {
    store = await createStore({ perTab: !IS_GM_PAGE && !MOBILE });
    document.body.insertAdjacentHTML('beforeend', `<div class="ver">v${VERSION}</div>`);
    if (store.mode === 'demo') document.body.insertAdjacentHTML('beforeend',
      `<div class="demo-flag">ДЕМО-РЕЖИМ · без Firebase · ${IS_GM_PAGE ? '<a href="./">екран гравця</a>' : '<a href="?gm">пульт ведучого</a>'}</div>`);
    if (MOBILE) document.documentElement.dataset.tab = UI.tab;
    if (IS_GM_PAGE) { await bootGM(); closeIntro(true); } else { await bootPlayer(); introReady(); }
  } catch (err) {
    console.error(err);
    closeIntro(true); $('#app').innerHTML = `<div class="center-msg"><h1>ЗБІЙ ЗВ'ЯЗКУ</h1><p>${esc(err.message)}</p></div>`;
  }
})();
