/* FindIt — shared household app (Supabase free tier).
 * Plain static front end. Each person signs in with their own login and
 * only sees their own containers, categories, items and shelves (user_id
 * on every row, enforced by Row Level Security). See DELIVERY-NOTE.md. */

'use strict';

/* ---------- Config and client ---------- */

const CONFIG = (window.STORAGE_APP_CONFIG || {});
const SUPABASE_URL = (CONFIG.SUPABASE_URL || '').trim();
const SUPABASE_ANON_KEY = (CONFIG.SUPABASE_ANON_KEY || '').trim();
const CONFIG_DONE = SUPABASE_URL && SUPABASE_ANON_KEY &&
  !SUPABASE_URL.includes('YOUR-PROJECT') && !SUPABASE_ANON_KEY.includes('YOUR-ANON');

let sb = null;
if (CONFIG_DONE && window.supabase) {
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

const PHOTO_BUCKET = 'item-photos';
const LABEL_COLORS = ['#00317e', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#000000', '#64748b', '#db2777'];

/* ---------- Small helpers ---------- */

const el = (id) => document.getElementById(id);
// Only explicitly app-owned text is localized; user values never pass here.
const uiText = (node, source) => window.FindItI18n.setText(node, source);
const uiParts = (node, parts) => window.FindItI18n.setParts(node, parts);
const uiAttr = (node, name, source, parameters) => window.FindItI18n.setAttribute(node, name, source, parameters);
let toastTimer = null;
function toast(msg) {
  const t = el('toast');
  uiText(t, msg);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

function showError(boxId, msg) {
  const box = el(boxId);
  if (!box) return;
  box.innerHTML = '';
  uiText(box, msg);
  box.hidden = false;
}
function hideError(boxId) {
  const box = el(boxId);
  if (box) box.hidden = true;
}

/* ---------- Navigation ---------- */

const SCREENS = ['setup', 'load-error', 'login', 'home', 'scan', 'unknown-code',
  'container', 'item', 'item-form', 'container-form', 'search', 'categories',
  'category-items', 'label', 'settings', 'all-items', 'shelves', 'shelf', 'shelf-form'];

let navStack = [];       // entries: { screen, title }
let currentScreen = null;

function showScreen(name) {
  for (const s of SCREENS) {
    const node = el('screen-' + s);
    if (node) node.hidden = (s !== name);
  }
  currentScreen = name;
  el('btn-back').style.visibility = navStack.length ? 'visible' : 'hidden';
  window.scrollTo(0, 0);
  updateBottomNav();
}

/* Bottom navigation: which tab is active for each screen, and hide the
 * bar entirely on the sign-in / setup / error screens. */
const NAV_MAP = {
  home: 'home', container: 'home', item: 'home', label: 'home', 'unknown-code': 'home',
  'item-form': 'pack', 'container-form': 'pack', scan: 'scan',
  search: 'browse', categories: 'browse', 'category-items': 'browse', settings: 'settings',
  'all-items': 'browse', shelves: 'browse', shelf: 'browse', 'shelf-form': 'browse',
};

function updateBottomNav() {
  const nav = el('bottom-nav');
  if (!nav) return;
  nav.hidden = ['login', 'setup', 'load-error'].includes(currentScreen);
  const active = NAV_MAP[currentScreen] || null;
  nav.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.nav === active);
  });
}

function go(name, opts) {
  opts = opts || {};
  if (currentScreen && !opts.replace) {
    navStack.push({ screen: currentScreen, title: document.title });
  }
  if (opts.clearStack) navStack = [];
  if (currentScreen === 'scan') stopScanner();
  showScreen(name);
  if (opts.title) el('app-title').textContent = opts.title;
}

function goBack() {
  if (currentScreen === 'scan') stopScanner();
  const prev = navStack.pop();
  if (prev) {
    showScreen(prev.screen);
    if (prev.title) document.title = prev.title;
  } else {
    showScreen('home');
  }
  // Screens that need fresh data when we land back on them.
  if (currentScreen === 'home') renderHome();
  if (currentScreen === 'container' && state.currentContainerId) renderContainer();
  if (currentScreen === 'item' && state.currentItemId) renderItem();
  if (currentScreen === 'shelves') renderShelves();
  if (currentScreen === 'shelf' && state.currentShelfId) renderShelf();
  if (currentScreen === 'all-items') renderAllItems();
}

el('btn-back').addEventListener('click', goBack);
el('btn-signout').addEventListener('click', async () => {
  if (sb) await sb.auth.signOut();
  state.user = null;
  navStack = [];
  showScreen('login');
  el('btn-signout').hidden = true;
});

/* ---------- State ---------- */

const state = {
  user: null,
  containers: [],   // {id, code, display_code, name, location, note, label_color, photo_path, type, shelf_id, ...}
  items: [],        // {id, container_id, category_id, title, description, quantity, tags, photo_path, voice_note_path, categories:{name}}
  categories: [],   // {id, name}
  shelves: [],      // {id, code, display_code, name, voice_note_path}
  shelvesAvailable: false, // false until the shelves table exists (migration applied)
  currentContainerId: null,
  currentItemId: null,
  currentCategoryId: null,
  currentShelfId: null,
  currentLabelContainerId: null,
  dataLoadFailed: false,
  photoUrls: new Map(), // photo_path -> {url, expires}
};

function containerById(id) { return state.containers.find((c) => c.id === id) || null; }
function itemById(id) { return state.items.find((i) => i.id === id) || null; }
function categoryById(id) { return state.categories.find((c) => c.id === id) || null; }
function shelfById(id) { return state.shelves.find((s) => s.id === id) || null; }
function containersOnShelf(shelfId) {
  return state.containers.filter((c) => c.shelf_id === shelfId);
}
function itemsInContainer(containerId) {
  return state.items.filter((i) => i.container_id === containerId);
}
function normName(s) { return String(s || '').trim().toLowerCase(); }

/* ---------- Auth ---------- */

async function initAuth() {
  // Show the login screen immediately, before waiting for the session
  // check. Previously the screen stayed blank if getSession() stalled
  // or threw, because no screen was shown until it returned.
  showScreen('login');
  if (!sb) {
    uiText(el('load-error-text'), 'The database library did not start. Check your connection and reload the page.');
    showScreen('load-error');
    return;
  }
  let session = null;
  try {
    const { data } = await sb.auth.getSession();
    session = data && data.session ? data.session : null;
  } catch (e) {
    session = null;
  }
  state.user = session ? session.user : null;
  sb.auth.onAuthStateChange((_event, session) => {
    state.user = session ? session.user : null;
    if (state.user) {
      el('btn-signout').hidden = false;
      if (currentScreen === 'login' || !currentScreen) {
        navStack = [];
        showScreen('home');
        loadAll();
      }
    } else {
      el('btn-signout').hidden = true;
      if (currentScreen !== 'login' && currentScreen !== 'setup') {
        navStack = [];
        showScreen('login');
      }
    }
  });

  if (state.user) {
    el('btn-signout').hidden = false;
    showScreen('home');
    loadAll();
  } else {
    showScreen('login');
  }
}

let authMode = 'signin'; // 'signin' or 'signup'

function setAuthMode(mode) {
  authMode = mode;
  uiText(el('login-title'), mode === 'signup' ? 'Create account' : 'Sign in');
  uiText(el('login-sub'), mode === 'signup'
    ? 'Make your own account with your email and a password you choose.'
    : 'Sign in with your own account. Everyone sees only their own containers.');
  uiText(el('btn-login-submit'), mode === 'signup' ? 'Create account' : 'Sign in');
  uiText(el('btn-toggle-auth'), mode === 'signup' ? 'Back to sign in' : 'Create an account');
  el('login-password').setAttribute('autocomplete',
    mode === 'signup' ? 'new-password' : 'current-password');
  hideError('login-error');
  hideError('login-info');
}

el('btn-toggle-auth').addEventListener('click', () => {
  setAuthMode(authMode === 'signin' ? 'signup' : 'signin');
});

el('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError('login-error');
  hideError('login-info');
  const email = el('login-email').value.trim();
  const password = el('login-password').value;
  if (authMode === 'signup') {
    if (password.length < 6) {
      showError('login-error', 'Choose a password with at least 6 characters.');
      return;
    }
    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) {
      showError('login-error', 'Could not create the account: ' + error.message);
      return;
    }
    if (data && data.session) {
      // Signed in right away (no email confirmation step). onAuthStateChange takes us home.
      return;
    }
    // Email confirmation is on: the account exists but needs the emailed link first.
    showError('login-info', 'Account created. Check your email for a confirmation link, then sign in. Check spam if you do not see it.');
    setAuthMode('signin');
    return;
  }
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    showError('login-error', 'Could not sign in: ' + error.message +
      ' Check the email and password and try again.');
    return;
  }
  // onAuthStateChange takes us to the home screen.
});

/* ---------- Data loading ---------- */

async function loadAll() {
  state.dataLoadFailed = false;
  hideError('home-error');
  try {
    const [cRes, iRes, catRes] = await Promise.all([
      sb.from('containers').select('*').eq('user_id', state.user.id).order('name', { ascending: true }),
      sb.from('items').select('*, categories(name)').eq('user_id', state.user.id).order('title', { ascending: true }),
      sb.from('categories').select('*').eq('user_id', state.user.id).order('name', { ascending: true }),
    ]);
    if (cRes.error) throw cRes.error;
    if (iRes.error) throw iRes.error;
    if (catRes.error) throw catRes.error;
    state.containers = cRes.data || [];
    state.items = iRes.data || [];
    state.categories = catRes.data || [];
    // Shelves need the FindIt migration (supabase-migration-findit.sql).
    // Before it runs the table does not exist: keep the app working and
    // just show no shelves. select('*') only returns columns that exist,
    // so rows load fine either way.
    state.shelves = [];
    state.shelvesAvailable = false;
    try {
      const shRes = await sb.from('shelves').select('*').eq('user_id', state.user.id).order('name', { ascending: true });
      if (!shRes.error) {
        state.shelves = shRes.data || [];
        state.shelvesAvailable = true;
        await seedDefaultShelves();
      }
    } catch (e) { /* shelves table not there yet — ignore */ }
    renderHome();
  } catch (err) {
    // Never show an empty list as if no containers exist.
    state.dataLoadFailed = true;
    const box = el('home-error');
    box.innerHTML = '';
    const h = document.createElement('h2');
    uiText(h, 'Cannot reach your storage data');
    const p1 = document.createElement('p');
    uiText(p1, 'The app could not reach the shared database. Your containers are not gone — ' +
      'the Supabase project may be paused (free projects pause after a week with no use), ' +
      'or this phone may be offline.');
    const p2 = document.createElement('p');
    uiText(p2, 'To resume it: open the Supabase dashboard, pick the project, and click Resume project.');
    const a = document.createElement('a');
    a.href = 'https://supabase.com/dashboard';
    uiText(a, 'Open the Supabase dashboard');
    a.target = '_blank';
    a.rel = 'noopener';
    const p3 = document.createElement('p');
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'primary';
    uiText(retry, 'Try again');
    retry.addEventListener('click', loadAll);
    p3.appendChild(retry);
    box.append(h, p1, p2, a, p3);
    box.hidden = false;
    renderHome();
    console.error('loadAll failed', err);
  }
}

async function refreshData() {
  if (!state.user) return;
  await loadAll();
}

// First run after the FindIt migration: give each user Shelf 1, Shelf 2
// and Shelf 3, once per user. If the user later deletes all their shelves
// they stay deleted (the flag below remembers the seed happened).
async function seedDefaultShelves() {
  if (state.shelves.length > 0 || !state.user) return;
  const flag = 'findit-shelves-seeded-' + state.user.id;
  try {
    if (localStorage.getItem(flag)) return;
  } catch (e) { /* storage unavailable — still seed, best-effort */ }
  try {
    const rows = ['Shelf 1', 'Shelf 2', 'Shelf 3'].map((name, i) => ({
      code: 'SHF-' + (1001 + i),
      display_code: 'SHF-' + (1001 + i),
      name,
      user_id: state.user.id,
    }));
    const { error } = await sb.from('shelves').insert(rows);
    if (error) return;
    const { data } = await sb.from('shelves').select('*').eq('user_id', state.user.id).order('name', { ascending: true });
    if (data) state.shelves = data;
    try { localStorage.setItem(flag, '1'); } catch (e) { /* ignore */ }
  } catch (e) { /* seeding is best-effort — shelves stay empty */ }
}

function nextShelfCodeNumber() {
  let max = 1000;
  for (const s of state.shelves) {
    const m = String(s.display_code || '').match(/^SHF-(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

/* ---------- Photos (private bucket) ---------- */

async function photoUrl(path) {
  if (!path) return null;
  const cached = state.photoUrls.get(path);
  if (cached && cached.expires > Date.now() + 60000) return cached.url;
  const { data, error } = await sb.storage.from(PHOTO_BUCKET)
    .createSignedUrl(path, 3600);
  if (error || !data) return null;
  state.photoUrls.set(path, { url: data.signedUrl, expires: Date.now() + 3500 * 1000 });
  return data.signedUrl;
}

function photoImgTag(path, cls, name) {
  const img = document.createElement('img');
  img.className = cls;
  if (name) uiAttr(img, 'alt', 'Photo of {0}', [name]);
  else uiAttr(img, 'alt', 'Item photo');
  img.loading = 'lazy';
  if (!path) {
    img.classList.add('placeholder');
    uiAttr(img, 'alt', 'No photo');
    window.FindItI18n.setPhotoPlaceholder(img);
    return img;
  }
  img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#f0f0f0"/></svg>');
  photoUrl(path).then((url) => { if (url) img.src = url; });
  return img;
}

// Shrink a camera photo before upload so the 1 GB free storage lasts.
function compressPhoto(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const maxSide = 1000;
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Could not process the photo.'));
      }, 'image/jpeg', 0.8);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that photo.')); };
    img.src = url;
  });
}

// folder: 'items' (default) or e.g. 'containers/<container-id>'.
async function uploadPhoto(file, folder) {
  const blob = await compressPhoto(file);
  const dir = folder || 'items';
  const path = dir + '/' + (window.crypto.randomUUID ? window.crypto.randomUUID() : String(Date.now())) + '.jpg';
  const { error } = await sb.storage.from(PHOTO_BUCKET)
    .upload(path, blob, { contentType: 'image/jpeg', upsert: false });
  if (error) throw error;
  return path;
}

// Upload an item photo AFTER the item is already saved, then attach it
// to the row. Runs in the background so saving never waits on the photo
// upload, which is the slow part over a phone connection. The photo shows
// up in the container view once the upload lands.
async function uploadPhotoInBackground(itemId, file, oldPhotoPath, containerId) {
  try {
    const newPath = await uploadPhoto(file);
    const { error } = await sb.from('items').update({ photo_path: newPath })
      .eq('id', itemId).eq('user_id', state.user.id);
    if (error) throw error;
    if (oldPhotoPath && oldPhotoPath !== newPath) {
      await deletePhotoFile(oldPhotoPath);
    }
    const idx = state.items.findIndex((it) => it.id === itemId);
    if (idx >= 0) state.items[idx] = { ...state.items[idx], photo_path: newPath };
    // Show the photo right away if we are still looking at this container.
    if (state.currentContainerId === containerId) renderContainer();
  } catch (err) {
    console.error('Background photo upload failed', err);
    toast('Item saved, but the photo did not upload. Open the item and try the photo again.');
  }
}

async function deletePhotoFile(path) {
  if (!path) return;
  try {
    await sb.storage.from(PHOTO_BUCKET).remove([path]);
    state.photoUrls.delete(path);
  } catch (e) { console.warn('Could not delete photo file', e); }
}

/* ---------- Voice notes (items and shelves) ----------
 * Recorded with MediaRecorder in the browser, uploaded to the private
 * 'item-photos' bucket under voice-notes/<uuid>.<ext>. The bucket's
 * existing authenticated-only policies already cover that path, so no
 * storage change is needed. Playback uses a signed URL, like photos. */

function voiceNoteExt(blob) {
  const t = (blob && blob.type) || '';
  if (t.includes('mp4')) return 'mp4';
  if (t.includes('ogg')) return 'ogg';
  return 'webm';
}

async function uploadVoiceNote(blob) {
  const ext = voiceNoteExt(blob);
  const path = 'voice-notes/' + (window.crypto.randomUUID ? window.crypto.randomUUID() : String(Date.now())) + '.' + ext;
  const { error } = await sb.storage.from(PHOTO_BUCKET)
    .upload(path, blob, { contentType: blob.type || 'audio/webm', upsert: false });
  if (error) throw error;
  return path;
}

async function deleteVoiceNoteFile(path) {
  // Same private bucket and removal call as photos.
  await deletePhotoFile(path);
}

let activeVoiceRecorder = null; // {rec, btn, statusEl}

// One toggle for every voice-note Record button. Tapping Record starts;
// tapping again (or any other Record button) stops and hands the audio
// to onBlob. A denied microphone just toasts — nothing is saved.
async function toggleVoiceRecording(btn, statusEl, onBlob) {
  if (activeVoiceRecorder) {
    activeVoiceRecorder.rec.stop();
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    toast('Recording is not supported on this phone.');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    toast('Microphone is not available. Allow the microphone for this page, then try again.');
    return;
  }
  let rec;
  try {
    const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    toast('Recording is not supported on this phone.');
    return;
  }
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopUi = () => {
    stream.getTracks().forEach((t) => t.stop());
    activeVoiceRecorder = null;
    uiText(btn, '🎙 Record voice note');
    if (statusEl) uiText(statusEl, '');
  };
  rec.onstop = () => {
    stopUi();
    const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
    if (blob.size > 0) onBlob(blob);
  };
  rec.onerror = () => {
    stopUi();
    toast('Recording stopped with an error.');
  };
  activeVoiceRecorder = { rec, btn, statusEl };
  uiText(btn, '■ Stop recording');
  if (statusEl) uiText(statusEl, 'Recording… tap Stop when you are done.');
  rec.start();
}

// Show a voice note in an <audio> player: from a fresh recording (blob)
// or from a stored path (signed URL). Hides the player when there is none.
async function showVoiceNote(audioEl, blob, path) {
  if (!audioEl) return;
  if (blob) {
    audioEl.src = URL.createObjectURL(blob);
    audioEl.hidden = false;
    return;
  }
  if (path) {
    const url = await photoUrl(path);
    if (url) {
      audioEl.src = url;
      audioEl.hidden = false;
      return;
    }
  }
  audioEl.removeAttribute('src');
  audioEl.hidden = true;
}

/* ---------- Home / containers list ---------- */

function renderHome() {
  const list = el('containers-list');
  list.innerHTML = '';
  const count = el('home-count');
  if (state.dataLoadFailed) {
    el('home-empty').hidden = true;
    el('getting-started').hidden = true;
    uiText(count, '');
    return;
  }
  el('home-empty').hidden = state.containers.length > 0;
  el('getting-started').hidden = state.containers.length > 0;
  for (const c of state.containers) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'item-row';
    const dot = document.createElement('span');
    dot.className = 'color-dot';
    dot.style.background = c.label_color || '#00317e';
    const text = document.createElement('span');
    text.className = 'item-text';
    const title = document.createElement('div');
    title.className = 'title';
    title.dir = 'auto';
    title.textContent = c.name;
    const sub = document.createElement('div');
    sub.className = 'sub';
    const n = itemsInContainer(c.id).length;
    const details = [c.location, c.display_code].filter(Boolean).join('  ·  ');
    uiParts(sub, [details ? details + '  ·  ' : '', { ui: n + (n === 1 ? ' item' : ' items') }]);
    text.append(title, sub);
    btn.append(photoImgTag(c.photo_path, 'thumb', c.name), dot, text);
    btn.addEventListener('click', () => openContainer(c.id));
    li.appendChild(btn);
    list.appendChild(li);
  }
  const totalItems = state.items.length;
  uiText(count, state.containers.length + (state.containers.length === 1 ? ' container' : ' containers') +
    '  ·  ' + totalItems + (totalItems === 1 ? ' item' : ' items'));
}

el('btn-empty-scan').addEventListener('click', () => { scanReturn = 'home'; go('scan'); startScanner('lookup'); });
el('btn-new-container').addEventListener('click', () => openContainerForm('create'));
el('btn-empty-new').addEventListener('click', () => openContainerForm('create'));
el('btn-gs-create').addEventListener('click', () => openContainerForm('create'));

/* Bottom navigation (ElephantTrax-style layout, blue primary). */
el('nav-home').addEventListener('click', () => { navStack = []; go('home', { clearStack: true }); renderHome(); });
el('nav-pack').addEventListener('click', () => {
  if (state.containers.length) openItemForm('create');
  else openContainerForm('create');
});
el('nav-scan').addEventListener('click', () => { scanReturn = 'home'; go('scan'); startScanner('lookup'); });
el('nav-browse').addEventListener('click', () => { go('search'); renderSearch(); });
el('nav-settings').addEventListener('click', () => { renderSettings(); go('settings'); });

/* ---------- Scanning ---------- */

// scanMode: 'lookup' (scan to open a container) or 'sticker' (scan a sticker
// while creating a container). scanReturn: where the scan was started from.
let qrScanner = null;
let scannerRunning = false;
let scannerStarting = false;
let torchOn = false;
let scanMode = 'lookup';
let scanReturn = 'home';
let pendingStickerCode = null; // the raw scanned value; never shown on screen

function getVideoTrack() {
  const video = document.querySelector('#reader video');
  return video && video.srcObject ? video.srcObject.getVideoTracks()[0] : null;
}

async function torchOff() {
  if (!torchOn) return;
  torchOn = false;
  const btn = el('btn-torch');
  uiText(btn, 'Turn light on');
  try {
    const track = getVideoTrack();
    if (track) await track.applyConstraints({ advanced: [{ torch: false }] });
  } catch (e) { /* light already off or unavailable */ }
}

async function setupTorchButton() {
  const btn = el('btn-torch');
  btn.hidden = true;
  uiText(btn, 'Turn light on');
  torchOn = false;
  try {
    const track = getVideoTrack();
    if (!track || !track.getCapabilities) return;
    const caps = track.getCapabilities();
    if (!caps.torch) return; // Light not available on this phone: keep hidden.
    btn.hidden = false;
    btn.onclick = async () => {
      try {
        torchOn = !torchOn;
        await track.applyConstraints({ advanced: [{ torch: torchOn }] });
        uiText(btn, torchOn ? 'Turn light off' : 'Turn light on');
      } catch (e) {
        toast('The light is not available on this phone.');
        btn.hidden = true;
      }
    };
  } catch (e) { btn.hidden = true; }
}

function ensureScanner() {
  if (!qrScanner) qrScanner = new Html5Qrcode('reader');
  return qrScanner;
}

async function startScanner(mode) {
  scanMode = mode || 'lookup';
  el('scan-camera-error').hidden = true;
  el('btn-scan-again').hidden = true;
  uiText(el('scan-status'), '');
  el('btn-torch').hidden = true;
  torchOn = false;
  if (!window.Html5Qrcode) {
    el('scan-camera-error').hidden = false;
    uiText(el('scan-status'), 'The scanner could not load. Check your connection and try again.');
    return;
  }
  if (scannerRunning || scannerStarting) return;
  scannerStarting = true;
  try {
    const qr = ensureScanner();
    await qr.start(
      { facingMode: 'environment' },
      {
        fps: 10,
        qrbox: { width: 250, height: 250 },
        formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
      },
      onCodeScanned,
      () => { /* no code in this frame — ignore */ }
    );
    scannerRunning = true;
    scannerStarting = false;
    setupTorchButton();
  } catch (err) {
    scannerStarting = false;
    scannerRunning = false;
    el('scan-camera-error').hidden = false;
    uiText(el('scan-status'), 'Camera did not start. You can still take a photo of the code below.');
    console.warn('Camera start failed', err);
  }
}

async function stopScanner() {
  await torchOff();
  if (!qrScanner) return;
  if (scannerRunning) {
    try { await qrScanner.stop(); } catch (e) { /* already stopped */ }
  }
  scannerRunning = false;
  try { qrScanner.clear(); } catch (e) { /* nothing to clear */ }
}

el('btn-scan-retry').addEventListener('click', () => startScanner(scanMode));
el('btn-scan-again').addEventListener('click', () => startScanner(scanMode));

// Scan from a still photo instead of the live camera.
el('btn-scan-photo').addEventListener('click', () => el('input-scan-photo').click());
el('input-scan-photo').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  uiText(el('scan-status'), 'Reading the photo…');
  try {
    if (scannerRunning) await stopScanner();
    const qr = ensureScanner();
    const code = await qr.scanFile(file, true);
    onCodeScanned(code);
  } catch (err) {
    uiText(el('scan-status'), 'Could not read a code from that photo. Try again with a clearer, closer photo.');
    el('btn-scan-again').hidden = false;
    console.warn('Photo scan failed', err);
  }
});

async function onCodeScanned(code) {
  const value = String(code || '').trim();
  if (!value) return;
  await stopScanner();
  el('btn-scan-again').hidden = true;
  if (scanMode === 'sticker') {
    // Creating a container: keep the raw value behind the scenes only.
    pendingStickerCode = value;
    uiText(el('sticker-scan-status'), 'Sticker scanned — its code is saved. You do not need to type anything.');
    goBack(); // returns to the container form
    return;
  }
  // Lookup mode: open the container or shelf, or offer to create one
  // for this code.
  const found = state.containers.find((c) => c.code === value);
  if (found) {
    openContainer(found.id);
    return;
  }
  const foundShelf = state.shelves.find((s) => s.code === value);
  if (foundShelf) {
    openShelf(foundShelf.id);
    return;
  }
  pendingStickerCode = value;
  go('unknown-code');
}

el('btn-create-for-code').addEventListener('click', () => openContainerForm('for-code'));
el('btn-unknown-scan-again').addEventListener('click', () => { go('scan'); startScanner('lookup'); });
el('btn-unknown-home').addEventListener('click', () => { navStack = []; go('home', { clearStack: true }); renderHome(); });

/* ---------- Container view ---------- */

function openContainer(id) {
  state.currentContainerId = id;
  renderContainer();
  go('container');
}

function renderContainer() {
  const c = containerById(state.currentContainerId);
  if (!c) { go('home'); return; }
  el('container-name').textContent = c.name;
  el('container-color-dot').style.background = c.label_color || '#00317e';
  el('container-location').textContent = c.location || '';
  el('container-note').textContent = c.note || '';
  el('container-note').style.display = c.note ? '' : 'none';
  // Show the display code number, never a raw web address from a sticker.
  el('container-code').textContent = c.display_code || '';
  // Type (Box / Tote / Container) and shelf — the view tells you which
  // shelf to put the container back on.
  uiText(el('container-type'), c.type || 'Container');
  const shelf = c.shelf_id ? shelfById(c.shelf_id) : null;
  if (shelf) {
    window.FindItI18n.forgetText(el('container-shelf'));
    el('container-shelf').textContent = shelf.name;
  } else uiText(el('container-shelf'), 'No shelf assigned');
  const photoWrap = el('container-photo-wrap');
  photoWrap.innerHTML = '';
  if (c.photo_path) {
    const img = photoImgTag(c.photo_path, 'photo-big', c.name);
    img.addEventListener('click', async () => {
      const url = await photoUrl(c.photo_path);
      if (url) {
        el('dlg-photo-img').src = url;
        el('dlg-photo').showModal();
      }
    });
    photoWrap.appendChild(img);
    const hint = document.createElement('p');
    hint.className = 'small-text muted';
    uiText(hint, 'Tap the photo to see it bigger.');
    photoWrap.appendChild(hint);
  } else {
    const p = document.createElement('p');
    p.className = 'muted';
    uiText(p, 'No photo for this container.');
    photoWrap.appendChild(p);
  }
  const items = itemsInContainer(c.id);
  el('container-empty').hidden = items.length > 0;
  const list = el('items-list');
  list.innerHTML = '';
  for (const item of items) {
    const cat = categoryById(item.category_id);
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'item-row';
    btn.appendChild(photoImgTag(item.photo_path, 'thumb', item.title));
    const text = document.createElement('span');
    text.className = 'item-text';
    const title = document.createElement('div');
    title.className = 'title';
    title.dir = 'auto';
    title.textContent = item.title;
    const sub = document.createElement('div');
    sub.className = 'sub';
    uiParts(sub, [{ ui: 'Qty ' + item.quantity },
      (cat ? '  ·  ' + cat.name : ''),
      (item.tags && item.tags.length ? '  ·  ' + item.tags.join(', ') : '')]);
    text.append(title, sub);
    btn.append(text);
    btn.addEventListener('click', () => openItem(item.id));
    li.appendChild(btn);
    list.appendChild(li);
  }
}

el('btn-add-item').addEventListener('click', () => openItemForm('create', state.currentContainerId));
el('btn-container-label').addEventListener('click', () => openLabel(state.currentContainerId));
el('btn-edit-container').addEventListener('click', () => openContainerForm('edit', state.currentContainerId));
el('btn-delete-container').addEventListener('click', () => askDeleteContainer(state.currentContainerId));

/* ---------- QR label ---------- */

function qrSvgFor(code) {
  const qr = qrcode(0, 'M');
  qr.addData(code);
  qr.make();
  return qr.createSvgTag({ cellSize: 8, margin: 4, scalable: true });
}

// The label currently on screen: {kind: 'container' | 'shelf', code, name, displayCode}.
let currentLabel = null;

function openLabelFor(kind, id) {
  let code, name, displayCode;
  if (kind === 'shelf') {
    const s = shelfById(id);
    if (!s) return;
    code = s.code; name = s.name; displayCode = s.display_code || '';
  } else {
    const c = containerById(id);
    if (!c) return;
    state.currentLabelContainerId = id;
    code = c.code; name = c.name; displayCode = c.display_code || '';
  }
  currentLabel = { kind, code, name, displayCode };
  el('label-qr').innerHTML = qrSvgFor(code);
  el('label-name').textContent = name;
  el('label-code').textContent = displayCode;
  uiText(el('label-note'), kind === 'shelf'
    ? 'Cut the label out and stick it on the shelf. Re-printing always gives the same code.'
    : 'Cut the label out and stick it on top of the container. Re-printing always gives the same code.');
  go('label');
}

function openLabel(containerId) {
  openLabelFor('container', containerId);
}

function openShelfLabel(shelfId) {
  openLabelFor('shelf', shelfId);
}

el('btn-print-label').addEventListener('click', () => {
  if (!currentLabel) return;
  const area = el('print-area');
  area.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.innerHTML = qrSvgFor(currentLabel.code);
  const name = document.createElement('div');
  name.className = 'label-name';
  name.textContent = currentLabel.name;
  const code = document.createElement('div');
  code.className = 'label-code';
  code.textContent = currentLabel.displayCode;
  area.append(wrap, name, code);
  window.print();
});

// Shared label download for containers and shelves. Build the QR at a
// fixed, known size. The SVG must carry explicit width/height: a
// viewBox-only SVG gets a default 300x150 / 150x150 size when loaded as
// an image, so the canvas was sized wrong, the QR drew wider than the
// canvas (clipped on the right) and the text landed on top of it. Sizing
// everything from the module count removes the browser guesswork.
// (Nov 7, 2026 fix — do not change the sizing below.)
function downloadLabelFile(code, name, displayCode) {
  const qr = qrcode(0, 'M');
  qr.addData(code);
  qr.make();
  const cellSize = 8, margin = 4;
  const qrSize = qr.getModuleCount() * cellSize + margin * 2;
  const svgText = qr.createSvgTag({ cellSize, margin, scalable: false });
  const svgBlob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  const img = new Image();
  img.onload = () => {
    const pad = 40;
    const canvas = document.createElement('canvas');
    canvas.width = qrSize + pad * 2;
    canvas.height = qrSize + pad * 2 + 90;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, pad, pad, qrSize, qrSize);
    ctx.fillStyle = '#000000';
    ctx.textAlign = 'center';
    const fitFont = (text, basePx, weight) => {
      let px = basePx;
      ctx.font = (weight ? weight + ' ' : '') + px + 'px sans-serif';
      const maxW = canvas.width - pad;
      while (px > 12 && ctx.measureText(text).width > maxW) {
        px -= 2;
        ctx.font = (weight ? weight + ' ' : '') + px + 'px sans-serif';
      }
    };
    fitFont(name, 28, 'bold');
    ctx.fillText(name, canvas.width / 2, qrSize + pad + 34);
    fitFont(displayCode || '', 24, '');
    ctx.fillText(displayCode || '', canvas.width / 2, qrSize + pad + 68);
    canvas.toBlob((blob) => {
      if (!blob) { toast('Could not make the label file.'); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'label-' + (displayCode || 'label').replace(/[^A-Za-z0-9_-]/g, '') + '.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }, 'image/png');
    URL.revokeObjectURL(url);
  };
  img.onerror = () => { URL.revokeObjectURL(url); toast('Could not make the label file.'); };
  img.src = url;
}

el('btn-download-label').addEventListener('click', () => {
  if (!currentLabel) return;
  downloadLabelFile(currentLabel.code, currentLabel.name, currentLabel.displayCode);
});

/* ---------- Container form (create / edit / create-for-scanned-code) ---------- */

let containerFormMode = 'create'; // 'create' | 'edit' | 'for-code'
let containerFormId = null;
let selectedColor = LABEL_COLORS[0];
let containerFormPhotoFile = null;   // newly chosen photo (File)
let containerFormRemovePhoto = false;
let containerFormOldPhotoPath = null;

function nextCodeNumber(prefix) {
  let max = 1000;
  const re = new RegExp('^' + prefix + '-(\\d+)$');
  for (const c of state.containers) {
    const m = String(c.display_code || '').match(re);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

function renderColorPick() {
  const wrap = el('color-pick');
  wrap.innerHTML = '';
  for (const color of LABEL_COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.style.background = color;
    b.setAttribute('aria-pressed', color === selectedColor ? 'true' : 'false');
    uiAttr(b, 'aria-label', 'Label colour ' + color);
    b.addEventListener('click', () => {
      selectedColor = color;
      renderColorPick();
    });
    wrap.appendChild(b);
  }
}

function openContainerForm(mode, containerId) {
  containerFormMode = mode;
  containerFormId = containerId || null;
  hideError('container-form-error');
  const form = el('form-container');
  form.reset();
  selectedColor = LABEL_COLORS[0];
  renderColorPick();
  containerFormPhotoFile = null;
  containerFormRemovePhoto = false;
  containerFormOldPhotoPath = null;
  el('container-photo-preview-wrap').hidden = true;
  el('container-photo-preview').src = '';
  el('btn-container-photo-remove').hidden = true;

  // Type picker (Box / Tote / Container) and shelf picker (optional).
  setContainerTypePick('Container');
  renderShelfSelect(null);

  const codeSource = el('container-code-source');
  const stickerWrap = el('sticker-scan-wrap');
  const status = el('sticker-scan-status');

  if (mode === 'edit') {
    const c = containerById(containerId);
    if (!c) return;
    uiText(el('container-form-title'), 'Edit storage');
    uiText(el('btn-save-container'), 'Save changes');
    codeSource.hidden = true; // the code never changes when editing
    el('container-name-input').value = c.name;
    el('container-location-input').value = c.location || '';
    el('container-note-input').value = c.note || '';
    selectedColor = c.label_color || LABEL_COLORS[0];
    renderColorPick();
    setContainerTypePick(c.type || 'Container');
    renderShelfSelect(c.shelf_id || null);
    containerFormOldPhotoPath = c.photo_path || null;
    if (c.photo_path) {
      el('container-photo-preview-wrap').hidden = false;
      photoUrl(c.photo_path).then((url) => { if (url) el('container-photo-preview').src = url; });
      el('btn-container-photo-remove').hidden = false;
    }
  } else if (mode === 'for-code') {
    uiText(el('container-form-title'), 'Add storage for this code');
    uiText(el('btn-save-container'), 'Add storage');
    codeSource.hidden = true;
    uiText(status, 'The code from the sticker you scanned is saved. You do not need to type anything.');
    stickerWrap.hidden = false;
  } else {
    uiText(el('container-form-title'), 'Add new storage');
    uiText(el('btn-save-container'), 'Add storage');
    codeSource.hidden = false;
    pendingStickerCode = null;
    stickerWrap.hidden = true;
    uiText(status, 'No sticker scanned yet. Tap below to scan it with the camera.');
  }
  updateContainerPackSteps();
  go('container-form');
}

// Storage type radios: Box / Tote / Container only — no custom type.
function setContainerTypePick(type) {
  document.querySelectorAll('input[name="container-type"]').forEach((r) => {
    r.checked = r.value === (type || 'Container');
  });
}
function getContainerTypePick() {
  const checked = document.querySelector('input[name="container-type"]:checked');
  const v = checked ? checked.value : 'Container';
  return ['Box', 'Tote', 'Container'].includes(v) ? v : 'Container';
}

// Shelf picker in the container form. Blank means "no shelf".
function renderShelfSelect(selectedShelfId) {
  const sel = el('container-shelf-select');
  sel.innerHTML = '';
  const blank = document.createElement('option');
  blank.value = '';
  uiText(blank, 'No shelf');
  sel.appendChild(blank);
  for (const s of state.shelves) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.name;
    sel.appendChild(o);
  }
  sel.value = selectedShelfId || '';
  sel.disabled = !state.shelvesAvailable;
  if (!state.shelvesAvailable) uiText(blank, 'No shelf (shelves need the update)');
}
function getContainerShelfPick() {
  return el('container-shelf-select').value || null;
}

function onContainerPhotoChosen(file) {
  if (!file) return;
  containerFormPhotoFile = file;
  containerFormRemovePhoto = false;
  const url = URL.createObjectURL(file);
  el('container-photo-preview').src = url;
  el('container-photo-preview-wrap').hidden = false;
  el('btn-container-photo-remove').hidden = false;
  updateContainerPackSteps();
}
el('btn-container-photo-camera').addEventListener('click', () => el('input-container-photo-camera').click());
el('btn-container-photo-gallery').addEventListener('click', () => el('input-container-photo-gallery').click());
el('input-container-photo-camera').addEventListener('change', (e) => { onContainerPhotoChosen(e.target.files[0]); e.target.value = ''; });
el('input-container-photo-gallery').addEventListener('change', (e) => { onContainerPhotoChosen(e.target.files[0]); e.target.value = ''; });
el('btn-container-photo-remove').addEventListener('click', () => {
  containerFormPhotoFile = null;
  containerFormRemovePhoto = true;
  el('container-photo-preview').src = '';
  el('container-photo-preview-wrap').hidden = true;
  el('btn-container-photo-remove').hidden = true;
  updateContainerPackSteps();
});

el('code-source-generate').addEventListener('change', () => {
  el('sticker-scan-wrap').hidden = true;
});
el('code-source-sticker').addEventListener('change', () => {
  el('sticker-scan-wrap').hidden = false;
});
el('btn-scan-sticker').addEventListener('click', () => {
  scanReturn = 'container-form';
  go('scan');
  startScanner('sticker');
});
el('btn-cancel-container').addEventListener('click', () => goBack());

// The FindIt columns (containers.type / shelf_id, items.voice_note_path)
// need the migration (supabase-migration-findit.sql). If a save runs
// before it is applied, PostgREST rejects the unknown columns — retry
// without them so the container/item still saves instead of failing.
function isMissingColumnError(err) {
  const msg = String((err && err.message) || err || '');
  return /Could not find the .* column/i.test(msg) || /column .* does not exist/i.test(msg);
}

async function insertContainerRow(row) {
  let res = await sb.from('containers').insert(row).select('id').single();
  if (res.error && isMissingColumnError(res.error)) {
    const { type, shelf_id, ...legacy } = row;
    res = await sb.from('containers').insert(legacy).select('id').single();
    if (!res.error) toast('Saved — type and shelf need the database update to stick.');
  }
  return res;
}

async function updateContainerRow(id, patch) {
  let res = await sb.from('containers').update(patch).eq('id', id).eq('user_id', state.user.id);
  if (res.error && isMissingColumnError(res.error)) {
    const { type, shelf_id, ...legacy } = patch;
    res = await sb.from('containers').update(legacy).eq('id', id).eq('user_id', state.user.id);
    if (!res.error) toast('Saved — type and shelf need the database update to stick.');
  }
  return res;
}

async function saveItemRow(mode, id, row) {
  let res;
  if (mode === 'edit') {
    res = await sb.from('items').update(row).eq('id', id).eq('user_id', state.user.id).select();
  } else {
    res = await sb.from('items').insert(row).select();
  }
  if (res.error && isMissingColumnError(res.error)) {
    const { voice_note_path, ...legacy } = row;
    if (mode === 'edit') {
      res = await sb.from('items').update(legacy).eq('id', id).eq('user_id', state.user.id).select();
    } else {
      res = await sb.from('items').insert(legacy).select();
    }
    if (!res.error) toast('Item saved, but the voice note needs the database update.');
  }
  return res;
}

el('form-container').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError('container-form-error');
  const name = el('container-name-input').value.trim();
  const location = el('container-location-input').value.trim();
  const note = el('container-note-input').value.trim();
  const storageType = getContainerTypePick();
  const shelfId = getContainerShelfPick();
  if (!name) { showError('container-form-error', 'Give the container a name.'); return; }

  const btn = el('btn-save-container');
  btn.disabled = true;
  try {
    if (containerFormMode === 'edit') {
      // Photo first, like the item form: a failed upload blocks the save
      // instead of leaving a half-saved container.
      let photoPath = containerFormOldPhotoPath;
      if (containerFormPhotoFile) {
        const newPath = await uploadPhoto(containerFormPhotoFile, 'containers/' + containerFormId);
        if (containerFormOldPhotoPath && containerFormOldPhotoPath !== newPath) {
          await deletePhotoFile(containerFormOldPhotoPath);
        }
        photoPath = newPath;
      } else if (containerFormRemovePhoto && containerFormOldPhotoPath) {
        await deletePhotoFile(containerFormOldPhotoPath);
        photoPath = null;
      }
      const { error } = await updateContainerRow(containerFormId, {
        name, location, note, label_color: selectedColor, photo_path: photoPath,
        type: storageType, shelf_id: shelfId,
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      await refreshData();
      toast('Container saved.');
      goBack();
      return;
    }

    let code, displayCode;
    if (containerFormMode === 'for-code') {
      if (!pendingStickerCode) throw new Error('No scanned code was saved. Scan the sticker again.');
      code = pendingStickerCode;
      displayCode = 'STK-' + nextCodeNumber('STK');
    } else if (el('code-source-sticker').checked) {
      if (!pendingStickerCode) {
        showError('container-form-error', 'Scan the sticker first — tap “Scan the sticker”.');
        return;
      }
      code = pendingStickerCode;
      displayCode = 'STK-' + nextCodeNumber('STK');
    } else {
      code = 'CNT-' + nextCodeNumber('CNT');
      displayCode = code;
    }

    const { data, error } = await insertContainerRow({
      code, display_code: displayCode, name, location, note, label_color: selectedColor,
      type: storageType, shelf_id: shelfId,
      user_id: state.user.id,
    });
    if (error) throw error;
    pendingStickerCode = null;
    // The photo path needs the container id, so it uploads after the
    // insert. A failed photo upload must not undo the container itself.
    let photoFailed = false;
    if (containerFormPhotoFile) {
      try {
        const newPath = await uploadPhoto(containerFormPhotoFile, 'containers/' + data.id);
        const { error: photoErr } = await sb.from('containers').update({
          photo_path: newPath, updated_at: new Date().toISOString(),
        }).eq('id', data.id).eq('user_id', state.user.id);
        if (photoErr) throw photoErr;
      } catch (photoErr) {
        console.error('Container photo upload failed', photoErr);
        photoFailed = true;
      }
    }
    await refreshData();
    toast(photoFailed ? 'Container created, but the photo could not be uploaded.' : 'Container created.');
    state.currentContainerId = data.id;
    renderContainer();
    openLabel(data.id);
  } catch (err) {
    console.error('Save container failed', err);
    showError('container-form-error', 'Could not save the container: ' + (err.message || err) +
      ' Nothing was saved — check the connection and try again.');
  } finally {
    btn.disabled = false;
  }
});

/* ---------- Delete a container (corrected rule) ----------
 * When a bucket still holds items, the app offers BOTH options:
 *  1) delete the whole bucket together with everything in it — asked for
 *     confirmation first, naming the bucket and how many items it holds,
 *     so a stray tap cannot wipe it. Whole-bucket deletion is NOT blocked.
 *  2) clear the items out first: move them all to another container, or
 *     remove them one by one from the container view — then delete the
 *     empty bucket. Nothing is ever deleted silently. */

let deleteTargetId = null;

function askDeleteContainer(containerId) {
  const c = containerById(containerId);
  if (!c) return;
  deleteTargetId = containerId;
  const n = itemsInContainer(containerId).length;
  uiText(el('dlg-delete-title'), 'Delete “' + c.name + '”?');
  uiText(el('dlg-delete-text'), n === 0
    ? 'This container is empty.'
    : 'This container holds ' + n + (n === 1 ? ' item.' : ' items.') +
      ' Choose what to do — nothing is deleted without you picking one of these.');
  uiText(el('dlg-delete-all'), n === 0
    ? 'Delete this container'
    : 'Delete the container and all ' + n + (n === 1 ? ' item' : ' items'));
  // Move-out option: only when the bucket holds items and another
  // container exists to move them to.
  const others = state.containers.filter((x) => x.id !== containerId);
  const moveWrap = el('dlg-move-out-wrap');
  moveWrap.hidden = n === 0 || others.length === 0;
  if (!moveWrap.hidden) {
    const sel = el('dlg-move-target');
    sel.innerHTML = '';
    for (const o of others) {
      const opt = document.createElement('option');
      opt.value = o.id;
      opt.textContent = o.name;
      sel.appendChild(opt);
    }
    uiText(el('dlg-move-all'), 'Move all ' + n + (n === 1 ? ' item' : ' items'));
  }
  el('dlg-delete-hint').hidden = n === 0;
  el('dlg-delete-container').showModal();
}

el('dlg-delete-cancel').addEventListener('click', () => el('dlg-delete-container').close());

el('dlg-delete-all').addEventListener('click', async () => {
  const c = containerById(deleteTargetId);
  if (!c) { el('dlg-delete-container').close(); return; }
  el('dlg-delete-container').close();
  const items = itemsInContainer(c.id);
  try {
    for (const item of items) {
      await deletePhotoFile(item.photo_path);
      await deleteVoiceNoteFile(item.voice_note_path);
    }
    await deletePhotoFile(c.photo_path);
    const { error } = await sb.from('containers').delete().eq('id', c.id).eq('user_id', state.user.id);
    if (error) throw error;
    await refreshData();
    toast('Container deleted.');
    navStack = [];
    go('home', { clearStack: true });
    renderHome();
  } catch (err) {
    console.error('Delete container failed', err);
    toast('Could not delete the container: ' + (err.message || err));
  }
});

el('dlg-move-all').addEventListener('click', async () => {
  const c = containerById(deleteTargetId);
  const target = containerById(el('dlg-move-target').value);
  if (!c || !target) { el('dlg-delete-container').close(); return; }
  const items = itemsInContainer(c.id);
  const btn = el('dlg-move-all');
  btn.disabled = true;
  try {
    // Move every item out in one update. Category, photo, title and
    // quantity are untouched — only the container changes.
    const { error } = await sb.from('items').update({
      container_id: target.id, updated_at: new Date().toISOString(),
    }).eq('container_id', c.id).eq('user_id', state.user.id);
    if (error) throw error;
    await refreshData();
    el('dlg-delete-container').close();
    toast('All ' + items.length + (items.length === 1 ? ' item' : ' items') +
      ' moved to “' + target.name + '”. The container is now empty — tap Delete again to remove it.');
    renderContainer();
  } catch (err) {
    console.error('Move items failed', err);
    toast('Could not move the items: ' + (err.message || err));
  } finally {
    btn.disabled = false;
  }
});

/* ---------- Generic confirm dialog ---------- */

function askConfirm(title, text, yesLabel) {
  return new Promise((resolve) => {
    const dlg = el('dlg-confirm');
    uiText(el('dlg-confirm-title'), title);
    uiText(el('dlg-confirm-text'), text);
    uiText(el('dlg-confirm-yes'), yesLabel || 'Yes');
    const onYes = () => { cleanup(); dlg.close(); resolve(true); };
    const onNo = () => { cleanup(); dlg.close(); resolve(false); };
    const cleanup = () => {
      el('dlg-confirm-yes').removeEventListener('click', onYes);
      el('dlg-confirm-no').removeEventListener('click', onNo);
      dlg.removeEventListener('close', onNo);
    };
    el('dlg-confirm-yes').addEventListener('click', onYes);
    el('dlg-confirm-no').addEventListener('click', onNo);
    dlg.addEventListener('close', onNo);
    dlg.showModal();
  });
}

/* ---------- Item details ---------- */

function openItem(id) {
  state.currentItemId = id;
  renderItem();
  go('item');
}

function renderItem() {
  const item = itemById(state.currentItemId);
  if (!item) { goBack(); return; }
  const c = containerById(item.container_id);
  const cat = categoryById(item.category_id);
  el('item-title').textContent = item.title;
  el('item-qty').value = item.quantity;
  el('item-description').textContent = item.description || '—';
  el('item-category').textContent = cat ? cat.name : '—';
  el('item-container').textContent = c ? c.name : '—';

  const wrap = el('item-photo-wrap');
  wrap.innerHTML = '';
  if (item.photo_path) {
    const img = photoImgTag(item.photo_path, 'photo-big', item.title);
    img.addEventListener('click', async () => {
      const url = await photoUrl(item.photo_path);
      if (url) {
        el('dlg-photo-img').src = url;
        el('dlg-photo').showModal();
      }
    });
    wrap.appendChild(img);
    const hint = document.createElement('p');
    hint.className = 'small-text muted';
    uiText(hint, 'Tap the photo to see it bigger.');
    wrap.appendChild(hint);
  } else {
    const p = document.createElement('p');
    p.className = 'muted';
    uiText(p, 'No photo for this item.');
    wrap.appendChild(p);
  }

  const tagsBox = el('item-tags');
  tagsBox.innerHTML = '';
  if (item.tags && item.tags.length) {
    for (const tag of item.tags) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'badge';
      chip.dir = 'auto';
      chip.textContent = tag;
      chip.addEventListener('click', () => {
        go('search');
        el('search-input').value = tag;
        renderSearch();
      });
      tagsBox.appendChild(chip);
    }
  } else {
    tagsBox.textContent = '—';
  }
  renderItemVoiceNote(item);
}

function renderItemVoiceNote(item) {
  const player = el('item-voice-player');
  const none = el('item-voice-none');
  const delBtn = el('btn-item-voice-delete');
  if (item.voice_note_path) {
    none.hidden = true;
    delBtn.hidden = false;
    showVoiceNote(player, null, item.voice_note_path);
  } else {
    player.hidden = true;
    player.removeAttribute('src');
    none.hidden = false;
    delBtn.hidden = true;
  }
  uiText(el('item-voice-status'), '');
}

el('dlg-photo-close').addEventListener('click', () => el('dlg-photo').close());
el('btn-edit-item').addEventListener('click', () => openItemForm('edit', null, state.currentItemId));
el('btn-remove-item').addEventListener('click', () => removeItem(state.currentItemId));

// Voice note on the item detail view: record/replace or delete it here.
el('btn-item-voice-record').addEventListener('click', () => {
  const item = itemById(state.currentItemId);
  if (!item) return;
  toggleVoiceRecording(el('btn-item-voice-record'), el('item-voice-status'), async (blob) => {
    try {
      const newPath = await uploadVoiceNote(blob);
      if (item.voice_note_path) await deleteVoiceNoteFile(item.voice_note_path);
      const { error } = await sb.from('items').update({
        voice_note_path: newPath, updated_at: new Date().toISOString(),
      }).eq('id', item.id).eq('user_id', state.user.id);
      if (error) throw error;
      await refreshData();
      renderItem();
      toast('Voice note saved.');
    } catch (err) {
      console.error('Save voice note failed', err);
      toast('Could not save the voice note: ' + (err.message || err));
    }
  });
});
el('btn-item-voice-delete').addEventListener('click', async () => {
  const item = itemById(state.currentItemId);
  if (!item || !item.voice_note_path) return;
  try {
    await deleteVoiceNoteFile(item.voice_note_path);
    const { error } = await sb.from('items').update({
      voice_note_path: null, updated_at: new Date().toISOString(),
    }).eq('id', item.id).eq('user_id', state.user.id);
    if (error) throw error;
    await refreshData();
    renderItem();
    toast('Voice note deleted.');
  } catch (err) {
    console.error('Delete voice note failed', err);
    toast('Could not delete the voice note: ' + (err.message || err));
  }
});

async function removeItem(itemId) {
  const item = itemById(itemId);
  if (!item) return;
  const ok = await askConfirm('Remove this item?',
    'Remove “' + item.title + '” from its container? Its photo will be removed too.',
    'Yes, remove it');
  if (!ok) return;
  try {
    await deletePhotoFile(item.photo_path);
    await deleteVoiceNoteFile(item.voice_note_path);
    const { error } = await sb.from('items').delete().eq('id', item.id).eq('user_id', state.user.id);
    if (error) throw error;
    await refreshData();
    toast('Item removed.');
    goBack();
  } catch (err) {
    console.error('Delete item failed', err);
    toast('Could not remove the item: ' + (err.message || err));
  }
}

async function setQuantity(itemId, qty) {
  const item = itemById(itemId);
  if (!item) return;
  if (qty <= 0) {
    const ok = await askConfirm('Take the last one out?',
      '“' + item.title + '” will reach zero and leave the container.',
      'Yes, take it out');
    if (!ok) { renderItem(); return; }
    await removeItem(itemId);
    return;
  }
  const { error } = await sb.from('items').update({
    quantity: qty, updated_at: new Date().toISOString(),
  }).eq('id', itemId).eq('user_id', state.user.id);
  if (error) { toast('Could not change the quantity: ' + error.message); renderItem(); return; }
  await refreshData();
  renderItem();
}

el('btn-qty-minus').addEventListener('click', () => {
  const item = itemById(state.currentItemId);
  if (item) setQuantity(item.id, item.quantity - 1);
});
el('btn-qty-plus').addEventListener('click', () => {
  const item = itemById(state.currentItemId);
  if (item) setQuantity(item.id, item.quantity + 1);
});
el('item-qty').addEventListener('change', () => {
  const item = itemById(state.currentItemId);
  if (!item) return;
  const v = parseInt(el('item-qty').value, 10);
  if (Number.isNaN(v) || v < 0) { renderItem(); return; }
  setQuantity(item.id, v);
});

/* ---------- Categories ---------- */

async function getOrCreateCategory(name) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Category name is empty.');
  const existing = state.categories.find((c) => normName(c.name) === normName(clean));
  if (existing) return existing;
  const { data, error } = await sb.from('categories')
    .insert({ name: clean, user_id: state.user.id }).select('*').single();
  if (error) {
    // Another phone may have created it at the same moment — re-use it.
    const again = state.categories.find((c) => normName(c.name) === normName(clean));
    if (again) return again;
    const { data: refetched } = await sb.from('categories').select('*').eq('user_id', state.user.id);
    const found = (refetched || []).find((c) => normName(c.name) === normName(clean));
    if (found) { state.categories = refetched; return found; }
    throw error;
  }
  state.categories.push(data);
  return data;
}

/* ---------- AI suggestion (Gemini, item form only) ----------
 * A "Suggest" button appears in the item form when it has a photo.
 * Tapping it sends the photo straight to Google Gemini from the browser
 * (gemini-3.1-flash-lite) — no server function in between, because
 * the Netlify function was too slow (every call hit its 30s limit).
 * The key is a browser key restricted by HTTP referrer to this site, so
 * it only works from here. It fills in the title, category and a short
 * description as editable suggestions. The photo is shrunk first, the
 * same way it is before upload. Nothing is automatic: no guessing on
 * photo pick, nothing on QR scan. If Gemini cannot be reached or cannot
 * guess, the button just stops — the fields stay exactly as typed. */

// The key is injected at deploy time from the GitHub repo secret
// GEMINI_API_KEY (never hardcode a real key here — a hardcoded key ends
// up in the public repo and Google revokes it). The deploy workflow
// replaces __GEMINI_API_KEY__ with the secret value.
const GEMINI_API_KEY = '__GEMINI_API_KEY__';
const GEMINI_MODEL = 'gemini-3.1-flash-lite';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent';
const GEMINI_PROMPT =
  'Look at this photo of one stored item and reply with JSON only, no other text: ' +
  '{"title": "a short title, a few words, naming the item", ' +
  '"category": "one short category word, like Tools, Kitchen, Toys, or Clothing", ' +
  '"description": "one short sentence describing the item"}. ' +
  'Write the title and description in the same language as any visible text on the item, otherwise English. ' +
  'If you cannot tell what it is, use your best guess and keep it short.';

let categoryTouched = false;
let titleEdited = false; // user typed in the title field this session
let descEdited = false;  // user typed in the description field this session

// Match a suggested category against the user's existing categories:
// exact match first (case-insensitive), then a word in the suggestion
// that appears in an existing category name.
function matchCategoryFor(suggested) {
  const clean = String(suggested || '').trim();
  if (!clean) return null;
  const lower = clean.toLowerCase();
  for (const cat of state.categories) {
    if (cat.name.toLowerCase() === lower) return { existingId: cat.id, name: cat.name };
  }
  const words = lower.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  for (const cat of state.categories) {
    const name = cat.name.toLowerCase();
    if (words.some((w) => name.includes(w))) return { existingId: cat.id, name: cat.name };
  }
  return null;
}

// Read a photo (File/Blob, or an already-saved photo fetched by URL) as
// base64 plus its mime type, ready to send to the suggestion function.
function photoToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
      if (!m) { reject(new Error('Could not read the photo.')); return; }
      resolve({ imageBase64: m[2], mimeType: m[1] });
    };
    reader.onerror = () => reject(new Error('Could not read the photo.'));
    reader.readAsDataURL(file);
  });
}

// Bound the request and response body, and preserve Google's actual error.
async function fetchGeminiJson(url, options) {
  const controller = new AbortController();
  const parentSignal = options.signal;
  const forwardAbort = () => controller.abort();
  if (parentSignal) {
    parentSignal.throwIfAborted();
    parentSignal.addEventListener('abort', forwardAbort, { once: true });
  }
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error('Gemini request timed out after 30 seconds. Please try again.'));
      controller.abort();
    }, 30000);
  });
  try {
    return await Promise.race([
      (async () => {
        const res = await fetch(url, { ...options, signal: controller.signal });
        const raw = await res.text();
        let data = null;
        try { data = JSON.parse(raw); } catch (_) { /* Report non-JSON errors below. */ }
        if (!res.ok) {
          const reason = data && data.error && typeof data.error.message === 'string'
            ? data.error.message
            : data && typeof data.error === 'string' ? data.error
            : data && typeof data.message === 'string' ? data.message
            : raw.trim() || res.statusText || 'Google returned an empty error response.';
          throw new Error('Gemini HTTP ' + res.status + ': ' + reason);
        }
        if (!data) throw new Error('Gemini HTTP ' + res.status + ': Google returned an unreadable response.');
        return data;
      })(),
      deadline,
    ]);
  } finally {
    clearTimeout(timeout);
    if (parentSignal) parentSignal.removeEventListener('abort', forwardAbort);
    controller.abort();
  }
}

// Ask Gemini directly for a title/category/description for one photo.
// payload is { imageBase64, mimeType }. Returns { title, category,
// description }; throws when it cannot guess, so the caller just stops.
async function guessFromPhoto(payload, signal) {
  if (!GEMINI_API_KEY) throw new Error('No API key.');
  signal.throwIfAborted();
  const data = await fetchGeminiJson(GEMINI_URL + '?key=' + encodeURIComponent(GEMINI_API_KEY), {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { inlineData: { mimeType: payload.mimeType, data: payload.imageBase64 } },
            { text: GEMINI_PROMPT },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        // Allow room for Gemini's reasoning as well as the final JSON.
        // A 200-token cap can truncate the reply before it contains a title.
        maxOutputTokens: 2048,
      },
    }),
  });
  const candidate = data.candidates && data.candidates[0];
  if (candidate && candidate.finishReason === 'MAX_TOKENS') {
    throw new Error('Gemini cut the suggestion short. Please try again.');
  }
  if (data.promptFeedback && data.promptFeedback.blockReason) {
    throw new Error('Gemini could not process this photo. Try a different photo.');
  }
  const parts = candidate && candidate.content && candidate.content.parts;
  const text = Array.isArray(parts)
    ? parts.filter((part) => !part.thought && typeof part.text === 'string')
      .map((part) => part.text).join('')
    : '';
  let parsed = null;
  if (text) {
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    try { parsed = JSON.parse(cleaned); } catch (err) { parsed = null; }
  }
  const title = parsed && typeof parsed.title === 'string' ? parsed.title.trim() : '';
  const category = parsed && typeof parsed.category === 'string' ? parsed.category.trim() : '';
  const description = parsed && typeof parsed.description === 'string' ? parsed.description.trim() : '';
  if (!title) throw new Error('Gemini did not return a usable suggestion. Try a clearer photo.');
  return { title, category, description };
}

async function runAiSuggest() {
  const btn = el('btn-ai-suggest');
  const status = el('ai-suggest-status');
  if (btn.disabled || (!itemFormPhotoFile && !itemFormOldPhotoPath)) return;
  btn.disabled = true;
  uiText(status, 'Guessing…');
  const controller = new AbortController();
  let timeout;
  try {
    // Bound the entire operation, including photo preparation and download.
    // Only the winning result may update fields, so late replies are ignored.
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error('Photo suggestions timed out after 30 seconds. Try again or enter the details yourself.'));
        controller.abort();
      }, 30000);
    });
    const suggestion = (async () => {
      let payload;
      if (itemFormPhotoFile) {
        const small = await compressPhoto(itemFormPhotoFile);
        payload = await photoToBase64(small);
      } else {
        const url = await photoUrl(itemFormOldPhotoPath);
        if (!url) throw new Error('No photo to look at.');
        controller.signal.throwIfAborted();
        const resp = await fetch(url, { signal: controller.signal });
        if (!resp.ok) throw new Error('Could not read the photo.');
        payload = await photoToBase64(await resp.blob());
      }
      return guessFromPhoto(payload, controller.signal);
    })();
    const { title, category, description } = await Promise.race([suggestion, deadline]);
    // Fill what the user has not typed in this session. A fresh guess
    // replaces a previous guess, so tapping Suggest again re-guesses —
    // including on an old item being edited, where the saved title and
    // description start out filled in. Anything the user types by hand
    // is left alone. Everything stays editable.
    if (!titleEdited) el('item-title-input').value = title;
    if (!descEdited && description) {
      el('item-desc-input').value = description;
    }
    if (!categoryTouched && category) {
      const match = matchCategoryFor(category);
      if (match) {
        el('item-category-select').value = match.existingId;
        el('new-category-wrap').hidden = true;
      } else {
        el('item-category-select').value = '__new__';
        el('new-category-wrap').hidden = false;
        el('item-new-category').value = category;
      }
    }
    uiText(status, 'Suggested: ' + title + ' — change anything before saving.');
    updateItemPackSteps();
  } catch (err) {
    // Keep fields as typed and leave the reason visible after the toast fades.
    const message = err instanceof TypeError
      ? 'Could not reach photo suggestions. Check your connection and try again.'
      : (err && err.message) || 'Could not guess from the photo — you can type it in instead.';
    uiText(status, message);
    toast(message);
  } finally {
    clearTimeout(timeout);
    controller.abort();
    btn.disabled = false;
  }
}

el('btn-ai-suggest').addEventListener('click', runAiSuggest);

// The Suggest button only shows when the item form has a photo.
function updateAiSuggestVisibility() {
  const hasPhoto = !!itemFormPhotoFile || !!itemFormOldPhotoPath;
  el('ai-suggest-wrap').hidden = !hasPhoto;
  if (!hasPhoto) uiText(el('ai-suggest-status'), '');
}

/* ---------- Add / edit item ---------- */

let itemFormMode = 'create'; // 'create' | 'edit'
let itemFormId = null;
let itemFormPhotoFile = null;   // newly chosen photo (File)
let itemFormRemovePhoto = false;
let itemFormOldPhotoPath = null;
let itemFormVoiceBlob = null;    // newly recorded voice note (Blob)
let itemFormVoiceRemove = false; // user deleted the existing voice note
let itemFormOldVoicePath = null; // existing voice note path (edit mode)
let descDictation = null; // active speech recognition for the description mic, or null

/* Pack step indicator (Upload Image / Add Meta / Assign QR code).
 * Step 1 is done once a photo is picked; step 2 is then active.
 * Step 3 is completed by the container's QR label after saving. */
function setPackSteps(rootId, states) {
  const root = el(rootId);
  if (!root) return;
  root.querySelectorAll('.step').forEach((s, i) => {
    const st = states[i] || 'todo';
    s.classList.toggle('done', st === 'done');
    s.classList.toggle('active', st === 'active');
    const circle = s.querySelector('.step-circle');
    if (circle) circle.textContent = st === 'done' ? '✓' : String(i + 1);
  });
}

function updateItemPackSteps() {
  const hasPhoto = !!itemFormPhotoFile || !!itemFormOldPhotoPath;
  setPackSteps('item-pack-steps', hasPhoto ? ['done', 'active', 'todo'] : ['active', 'todo', 'todo']);
}

function updateContainerPackSteps() {
  const hasPhoto = !!containerFormPhotoFile || !!containerFormOldPhotoPath;
  setPackSteps('container-pack-steps', hasPhoto ? ['done', 'active', 'todo'] : ['active', 'todo', 'todo']);
}

function openItemForm(mode, containerId, itemId) {
  itemFormMode = mode;
  itemFormId = itemId || null;
  itemFormPhotoFile = null;
  itemFormRemovePhoto = false;
  itemFormOldPhotoPath = null;
  itemFormVoiceBlob = null;
  itemFormVoiceRemove = false;
  itemFormOldVoicePath = null;
  categoryTouched = false;
  titleEdited = false;
  descEdited = false;
  if (descDictation) { descDictation.stop(); descDictation = null; }
  el('item-form-voice-player').hidden = true;
  el('item-form-voice-player').removeAttribute('src');
  el('btn-item-form-voice-delete').hidden = true;
  uiText(el('item-form-voice-status'), '');
  hideError('item-form-error');
  el('form-item').reset();
  el('item-photo-preview-wrap').hidden = true;
  el('item-photo-preview').src = '';
  el('btn-photo-remove').hidden = true;
  el('new-category-wrap').hidden = true;

  // Category picker: existing categories + make a new one on the spot.
  const catSel = el('item-category-select');
  catSel.innerHTML = '';
  const sorted = [...state.categories].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  for (const c of sorted) {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.name;
    catSel.appendChild(o);
  }
  const newOpt = document.createElement('option');
  newOpt.value = '__new__';
  uiText(newOpt, '+ New category…');
  catSel.appendChild(newOpt);

  // Container picker (defaults to the container the + was tapped from).
  const conSel = el('item-container-select');
  conSel.innerHTML = '';
  for (const c of state.containers) {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.name;
    conSel.appendChild(o);
  }

  if (mode === 'edit') {
    const item = itemById(itemId);
    if (!item) return;
    uiText(el('item-form-title'), 'Edit item');
    uiText(el('btn-save-item'), 'Save changes');
    el('item-title-input').value = item.title;
    el('item-desc-input').value = item.description || '';
    el('item-qty-input').value = item.quantity;
    catSel.value = item.category_id;
    conSel.value = item.container_id;
    el('item-tags-input').value = (item.tags || []).join(', ');
    itemFormOldPhotoPath = item.photo_path || null;
    if (item.photo_path) {
      el('item-photo-preview-wrap').hidden = false;
      photoUrl(item.photo_path).then((url) => { if (url) el('item-photo-preview').src = url; });
      el('btn-photo-remove').hidden = false;
    }
    itemFormOldVoicePath = item.voice_note_path || null;
    if (itemFormOldVoicePath) {
      showVoiceNote(el('item-form-voice-player'), null, itemFormOldVoicePath);
      el('btn-item-form-voice-delete').hidden = false;
    }
  } else {
    uiText(el('item-form-title'), 'Add an item');
    uiText(el('btn-save-item'), 'Save item');
    el('item-qty-input').value = 1;
    if (containerId) conSel.value = containerId;
  }
  // If "+ New category…" is already selected (no categories exist yet),
  // show the name box right away — picking it fires no change event,
  // so without this the first category could never be typed in.
  el('new-category-wrap').hidden = catSel.value !== '__new__';
  updateItemPackSteps();
  updateAiSuggestVisibility();
  go('item-form');
}

el('item-category-select').addEventListener('change', () => {
  categoryTouched = true;
  const isNew = el('item-category-select').value === '__new__';
  el('new-category-wrap').hidden = !isNew;
  if (isNew) el('item-new-category').focus();
});

// Typing by hand protects a field from being overwritten by Suggest.
el('item-title-input').addEventListener('input', () => { titleEdited = true; });
el('item-desc-input').addEventListener('input', () => { descEdited = true; });
el('item-new-category').addEventListener('input', () => { categoryTouched = true; });

// Dictation mic inside the description field: tap the mic, speak, and the
// words are typed into the description. Uses the browser's built-in speech
// recognition (Chrome on Android). Tap the mic again to stop. Anything
// dictated counts as typed by hand, so Suggest will not overwrite it.
el('btn-desc-dictate').addEventListener('click', () => {
  const btn = el('btn-desc-dictate');
  const desc = el('item-desc-input');
  if (descDictation) { descDictation.stop(); return; }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast('Speech typing is not available in this browser. Try Chrome.'); return; }
  const rec = new SR();
  rec.lang = navigator.language || 'en-US';
  rec.interimResults = false;
  rec.continuous = true;
  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (!e.results[i].isFinal) continue;
      const text = e.results[i][0].transcript.trim();
      if (!text) continue;
      desc.value = desc.value.trim() ? desc.value.trim() + ' ' + text : text;
      descEdited = true;
    }
  };
  rec.onend = () => {
    descDictation = null;
    btn.classList.remove('listening');
    btn.textContent = '🎙';
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed') toast('Microphone is not available. Allow the microphone for this page, then try again.');
    else if (e.error !== 'aborted' && e.error !== 'no-speech') toast('Speech typing stopped with an error.');
  };
  try {
    rec.start();
    descDictation = rec;
    btn.classList.add('listening');
    btn.textContent = '■';
  } catch (err) {
    toast('Speech typing is not available in this browser.');
  }
});

function onPhotoChosen(file) {
  if (!file) return;
  itemFormPhotoFile = file;
  itemFormRemovePhoto = false;
  const url = URL.createObjectURL(file);
  el('item-photo-preview').src = url;
  el('item-photo-preview-wrap').hidden = false;
  el('btn-photo-remove').hidden = false;
  updateItemPackSteps();
  updateAiSuggestVisibility();
}
el('btn-photo-camera').addEventListener('click', () => el('input-photo-camera').click());
el('btn-photo-gallery').addEventListener('click', () => el('input-photo-gallery').click());
el('input-photo-camera').addEventListener('change', (e) => { onPhotoChosen(e.target.files[0]); e.target.value = ''; });
el('input-photo-gallery').addEventListener('change', (e) => { onPhotoChosen(e.target.files[0]); e.target.value = ''; });
el('btn-photo-remove').addEventListener('click', () => {
  itemFormPhotoFile = null;
  itemFormRemovePhoto = true;
  el('item-photo-preview').src = '';
  el('item-photo-preview-wrap').hidden = true;
  el('btn-photo-remove').hidden = true;
  updateItemPackSteps();
  updateAiSuggestVisibility();
});

// Voice note in the item form: recorded now, uploaded when the item saves.
el('btn-item-form-voice-record').addEventListener('click', () => {
  toggleVoiceRecording(el('btn-item-form-voice-record'), el('item-form-voice-status'), (blob) => {
    itemFormVoiceBlob = blob;
    itemFormVoiceRemove = false;
    showVoiceNote(el('item-form-voice-player'), blob, null);
    el('btn-item-form-voice-delete').hidden = false;
  });
});
el('btn-item-form-voice-delete').addEventListener('click', () => {
  itemFormVoiceBlob = null;
  itemFormVoiceRemove = true;
  el('item-form-voice-player').hidden = true;
  el('item-form-voice-player').removeAttribute('src');
  el('btn-item-form-voice-delete').hidden = true;
});

el('btn-form-qty-minus').addEventListener('click', () => {
  const input = el('item-qty-input');
  input.value = Math.max(1, (parseInt(input.value, 10) || 1) - 1);
});
el('btn-form-qty-plus').addEventListener('click', () => {
  const input = el('item-qty-input');
  input.value = (parseInt(input.value, 10) || 1) + 1;
});
el('btn-cancel-item').addEventListener('click', () => goBack());

el('form-item').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError('item-form-error');
  const title = el('item-title-input').value.trim();
  const description = el('item-desc-input').value.trim();
  const qty = parseInt(el('item-qty-input').value, 10);
  const containerId = el('item-container-select').value;
  const tags = el('item-tags-input').value.split(',')
    .map((t) => t.trim()).filter(Boolean)
    .filter((t, i, arr) => arr.findIndex((x) => normName(x) === normName(t)) === i);

  if (!title) { showError('item-form-error', 'Give the item a title.'); return; }
  if (!Number.isInteger(qty) || qty < 1) { showError('item-form-error', 'Quantity must be a whole number of 1 or more.'); return; }
  if (!containerId) { showError('item-form-error', 'Pick a container for this item.'); return; }

  let categoryId;
  if (el('item-category-select').value === '__new__') {
    const newName = el('item-new-category').value.trim();
    if (!newName) { showError('item-form-error', 'Type a name for the new category, or pick an existing one.'); return; }
    try {
      const cat = await getOrCreateCategory(newName);
      categoryId = cat.id;
    } catch (err) {
      showError('item-form-error', 'Could not save the category: ' + (err.message || err));
      return;
    }
  } else {
    categoryId = el('item-category-select').value;
  }
  if (!categoryId) { showError('item-form-error', 'Every item needs a category.'); return; }

  const btn = el('btn-save-item');
  btn.disabled = true;
  // Save the item row FIRST so the save feels instant. The photo upload
  // is the slow part (it goes to storage over the phone's connection), so
  // it runs in the background and the photo appears once it lands.
  const photoFile = itemFormPhotoFile;
  const oldPhotoPath = itemFormOldPhotoPath;
  const removePhoto = itemFormRemovePhoto;
  const photoPath = itemFormMode === 'edit' ? oldPhotoPath : null;
  const finalPhotoPath = removePhoto ? null : photoPath;
  try {
    let voicePath = itemFormMode === 'edit' ? itemFormOldVoicePath : null;
    if (itemFormVoiceBlob) {
      const newVoicePath = await uploadVoiceNote(itemFormVoiceBlob);
      if (itemFormOldVoicePath && itemFormOldVoicePath !== newVoicePath) {
        await deleteVoiceNoteFile(itemFormOldVoicePath);
      }
      voicePath = newVoicePath;
    } else if (itemFormVoiceRemove && itemFormOldVoicePath) {
      await deleteVoiceNoteFile(itemFormOldVoicePath);
      voicePath = null;
    }

    const row = {
      container_id: containerId,
      category_id: categoryId,
      title,
      description,
      quantity: qty,
      tags,
      photo_path: finalPhotoPath,
      voice_note_path: voicePath,
      user_id: state.user.id,
      updated_at: new Date().toISOString(),
    };
    const res = await saveItemRow(itemFormMode, itemFormId, row);
    if (res.error) throw res.error;
    const saved = (res.data && res.data[0]) || { id: itemFormId };
    // Update the local list right away instead of reloading everything.
    const idx = state.items.findIndex((it) => it.id === saved.id);
    if (idx >= 0) state.items[idx] = { ...state.items[idx], ...saved };
    else state.items.push(saved);
    if (removePhoto && oldPhotoPath) deletePhotoFile(oldPhotoPath).catch(() => {});
    toast('Item saved.');
    state.currentContainerId = containerId;
    renderContainer();
    go('container', { replace: true });
    // Photo upload in the background: the item is already saved, the
    // photo shows up when the upload finishes.
    if (photoFile) {
      uploadPhotoInBackground(saved.id, photoFile, oldPhotoPath, containerId);
    }
  } catch (err) {
    console.error('Save item failed', err);
    showError('item-form-error', 'Could not save the item: ' + (err.message || err) +
      ' Nothing was saved — check the connection and try again.');
  } finally {
    btn.disabled = false;
  }
});

/* ---------- Search ---------- */

function searchMatches(query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  return state.items.filter((item) => {
    const cat = categoryById(item.category_id);
    const hay = [item.title, item.description, cat ? cat.name : '', (item.tags || []).join(' ')]
      .join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

function renderSearch() {
  const query = el('search-input').value;
  const status = el('search-status');
  const list = el('search-results');
  list.innerHTML = '';
  renderSearchChips();
  const matches = searchMatches(query);
  const idle = el('search-idle');
  const empty = el('search-empty');
  if (matches === null) {
    uiText(status, '');
    idle.hidden = false;
    empty.hidden = true;
    return;
  }
  idle.hidden = true;
  if (!matches.length) {
    uiText(status, '');
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  uiText(status, matches.length + (matches.length === 1 ? ' item found' : ' items found') +
    ' for “' + query.trim() + '”.');
  for (const item of matches) {
    list.appendChild(searchResultRow(item));
  }
}

// Category chips under the Browse search bar — tapping one opens that
// category's items.
function renderSearchChips() {
  const wrap = el('search-categories');
  if (!wrap) return;
  wrap.innerHTML = '';
  const counts = new Map();
  for (const item of state.items) {
    counts.set(item.category_id, (counts.get(item.category_id) || 0) + 1);
  }
  const cats = state.categories
    .filter((c) => counts.has(c.id))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  for (const cat of cats) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = cat.name + ' (' + counts.get(cat.id) + ')';
    b.addEventListener('click', () => {
      state.currentCategoryId = cat.id;
      renderCategoryItems();
      go('category-items');
    });
    wrap.appendChild(b);
  }
}

function searchResultRow(item) {
  const c = containerById(item.container_id);
  const cat = categoryById(item.category_id);
  const li = document.createElement('li');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'item-row';
  btn.appendChild(photoImgTag(item.photo_path, 'thumb', item.title));
  const text = document.createElement('span');
  text.className = 'item-text';
  const title = document.createElement('div');
  title.className = 'title';
  title.dir = 'auto';
  title.textContent = item.title;
  const sub = document.createElement('div');
  sub.className = 'sub';
  uiParts(sub, [{ ui: 'Qty ' + item.quantity },
    (c ? '  ·  ' + c.name : ''),
    (cat ? '  ·  ' + cat.name : '')]);
  text.append(title, sub);
  btn.append(text);
  btn.addEventListener('click', () => openContainer(item.container_id));
  li.appendChild(btn);
  return li;
}

el('search-input').addEventListener('input', renderSearch);
el('btn-search-filter').addEventListener('click', () => { go('categories'); renderCategories(); });

/* ---------- Browse by category ---------- */

function renderCategories() {
  const counts = new Map();
  for (const item of state.items) {
    counts.set(item.category_id, (counts.get(item.category_id) || 0) + 1);
  }
  const list = el('categories-list');
  list.innerHTML = '';
  const cats = state.categories
    .filter((c) => counts.has(c.id))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  el('categories-empty').hidden = cats.length > 0;
  for (const cat of cats) {
    const n = counts.get(cat.id);
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'item-row';
    const text = document.createElement('span');
    text.className = 'item-text';
    const title = document.createElement('div');
    title.className = 'title';
    title.dir = 'auto';
    title.textContent = cat.name;
    const sub = document.createElement('div');
    sub.className = 'sub';
    uiText(sub, n + (n === 1 ? ' item' : ' items'));
    text.append(title, sub);
    btn.append(text);
    btn.addEventListener('click', () => {
      state.currentCategoryId = cat.id;
      renderCategoryItems();
      go('category-items');
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
}

function renderCategoryItems() {
  const cat = categoryById(state.currentCategoryId);
  if (!cat) { go('categories'); return; }
  el('category-items-title').textContent = cat.name;
  const list = el('category-items-list');
  list.innerHTML = '';
  const items = state.items.filter((i) => i.category_id === cat.id);
  for (const item of items) {
    list.appendChild(searchResultRow(item));
  }
}

/* ---------- All items (from Settings) ---------- */

function renderAllItems() {
  const list = el('all-items-list');
  list.innerHTML = '';
  el('all-items-empty').hidden = state.items.length > 0;
  const sorted = [...state.items].sort((a, b) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  for (const item of sorted) {
    list.appendChild(searchResultRow(item));
  }
}

el('btn-all-items-search').addEventListener('click', () => { go('search'); renderSearch(); });

/* ---------- Shelves ---------- */

function renderShelves() {
  const list = el('shelves-list');
  list.innerHTML = '';
  el('shelves-empty').hidden = state.shelves.length > 0;
  for (const s of state.shelves) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'item-row';
    const text = document.createElement('span');
    text.className = 'item-text';
    const title = document.createElement('div');
    title.className = 'title';
    title.dir = 'auto';
    title.textContent = s.name;
    const sub = document.createElement('div');
    sub.className = 'sub';
    const n = containersOnShelf(s.id).length;
    uiParts(sub, [(s.display_code || '') + '  ·  ', { ui: n + (n === 1 ? ' container' : ' containers') }]);
    text.append(title, sub);
    btn.append(text);
    btn.addEventListener('click', () => openShelf(s.id));
    li.appendChild(btn);
    list.appendChild(li);
  }
}

function openShelf(id) {
  state.currentShelfId = id;
  renderShelf();
  go('shelf');
}

function renderShelf() {
  const s = shelfById(state.currentShelfId);
  if (!s) { go('shelves'); return; }
  el('shelf-name').textContent = s.name;
  el('shelf-code').textContent = s.display_code || '';
  renderShelfVoiceNote(s);
  const list = el('shelf-containers-list');
  list.innerHTML = '';
  const containers = containersOnShelf(s.id);
  el('shelf-empty').hidden = containers.length > 0;
  for (const c of containers) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'item-row';
    btn.appendChild(photoImgTag(c.photo_path, 'thumb', c.name));
    const text = document.createElement('span');
    text.className = 'item-text';
    const title = document.createElement('div');
    title.className = 'title';
    title.dir = 'auto';
    title.textContent = c.name;
    const sub = document.createElement('div');
    sub.className = 'sub';
    const n = itemsInContainer(c.id).length;
    const details = [c.location, c.display_code].filter(Boolean).join('  ·  ');
    uiParts(sub, [details ? details + '  ·  ' : '', { ui: n + (n === 1 ? ' item' : ' items') }]);
    text.append(title, sub);
    btn.append(text);
    btn.addEventListener('click', () => openContainer(c.id));
    li.appendChild(btn);
    list.appendChild(li);
  }
}

el('btn-new-shelf').addEventListener('click', () => openShelfForm('create'));
el('btn-shelf-label').addEventListener('click', () => openShelfLabel(state.currentShelfId));
el('btn-rename-shelf').addEventListener('click', () => openShelfForm('edit', state.currentShelfId));
el('btn-delete-shelf').addEventListener('click', () => deleteShelf(state.currentShelfId));

function renderShelfVoiceNote(s) {
  const player = el('shelf-voice-player');
  const delBtn = el('btn-shelf-voice-delete');
  if (s.voice_note_path) {
    delBtn.hidden = false;
    showVoiceNote(player, null, s.voice_note_path);
  } else {
    player.hidden = true;
    player.removeAttribute('src');
    delBtn.hidden = true;
  }
  uiText(el('shelf-voice-status'), '');
}

// Voice note on the shelf detail view: record/replace or delete it here.
el('btn-shelf-voice-record').addEventListener('click', () => {
  const s = shelfById(state.currentShelfId);
  if (!s) return;
  toggleVoiceRecording(el('btn-shelf-voice-record'), el('shelf-voice-status'), async (blob) => {
    try {
      const newPath = await uploadVoiceNote(blob);
      if (s.voice_note_path) await deleteVoiceNoteFile(s.voice_note_path);
      const { error } = await sb.from('shelves').update({
        voice_note_path: newPath, updated_at: new Date().toISOString(),
      }).eq('id', s.id).eq('user_id', state.user.id);
      if (error) throw error;
      await refreshData();
      renderShelf();
      toast('Voice note saved.');
    } catch (err) {
      console.error('Save shelf voice note failed', err);
      toast('Could not save the voice note: ' + (err.message || err));
    }
  });
});
el('btn-shelf-voice-delete').addEventListener('click', async () => {
  const s = shelfById(state.currentShelfId);
  if (!s || !s.voice_note_path) return;
  try {
    await deleteVoiceNoteFile(s.voice_note_path);
    const { error } = await sb.from('shelves').update({
      voice_note_path: null, updated_at: new Date().toISOString(),
    }).eq('id', s.id).eq('user_id', state.user.id);
    if (error) throw error;
    await refreshData();
    renderShelf();
    toast('Voice note deleted.');
  } catch (err) {
    console.error('Delete shelf voice note failed', err);
    toast('Could not delete the voice note: ' + (err.message || err));
  }
});

let shelfFormMode = 'create';
let shelfFormId = null;

function openShelfForm(mode, shelfId) {
  shelfFormMode = mode;
  shelfFormId = shelfId || null;
  hideError('shelf-form-error');
  el('form-shelf').reset();
  if (mode === 'edit') {
    const s = shelfById(shelfId);
    if (!s) return;
    uiText(el('shelf-form-title'), 'Rename shelf');
    uiText(el('btn-save-shelf'), 'Save name');
    el('shelf-name-input').value = s.name;
  } else {
    uiText(el('shelf-form-title'), 'Add a shelf');
    uiText(el('btn-save-shelf'), 'Add shelf');
  }
  go('shelf-form');
}

el('btn-cancel-shelf').addEventListener('click', () => goBack());

el('form-shelf').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError('shelf-form-error');
  const name = el('shelf-name-input').value.trim();
  if (!name) { showError('shelf-form-error', 'Give the shelf a name.'); return; }
  const btn = el('btn-save-shelf');
  btn.disabled = true;
  try {
    if (shelfFormMode === 'edit') {
      const { error } = await sb.from('shelves').update({
        name, updated_at: new Date().toISOString(),
      }).eq('id', shelfFormId).eq('user_id', state.user.id);
      if (error) throw error;
      await refreshData();
      toast('Shelf renamed.');
      goBack();
      return;
    }
    const n = nextShelfCodeNumber();
    const code = 'SHF-' + n;
    const { data, error } = await sb.from('shelves').insert({
      code, display_code: code, name, user_id: state.user.id,
    }).select('id').single();
    if (error) throw error;
    await refreshData();
    toast('Shelf added.');
    state.currentShelfId = data.id;
    renderShelf();
    go('shelf', { replace: true });
  } catch (err) {
    console.error('Save shelf failed', err);
    showError('shelf-form-error', 'Could not save the shelf: ' + (err.message || err));
  } finally {
    btn.disabled = false;
  }
});

async function deleteShelf(shelfId) {
  const s = shelfById(shelfId);
  if (!s) return;
  const n = containersOnShelf(shelfId).length;
  const ok = await askConfirm('Delete shelf “' + s.name + '”?',
    n === 0
      ? 'This shelf is empty. Its QR label will stop working.'
      : 'This shelf holds ' + n + (n === 1 ? ' container.' : ' containers.') +
        ' The containers stay — they just will not be on a shelf any more. The shelf’s QR label will stop working.',
    'Yes, delete it');
  if (!ok) return;
  try {
    await deletePhotoFile(s.voice_note_path);
    const { error } = await sb.from('shelves').delete().eq('id', shelfId).eq('user_id', state.user.id);
    if (error) throw error;
    await refreshData();
    toast('Shelf deleted.');
    navStack = [];
    go('shelves', { clearStack: true });
    renderShelves();
  } catch (err) {
    console.error('Delete shelf failed', err);
    toast('Could not delete the shelf: ' + (err.message || err));
  }
}

/* ---------- Settings ---------- */

function renderSettings() {
  el('settings-email').textContent = state.user ? state.user.email : '—';
  el('settings-count-containers').textContent = String(state.containers.length);
  el('settings-count-items').textContent = String(state.items.length);
  el('settings-count-categories').textContent = String(state.categories.length);
  el('settings-count-shelves').textContent = String(state.shelves.length);
  uiText(el('settings-textsize-value'), getTextSize() === 'large' ? 'On' : 'Off');
  uiText(el('settings-darkmode-value'), getDarkMode() ? 'On' : 'Off');
}

// "Your storage" rows are tappable: Containers opens the containers list,
// Items opens all items (with a search button at the top of that view),
// Categories opens all categories, Shelves opens the shelves list.
el('btn-settings-containers').addEventListener('click', () => { renderHome(); go('home'); });
el('btn-settings-items').addEventListener('click', () => { renderAllItems(); go('all-items'); });
el('btn-settings-categories').addEventListener('click', () => { renderCategories(); go('categories'); });
el('btn-settings-shelves').addEventListener('click', () => { renderShelves(); go('shelves'); });

/* ---------- Display preferences (Settings, persisted in localStorage) ---------- */

const PREF_TEXT_SIZE = 'findit-text-size'; // 'normal' | 'large'
const PREF_DARK_MODE = 'findit-dark-mode'; // '0' | '1'

function getTextSize() {
  try { return localStorage.getItem(PREF_TEXT_SIZE) === 'large' ? 'large' : 'normal'; }
  catch (e) { return 'normal'; }
}
function getDarkMode() {
  try { return localStorage.getItem(PREF_DARK_MODE) === '1'; }
  catch (e) { return false; }
}
function applyDisplayPrefs() {
  document.body.classList.toggle('text-large', getTextSize() === 'large');
  document.body.classList.toggle('dark', getDarkMode());
}

el('btn-settings-textsize').addEventListener('click', () => {
  const next = getTextSize() === 'large' ? 'normal' : 'large';
  try { localStorage.setItem(PREF_TEXT_SIZE, next); } catch (e) { /* ignore */ }
  applyDisplayPrefs();
  renderSettings();
});
el('btn-settings-darkmode').addEventListener('click', () => {
  const next = !getDarkMode();
  try { localStorage.setItem(PREF_DARK_MODE, next ? '1' : '0'); } catch (e) { /* ignore */ }
  applyDisplayPrefs();
  renderSettings();
});

el('btn-how').addEventListener('click', () => el('dlg-how').showModal());
el('btn-how-close').addEventListener('click', () => el('dlg-how').close());

/* ---------- Startup ---------- */

document.addEventListener('DOMContentLoaded', () => {
  applyDisplayPrefs();
  const missing = [];
  if (!window.supabase) missing.push('the database library (supabase-js)');
  if (!window.Html5Qrcode) missing.push('the scanner library (html5-qrcode)');
  if (!window.qrcode) missing.push('the QR code library (qrcode-generator)');
  if (missing.length) {
    uiText(el('load-error-text'), 'These did not load: ' + missing.join(', ') + '. Check your connection and reload the page.');
    showScreen('load-error');
    return;
  }
  if (!CONFIG_DONE) {
    showScreen('setup');
    return;
  }
  initAuth();
});
