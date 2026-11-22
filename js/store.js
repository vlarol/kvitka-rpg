// Шар даних: Firebase Realtime Database або демо-режим (localStorage, синхронізація між вкладками).
import { firebaseConfig } from './config.js?v=202611221237';

const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';

export async function createStore(opts = {}) {
  return firebaseConfig.apiKey ? firebaseStore(opts) : demoStore();
}

async function firebaseStore(opts) {
  const { initializeApp } = await import(FB + 'firebase-app.js');
  const A = await import(FB + 'firebase-auth.js');
  const D = await import(FB + 'firebase-database.js');
  // Окремий екземпляр для гравців, щоб вкладка гравця не підхоплювала Google-вхід ведучого в цьому ж браузері.
  const app = opts.perTab ? initializeApp(firebaseConfig, 'player') : initializeApp(firebaseConfig);
  const auth = A.getAuth(app);
  const db = D.getDatabase(app);
  // Гравці: окрема особа на кожну вкладку (можна грати кількома персонажами з одного браузера).
  if (opts.perTab) await A.setPersistence(auth, A.browserSessionPersistence);
  const first = await new Promise(res => { const off = A.onAuthStateChanged(auth, u => { off(); res(u); }); });

  const s = {
    mode: 'firebase',
    user: first,
    get uid() { return s.user && s.user.uid; },
    get isGoogle() { return !!(s.user && !s.user.isAnonymous); },
    async ensureAnon() {
      if (!auth.currentUser) await A.signInAnonymously(auth);
      s.user = auth.currentUser;
      return s.user;
    },
    async signInGoogle() {
      const r = await A.signInWithPopup(auth, new A.GoogleAuthProvider());
      s.user = r.user;
      return r.user;
    },
    async signOut() { await A.signOut(auth); s.user = null; },
    on(path, cb, limit) {
      let r = D.ref(db, path);
      if (limit) r = D.query(r, D.limitToLast(limit));
      return D.onValue(r, snap => cb(snap.val()), err => { console.warn('read', path, err.message); cb(null); });
    },
    set: (p, v) => D.set(D.ref(db, p), v),
    update: (p, v) => D.update(D.ref(db, p), v),
    push: (p, v) => D.push(D.ref(db, p), { ...v, ts: D.serverTimestamp() }),
    remove: p => D.remove(D.ref(db, p)),
    async claim(p, v) {
      const r = await D.runTransaction(D.ref(db, p), cur => (cur ? undefined : v));
      return r.committed;
    }
  };
  return s;
}

function demoStore() {
  const KEY = 'kvitka-demo-db';
  let tree = JSON.parse(localStorage.getItem(KEY) || '{}');
  let uid = sessionStorage.getItem('kvitka-demo-uid');
  if (!uid) { uid = 'demo-' + Math.random().toString(36).slice(2, 10); sessionStorage.setItem('kvitka-demo-uid', uid); }
  const listeners = new Set();
  const parts = p => p.split('/').filter(Boolean);
  const get = p => parts(p).reduce((o, k) => (o == null ? null : o[k]), tree) ?? null;
  const view = (p, limit) => {
    let v = get(p);
    if (v == null) return null;
    v = JSON.parse(JSON.stringify(v));
    if (limit && typeof v === 'object') {
      const keys = Object.keys(v).sort().slice(-limit);
      v = Object.fromEntries(keys.map(k => [k, v[k]]));
    }
    return v;
  };
  const notify = () => listeners.forEach(l => l.cb(view(l.p, l.limit)));
  const save = () => { localStorage.setItem(KEY, JSON.stringify(tree)); notify(); };
  window.addEventListener('storage', e => { if (e.key === KEY) { tree = JSON.parse(e.newValue || '{}'); notify(); } });
  function setIn(p, v) {
    const ks = parts(p);
    let o = tree;
    for (let i = 0; i < ks.length - 1; i++) {
      if (o[ks[i]] == null || typeof o[ks[i]] !== 'object') o[ks[i]] = {};
      o = o[ks[i]];
    }
    const last = ks[ks.length - 1];
    if (v == null) delete o[last]; else o[last] = JSON.parse(JSON.stringify(v));
  }
  let counter = 0;
  const s = {
    mode: 'demo',
    user: { uid, isAnonymous: true },
    get uid() { return uid; },
    isGoogle: true,
    async ensureAnon() { return s.user; },
    async signInGoogle() { return s.user; },
    async signOut() {},
    on(p, cb, limit) {
      const l = { p, cb, limit };
      listeners.add(l);
      setTimeout(() => cb(view(p, limit)), 0);
      return () => listeners.delete(l);
    },
    async set(p, v) { setIn(p, v); save(); },
    async update(p, obj) { for (const [k, v] of Object.entries(obj)) setIn(p + '/' + k, v); save(); },
    async push(p, v) {
      const key = String(Date.now()).padStart(15, '0') + String(counter++).padStart(4, '0') + Math.random().toString(36).slice(2, 5);
      setIn(p + '/' + key, { ...v, ts: Date.now() });
      save();
    },
    async remove(p) { setIn(p, null); save(); },
    async claim(p, v) { if (get(p)) return false; setIn(p, v); save(); return true; }
  };
  return s;
}
