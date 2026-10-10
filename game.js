// ループ・ナイト — ゲーム本体（index.html から読み込む）
// 他スクリプト（audio.js）とグローバル名が衝突しないよう IIFE で包む。
(function () {
'use strict';

// ================= 定数・チューニング =================
const W = 960, H = 540, HUD_H = 44, MID_Y = (H + HUD_H) / 2;
const TICK_MS = 1000 / 60;
const LOOP_TICKS = 600;        // 1ループ = 10秒
const CLEAR_TICKS = 40;        // 「ループクリア」演出（巻き戻しと合わせて幕間は約1.5秒）
const REWIND_TICKS = 48;       // 巻き戻しエフェクト 0.8秒（audio.js が同じ長さで曲を小節頭に戻す）
const DRAFT_GUARD = 36;        // カード表示直後0.6秒は選べない（誤タップ防止）
const PLAYER_R = 10;
const INVULN_TICKS = 60;
const BULLET_SPEED = 11;       // px/tick
const BULLET_LIFE = 60;
const SPREAD_STEP = 0.17;      // 拡散弾の角度間隔(rad)
const SPAWN_WARN = 40;         // 出現予告(無害)の長さ
const BASE_SEED = 0x2f6b1d;
const GHOST_KILL_SCORE = 2;    // ゴーストの弾で倒すと+2
const LOOP_HEAL = 1;           // ループクリア時の回復量
const HEAL_UNTIL = 8;          // 自動回復はこのループまで（以降は強化の回復のみ）
// 敵HPはループごとに増える（位置は変わらないのでゴーストの照準はずれない）。
// ループ10以降は加速して、強化しきったランもいずれ終わるようにする
const HP_GROWTH = 0.12;
const hpMul = (n) => 1 + HP_GROWTH * (n - 1) + 0.02 * Math.max(0, n - 10) ** 2;
const SPAWN_CAP_LOOP = 12;     // 敵の数が増えるのはここまで（以降はHPと射撃型だけ増やす）
const LATE_TURRETS = 2;        // それ以降、1ループごとに増える射撃型の数
const KNOCK_MAX = 1.2;         // 被弾ノックバック速度の上限(px/tick)
const BOSS_EVERY = 5;          // 5ループごとにボス
const BOSS_HP = 220, BOSS_HP_STEP = 200;
const MAX_PARTICLES = 400;
const MAX_FX = 60;             // リング・浮き文字の上限
const TRAIL_TICKS = 42;        // ゴースト軌跡予告 0.7秒
const BEST_KEY = 'loopKnightBest';
const SETTINGS_KEY = 'loopKnightSettings';
const TUTORIAL_KEY = 'loopKnightTutorial';
const FONT = '"Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic", sans-serif';
// ゴーストは「白っぽい半透明」系（彩度低め）。敵は全部高彩度なので色で区別できる。
// 色相はゴーストごとにわずかに変えるだけ（明度は高く保つ）
const GHOST_HUES = [200, 160, 260, 40, 120, 300, 80, 220, 20, 180, 280, 340];
const GHOST_ALPHA = 0.6;
const BOSS_LOOP_SPAWN_CUT = [1, 3];   // ボスがいるループは通常の出現を 5体中2体 減らす（約40%）
const MIN_FONT_CSS = 11;       // 文字は画面上で最低この CSS px（スマホで小さくなりすぎないように）
const TAP_MIN = 64;            // タップ対象の最小サイズ（論理px）。667x375 で約44 CSS px

// プレイヤーとゴーストの射撃が共有する能力値（アップグレードで変化）
const BASE_STATS = { fireCd: 7, spread: 1, pierce: 0, bulletR: 3, dmg: 1, speed: 4.2, maxHp: 3, maxGhosts: 8, ghostBlast: 0 };

const ENEMY = {
  chaser:   { r: 12, hp: 3, speed: 1.7,  color: '#ff3b8d' },
  charger:  { r: 14, hp: 3, speed: 0.5,  color: '#ff9a2e', dash: 9, aimT: 40, dashT: 22, restT: 30 },
  splitter: { r: 18, hp: 5, speed: 0.9,  color: '#3dff8a' },
  mini:     { r: 8,  hp: 1, speed: 2.1,  color: '#c8ff3d' },
  turret:   { r: 14, hp: 4, speed: 0.45, color: '#b98cff', fireT: 120, warnT: 30, shot: 2.6, keep: 230 },
  boss:     { r: 38, hp: 0, speed: 0,    color: '#ff2e63' },
};

// ================= サウンド（audio.js が無くても動くよう no-op で受ける） =================
const NOOP = () => {};
const stubVol = { master: 0.8, sfx: 0.8, music: 0.5 };
const Snd = window.Sound || {
  unlock: NOOP, play: NOOP, music: NOOP, setIntensity: NOOP, pauseAll: NOOP, resumeAll: NOOP,
  setVolume: (o) => { Object.assign(stubVol, o); }, getVolume: () => ({ ...stubVol }),
};

// ================= ユーティリティ =================
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const hueColor = (h, l = 65) => `hsl(${h},100%,${l}%)`;
const ghostColor = (h) => `hsl(${h},30%,82%)`;
const ghostBulletColor = (h) => `hsl(${h},45%,84%)`;
const panOf = (x) => clamp(x / W * 2 - 1, -1, 1);

function loadJSON(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v && typeof v === 'object' ? v : fallback; } catch (e) { return fallback; }
}
function saveJSON(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* 保存不可でも続行 */ }
}
function loadBest() {
  try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch (e) { return 0; }
}
function saveBest(v) {
  try { localStorage.setItem(BEST_KEY, String(v)); } catch (e) { /* 保存不可でも続行 */ }
}
function vibrate(ms) {
  if (isTouch && navigator.vibrate) { try { navigator.vibrate(ms); } catch (e) { /* 非対応 */ } }
}

// ================= キャンバス =================
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let viewScale = 1, cssScale = 1;   // canvas画素/論理px、CSS px/論理px

function fit() {
  // body のパディング（= セーフエリア）を除いた領域に 16:9 で最大化
  const b = document.body, cs = getComputedStyle(b);
  const aw = b.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const ah = b.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const s = Math.max(0.1, Math.min(aw / W, ah / H));
  const dpr = Math.min(2, window.devicePixelRatio || 1);   // 高DPIはくっきり、ただし最大2倍
  canvas.style.width = Math.floor(W * s) + 'px';
  canvas.style.height = Math.floor(H * s) + 'px';
  canvas.width = Math.round(W * s * dpr);
  canvas.height = Math.round(H * s * dpr);
  viewScale = canvas.width / W;
  cssScale = Math.floor(W * s) / W;
}
addEventListener('resize', fit);
addEventListener('orientationchange', () => setTimeout(fit, 100));
fit();

// ================= 光彩スプライト =================
// shadowBlur は1体ごとにぼかし処理が走って重い。色×半径ごとに一度だけ描いた光の玉を drawImage で重ねる
const glowCache = new Map();
function rgbaOf(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
function glowSprite(hex, r) {
  const key = hex + r;
  let c = glowCache.get(key);
  if (!c) {
    const R = Math.ceil(r * 2.2), S = 2;
    c = document.createElement('canvas');
    c.width = c.height = R * 2 * S;
    const g = c.getContext('2d');
    g.scale(S, S);
    const grad = g.createRadialGradient(R, R, r * 0.3, R, R, R);
    grad.addColorStop(0, rgbaOf(hex, 0.55));
    grad.addColorStop(0.45, rgbaOf(hex, 0.22));
    grad.addColorStop(1, rgbaOf(hex, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, R * 2, R * 2);
    c.R = R;
    glowCache.set(key, c);
  }
  return c;
}
function drawGlow(hex, x, y, r) {
  const c = glowSprite(hex, r);
  ctx.drawImage(c, x - c.R, y - c.R, c.R * 2, c.R * 2);
}

// ================= アップグレード =================
// 名前と説明は文字列表（STR の up_* / upd_*）にある
const RARITY = [
  { color: '#8ffcff', w: 10 },
  { color: '#3dff8a', w: 5 },
  { color: '#ffe14d', w: 2 },
];
const UPGRADES = [
  { id: 'rapid',  icon: '≫', rarity: 0, max: 2, apply: (s) => { s.fireCd -= 1; } },
  { id: 'big',    icon: '●', rarity: 0, max: 3, apply: (s) => { s.bulletR += 2; } },
  { id: 'speed',  icon: '⇒', rarity: 0, max: 2, apply: (s) => { s.speed += 0.5; } },
  { id: 'heal',   icon: '＋', rarity: 0, max: 3, apply: (s) => { hp = s.maxHp; }, when: () => hp < stats.maxHp },
  { id: 'pierce', icon: '→', rarity: 1, max: 2, apply: (s) => { s.pierce += 1; } },
  { id: 'maxhp',  icon: '♥', rarity: 1, max: 3, apply: (s) => { s.maxHp += 1; hp = Math.min(s.maxHp, hp + 1); } },
  { id: 'blast',  icon: '※', rarity: 1, max: 2, apply: (s) => { s.ghostBlast += 1; } },
  { id: 'spread', icon: '∴', rarity: 2, max: 1, apply: (s) => { s.spread += 2; } },
  { id: 'power',  icon: '★', rarity: 2, max: 1, apply: (s) => { s.dmg += 1; } },
  { id: 'ghosts', icon: '◎', rarity: 2, max: 1, apply: (s) => { s.maxGhosts += 2; } },
];

// 3枚をレア度の重み付きで重複なしに引く
function rollDraft() {
  const pool = UPGRADES.filter((u) => (taken[u.id] || 0) < u.max && (!u.when || u.when()));
  const picks = [];
  while (picks.length < 3 && pool.length) {
    let r = Math.random() * pool.reduce((sum, u) => sum + RARITY[u.rarity].w, 0);
    let i = 0;
    while (i < pool.length - 1 && r >= RARITY[pool[i].rarity].w) { r -= RARITY[pool[i].rarity].w; i++; }
    picks.push(pool.splice(i, 1)[0]);
  }
  return picks;
}
const cardRect = (i) => ({ x: 75 + i * 280, y: 165, w: 250, h: 240 });
function cardAt(p) {
  for (let i = 0; i < draft.length; i++) {
    const r = cardRect(i);
    if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return i;
  }
  return -1;
}

// ================= 入力 =================
const keys = {};
// block: UI操作（スタート/再開/カード選択/メニュー）のクリックでは撃たない（一度離すまで射撃無効）
const mouse = { x: W / 2, y: H / 2, down: false, block: false };
let paused = false;
// タッチ: 左半分=移動スティック、右半分=照準スティック（押している間は自動射撃）
const JOY_PX = 60;             // スティック半径（CSS px）
const touch = { move: null, aim: null, angle: null };
let isTouch = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
const PAUSE_BTN = { x: W - 46, y: 6, w: 38, h: 32 };              // 見た目
const PAUSE_HIT = { x: W - TAP_MIN - 4, y: 0, w: TAP_MIN + 4, h: TAP_MIN };   // 当たり判定は大きめ
const ACTIVE = { play: 1, clear: 1, draft: 1, rewind: 1 };   // 一時停止できる状態

function setPaused(v) {
  if (v === paused) return;
  paused = v;
  if (v) Snd.pauseAll(); else Snd.resumeAll();
}
// 一時停止メニューを開く（ゲーム中のみ）。入力はすべて離した扱いにする
function pause() {
  if (ACTIVE[state]) setPaused(true);
  for (const k in keys) keys[k] = false;
  mouse.down = false; mouse.block = false;
  touch.move = touch.aim = null;
  // 指やボタンを離したイベントを取りこぼしてもメニューやスライダーが固まらないように
  ui.touchId = null; ui.press = null; ui.drag = null;
  draftPress.id = null; draftPress.card = -1;
}
const isPortrait = () => isTouch && innerHeight > innerWidth;

// 画面座標 → 論理座標(960x540)。レターボックスを考慮
function toLogical(cx, cy) {
  const r = canvas.getBoundingClientRect();
  return { x: (cx - r.left) * W / r.width, y: (cy - r.top) * H / r.height };
}
const inRect = (r, p) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
const inPauseBtn = (p) => !!ACTIVE[state] && inRect(PAUSE_HIT, p);
// カードは「押して、同じカードの上で離す」と選択。表示直後(DRAFT_GUARD)の押下は無視
const draftPress = { id: null, card: -1 };
function draftDown(id, p) {
  if (draftPress.id !== null || draftT < DRAFT_GUARD) return;
  const i = cardAt(p);
  if (i >= 0) { draftPress.id = id; draftPress.card = i; }
}
function draftUp(id, p) {
  if (draftPress.id !== id) return;
  const i = cardAt(p), card = draftPress.card;
  draftPress.id = null; draftPress.card = -1;
  if (state === 'draft' && i === card) pickUpgrade(i);
}
let lastTouchAt = -1e9;

// ================= メニュー（タイトル/一時停止/ゲームオーバー/設定/遊び方） =================
// 画面ごとにウィジェット（button/slider/toggle/choice）を並べ、マウス・タッチ・キーボードで同じように操作する。
// ボタンは「押して、同じボタンの上で離す」と発動（Web Share などに必要なユーザー操作の扱いにもなる）。
let menu = null;                                   // 'settings' | 'howto' | null（上に重なる画面）
const ui = { screen: null, focus: 0, kb: false, press: null, drag: null, touchId: null };
let toast = null;

function currentScreen() {
  if (menu) return menu;
  if (state === 'title') return 'title';
  if (paused) return 'pause';
  if (state === 'over') return 'over';
  return null;
}
// 画面が切り替わったらフォーカスと押下状態をリセット
function screenNow() {
  const s = currentScreen();
  if (s !== ui.screen) {
    ui.screen = s; ui.focus = s === 'over' ? 1 : 0; ui.press = null; ui.drag = null;
  }
  return s;
}

const openMenu = (m) => { menu = m; };
const closeMenu = () => { menu = null; };
function resumeGame() { menu = null; setPaused(false); }
function restartGame() { menu = null; setPaused(false); startGame(); }
function toTitle() {
  menu = null; setPaused(false);
  state = 'title';
  particles = []; fx = []; banner = null;
  touch.move = touch.aim = null;
}
function setSetting(k, v) {
  settings[k] = v;
  saveJSON(SETTINGS_KEY, settings);
  if (k === 'lang') applyLang();
}
function showToast(text) { toast = { text, until: frameCount + 150 }; }

// ---- シェア: Web Share API。無ければ X の投稿画面を開き、本文をクリップボードへ ----
const GAME_URL = 'https://baibai100100.github.io/loop-knight/';
function shareResult() {
  const text = T('shareText', { n: loopNo, s: score });
  if (navigator.share) {
    navigator.share({ text, url: GAME_URL }).catch(() => { /* キャンセルは無視 */ });
    return;
  }
  try {
    window.open('https://x.com/intent/post?text=' + encodeURIComponent(text) + '&url=' + encodeURIComponent(GAME_URL), '_blank', 'noopener');
  } catch (e) { /* ポップアップ不可 */ }
  let copy = Promise.resolve(false);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) copy = navigator.clipboard.writeText(`${text} ${GAME_URL}`).then(() => true, () => false);
  } catch (e) { /* 非対応 */ }
  copy.then((ok) => showToast(T(ok ? 'copied' : 'shareOpened')));
}

function button(id, x, y, w, h, label, act, extra) {
  return Object.assign({ id, kind: 'button', x, y, w, h, label, act }, extra);
}
function widgets(scr) {
  if (scr === 'title') return [
    button('start', W / 2 - 180, 326, 360, TAP_MIN, T(isTouch ? 'tapStart' : 'clickStart'), startGame, { style: 'text' }),
    button('settings', W / 2 - 210, 410, 200, TAP_MIN, T('settings'), () => openMenu('settings')),
    button('howto', W / 2 + 10, 410, 200, TAP_MIN, T('howto'), () => openMenu('howto')),
  ];
  if (scr === 'pause') return [
    button('resume', W / 2 - 160, 146, 320, TAP_MIN, T('resume'), resumeGame, { primary: true }),
    button('restart', W / 2 - 160, 220, 320, TAP_MIN, T('restart'), restartGame),
    button('toTitle', W / 2 - 160, 294, 320, TAP_MIN, T('toTitle'), toTitle),
    button('settings', W / 2 - 160, 368, 320, TAP_MIN, T('settings'), () => openMenu('settings')),
  ];
  if (scr === 'over') {
    const off = overTicks < 36;   // 0.6秒ガード（死んだ直後の連打で押さない）
    return [
      button('share', 170, 384, 190, TAP_MIN, T('share'), shareResult, { disabled: off }),
      button('retry', 385, 384, 190, TAP_MIN, T('retry'), startGame, { disabled: off, primary: true }),
      button('toTitle', 600, 384, 190, TAP_MIN, T('toTitle'), toTitle, { disabled: off }),
    ];
  }
  if (scr === 'howto') return [button('back', W / 2 - 110, 456, 220, TAP_MIN, T('back'), closeMenu, { primary: true })];
  if (scr === 'settings') {
    const v = Snd.getVolume(), L = 90, R = 490, CW = 380, RH = TAP_MIN;
    return [
      { id: 'master', kind: 'slider', x: L, y: 94, w: CW, h: RH, label: T('volMaster'), value: v.master, set: (x) => Snd.setVolume({ master: x }) },
      { id: 'sfx', kind: 'slider', x: L, y: 166, w: CW, h: RH, label: T('volSfx'), value: v.sfx, set: (x) => Snd.setVolume({ sfx: x }) },
      { id: 'music', kind: 'slider', x: L, y: 238, w: CW, h: RH, label: T('volMusic'), value: v.music, set: (x) => Snd.setVolume({ music: x }) },
      { id: 'shake', kind: 'toggle', x: R, y: 94, w: CW, h: RH, label: T('optShake'), value: settings.shake, act: () => setSetting('shake', !settings.shake) },
      { id: 'flash', kind: 'toggle', x: R, y: 166, w: CW, h: RH, label: T('optFlash'), value: settings.flash, act: () => setSetting('flash', !settings.flash) },
      { id: 'trail', kind: 'toggle', x: R, y: 238, w: CW, h: RH, label: T('optTrail'), value: settings.ghostTrail, act: () => setSetting('ghostTrail', !settings.ghostTrail) },
      { id: 'lang', kind: 'choice', x: L, y: 314, w: 780, h: TAP_MIN + 8, label: T('language'), options: ['auto', 'ja', 'en'],
        labels: [T('langAuto'), '日本語', 'English'], value: settings.lang, set: (x) => setSetting('lang', x) },
      button('back', W / 2 - 110, 400, 220, TAP_MIN, T('back'), closeMenu, { primary: true }),
    ];
  }
  return [];
}

const sliderTrack = (w) => ({ x: w.x + 160, w: w.w - 230 });
const sliderFrac = (w, p) => { const t = sliderTrack(w); return clamp((p.x - t.x) / t.w, 0, 1); };
function choiceSeg(w, i) {
  const x0 = w.x + 190, sw = (w.w - 190 - 10) / w.options.length;
  return { x: x0 + i * sw, y: w.y + 4, w: sw - 8, h: w.h - 8 };
}
function hitWidget(ws, p) {
  for (let i = ws.length - 1; i >= 0; i--) if (inRect(ws[i], p)) return ws[i];
  return null;
}

function activate(w, p) {
  if (w.disabled) return;
  if (w.kind === 'slider') { if (p) w.set(sliderFrac(w, p)); return; }
  if (w.kind === 'choice') {
    let i = (w.options.indexOf(w.value) + 1) % w.options.length;
    if (p) { i = w.options.findIndex((_, j) => inRect(choiceSeg(w, j), p)); if (i < 0) return; }
    w.set(w.options[i]);
  } else {
    w.act();
  }
  Snd.play('uiTap');
}
function adjust(w, dir) {
  if (w.kind === 'slider') w.set(clamp(Math.round((w.value + dir * 0.1) * 10) / 10, 0, 1));
  else { const n = w.options.length; w.set(w.options[(w.options.indexOf(w.value) + dir + n) % n]); }
  Snd.play('uiTap');
}

function uiDown(p) {
  const scr = screenNow();
  if (!scr) return false;
  const ws = widgets(scr), w = hitWidget(ws, p);
  ui.kb = false;
  ui.press = w ? w.id : 'bg';
  if (w) ui.focus = ws.indexOf(w);
  if (w && w.kind === 'slider') { ui.drag = w.id; w.set(sliderFrac(w, p)); }
  return true;
}
function uiMove(p) {
  if (!ui.drag) return;
  const w = widgets(screenNow()).find((x) => x.id === ui.drag);
  if (w) w.set(sliderFrac(w, p));
}
function uiUp(p) {
  const scr = screenNow(), pressed = ui.press, dragging = ui.drag;
  ui.press = null; ui.drag = null;
  if (!scr || pressed === null) return;
  if (dragging) { Snd.play('uiTap'); return; }
  const w = hitWidget(widgets(scr), p);
  if (w && w.id === pressed) activate(w, p);
  else if (!w && pressed === 'bg') {
    if (scr === 'title') startGame();          // タイトルはどこを押してもスタート
    else if (scr === 'howto') closeMenu();
  }
}
function uiBack(scr) {
  if (scr === 'settings' || scr === 'howto') closeMenu();
  else if (scr === 'pause') resumeGame();
  else return;
  Snd.play('uiTap');
}
// キーボード: ↑↓(←→)で移動、←→でスライダー/言語を調整、Enter/Space で決定、Esc で戻る
function uiKey(e) {
  const scr = screenNow();
  if (!scr || isPortrait()) return false;
  const ws = widgets(scr), c = e.code;
  if (c === 'Escape' || (c === 'KeyP' && scr === 'pause')) { if (!e.repeat) uiBack(scr); return true; }
  const nav = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1, Tab: e.shiftKey ? -1 : 1 };
  if (c in nav) {
    ui.kb = true;
    const w = ws[ui.focus];
    const sliding = (c === 'ArrowLeft' || c === 'ArrowRight') && w && w.kind === 'slider';
    if (e.repeat && !sliding) return true;
    if ((c === 'ArrowLeft' || c === 'ArrowRight') && w && (w.kind === 'slider' || w.kind === 'choice')) adjust(w, nav[c]);
    else if (ws.length) ui.focus = (clamp(ui.focus, 0, ws.length - 1) + nav[c] + ws.length) % ws.length;
    return true;
  }
  if (c === 'Enter' || c === 'NumpadEnter' || c === 'Space') {
    ui.kb = true;
    if (!e.repeat && ws[ui.focus]) activate(ws[ui.focus], null);
    return true;
  }
  return false;
}

// iOS などは最初のユーザー操作で音を解禁する必要がある（何度呼んでも安全）
for (const ev of ['pointerdown', 'touchstart', 'touchend', 'keydown']) {
  addEventListener(ev, () => Snd.unlock(), { passive: true });
}

addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code.startsWith('Arrow') || e.code === 'Space' || e.code === 'Tab') e.preventDefault();
  if (uiKey(e)) return;
  if ((e.code === 'KeyP' || e.code === 'Escape') && !e.repeat && ACTIVE[state]) { pause(); Snd.play('uiTap'); return; }
  if (e.code === 'KeyR' && state === 'over' && overTicks >= 36 && !e.repeat) startGame();
  if (e.code === 'KeyG' && !e.repeat && ACTIVE[state]) {
    setSetting('ghostTrail', !settings.ghostTrail);
    showBanner(T('trailToggle', { v: T(settings.ghostTrail ? 'on' : 'off') }), 90);
  }
  if (state === 'draft' && !paused) {
    const m = /^(?:Digit|Numpad)([1-3])$/.exec(e.code);
    if (m) pickUpgrade(Number(m[1]) - 1);
  }
});
addEventListener('keyup', (e) => { keys[e.code] = false; });
addEventListener('blur', pause);
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

addEventListener('mousemove', (e) => {
  if (performance.now() - lastTouchAt < 1000) return;   // タッチ直後の互換イベントは無視
  isTouch = false;
  const p = toLogical(e.clientX, e.clientY);
  mouse.x = p.x; mouse.y = p.y;
  if (ui.drag) { uiMove(p); return; }
  const scr = screenNow();
  if (scr) {
    const i = widgets(scr).findIndex((w) => inRect(w, p));
    if (i >= 0) { ui.focus = i; ui.kb = false; }
  }
});
canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const p = toLogical(e.clientX, e.clientY);
  mouse.down = true;
  mouse.block = true;                 // 既定は「撃たない」。ゲーム中の素の押下だけ解除する
  if (isPortrait()) return;
  const scr = screenNow();
  if (scr) {
    if (scr === 'pause' && inPauseBtn(p)) resumeGame(); else uiDown(p);
    return;
  }
  if (inPauseBtn(p)) { pause(); Snd.play('uiTap'); return; }
  if (state === 'draft') { draftDown('mouse', p); return; }
  mouse.block = false;
});
addEventListener('mouseup', (e) => {
  if (e.button !== 0) return;
  const p = toLogical(e.clientX, e.clientY);
  if (ui.press !== null) uiUp(p);
  draftUp('mouse', p);
  mouse.down = false; mouse.block = false;
});

// ---- タッチ（ツインスティック＋メニュー）----
document.addEventListener('touchstart', (e) => {
  e.preventDefault();
  isTouch = true;
  lastTouchAt = performance.now();
  if (isPortrait()) return;
  const scr = screenNow();
  if (scr) {
    // メニュー表示中は1本目の指だけをUI操作に使い、スティックは作らない
    const t = e.changedTouches[0], p = toLogical(t.clientX, t.clientY);
    if (scr === 'pause' && inPauseBtn(p)) { resumeGame(); return; }
    if (ui.touchId === null) { ui.touchId = t.identifier; uiDown(p); }
    return;
  }
  for (const t of e.changedTouches) {
    const p = toLogical(t.clientX, t.clientY);
    if (inPauseBtn(p)) { pause(); Snd.play('uiTap'); return; }
    if (state === 'draft') { draftDown(t.identifier, p); continue; }
    const s = { id: t.identifier, ox: t.clientX, oy: t.clientY, x: t.clientX, y: t.clientY };
    if (t.clientX < innerWidth / 2) { if (!touch.move) touch.move = s; }
    else if (!touch.aim) touch.aim = s;
  }
}, { passive: false });
document.addEventListener('touchmove', (e) => {
  e.preventDefault();
  lastTouchAt = performance.now();
  for (const t of e.changedTouches) {
    if (t.identifier === ui.touchId) uiMove(toLogical(t.clientX, t.clientY));
    for (const s of [touch.move, touch.aim]) {
      if (s && s.id === t.identifier) { s.x = t.clientX; s.y = t.clientY; }
    }
  }
}, { passive: false });
function touchEnd(e) {
  e.preventDefault();
  lastTouchAt = performance.now();
  for (const t of e.changedTouches) {
    if (t.identifier === draftPress.id) {
      if (e.type === 'touchend') draftUp(t.identifier, toLogical(t.clientX, t.clientY)); else { draftPress.id = null; draftPress.card = -1; }
    }
    if (t.identifier === ui.touchId) {
      ui.touchId = null;
      if (e.type === 'touchend') uiUp(toLogical(t.clientX, t.clientY)); else { ui.press = null; ui.drag = null; }
    }
    if (touch.move && touch.move.id === t.identifier) touch.move = null;
    if (touch.aim && touch.aim.id === t.identifier) touch.aim = null;
  }
}
document.addEventListener('touchend', touchEnd, { passive: false });
document.addEventListener('touchcancel', touchEnd, { passive: false });
// 長押しメニュー・ピンチ・ダブルタップ拡大・文字選択を抑止
for (const ev of ['contextmenu', 'gesturestart', 'gesturechange', 'dblclick', 'selectstart']) {
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}

// スティックの入力ベクトル（長さ0..1）
function stickVec(s) {
  const dx = s.x - s.ox, dy = s.y - s.oy, len = Math.hypot(dx, dy);
  if (len < 8) return { x: 0, y: 0, len: 0 };
  const m = Math.min(1, len / (JOY_PX * 0.7));
  return { x: dx / len * m, y: dy / len * m, len };
}

// ================= スポーン表（決定的） =================
// side: 0=上 1=右 2=下 3=左, u: 辺に沿った位置(0..1)
function edgePoint(side, u) {
  const m = 30, top = HUD_H + m, bottom = H - m;
  u = clamp(u, 0, 1);
  if (side === 0) return { x: m + u * (W - 2 * m), y: top };
  if (side === 1) return { x: W - m, y: top + u * (bottom - top) };
  if (side === 2) return { x: m + u * (W - 2 * m), y: bottom };
  return { x: m, y: top + u * (bottom - top) };
}

// 1つの辺から count 体がまとまって出てくる「群れ」
function burst(table, rng, type, t0, side, count) {
  const center = 0.2 + rng() * 0.6;
  for (let i = 0; i < count; i++) {
    const p = edgePoint(side, center + (i - (count - 1) / 2) * 0.09);
    table.push({ t: t0 + i * 6, type, x: p.x, y: p.y });
  }
}

// ループnの表 = 共通の基本パターン + ループ2..nの追加分。
// 各部分は固定シードで再生成されるので、ループnの表はループn-1の表を必ず含む。
// 敵の速さはループで変えない（変えるとゴーストの射撃がずれる）。難易度は数と構成だけで上げる。
function buildSpawnTable(n) {
  const table = [];
  let rng = mulberry32(BASE_SEED);
  // 基本: 追尾型14体を3つの群れで（左→右→上下）
  burst(table, rng, 'chaser', 20, 3, 4);
  burst(table, rng, 'chaser', 190, 1, 5);
  burst(table, rng, 'chaser', 360, 0, 3);
  burst(table, rng, 'chaser', 372, 2, 2);
  for (let k = 2; k <= Math.min(n, SPAWN_CAP_LOOP); k++) {
    rng = mulberry32(BASE_SEED ^ Math.imul(k, 0x9E3779B1));
    const side = () => Math.floor(rng() * 4);
    const time = () => Math.floor(30 + rng() * 450);
    // 追尾型の群れ（3k体）
    burst(table, rng, 'chaser', time(), side(), 3 * k);
    // 突進型 k体（ループ2で2体）
    for (let i = 0; i < k; i++) burst(table, rng, 'charger', time(), side(), 1);
    // 分裂型 ループ3から k-2 体
    for (let i = 0; i < k - 2; i++) burst(table, rng, 'splitter', time(), side(), 1);
    // 射撃型 ループ3から floor((k-1)/2) 体
    for (let i = 0; i < Math.floor((k - 1) / 2); i++) burst(table, rng, 'turret', time(), side(), 1);
  }
  // 終盤: 弾幕の密度で押す（避け続けるだけでは生き残れないように）
  for (let k = SPAWN_CAP_LOOP + 1; k <= n; k++) {
    rng = mulberry32(BASE_SEED ^ Math.imul(k, 0x9E3779B1));
    for (let i = 0; i < LATE_TURRETS; i++) burst(table, rng, 'turret', Math.floor(30 + rng() * 450), Math.floor(rng() * 4), 1);
  }
  return table.sort((a, b) => a.t - b.t);
}

// ボスはループ内の時刻だけで決まる経路を飛ぶ → 前ループのゴーストの射撃が同じ場所に刺さる
function bossPath(t) {
  const a = t / LOOP_TICKS * Math.PI * 2;
  return { x: W / 2 + 330 * Math.sin(a), y: MID_Y - 120 * Math.cos(a * 2) };
}

// ================= ゲーム状態 =================
let state = 'title'; // title | play | clear | draft | rewind | over
let loopNo = 1, tick = 0, score = 0, kills = 0, ghostKills = 0, bossKills = 0;
let stats = { ...BASE_STATS }, taken = {}, hp = BASE_STATS.maxHp;
let invuln = 0, shake = 0, hurtFlash = 0, phaseT = 0, draftT = 0, overTicks = 0;
let hitstop = 0, hitstopCd = 0, bossHitCd = 0, lastBonus = 0, healed = false;
let player = { x: W / 2, y: MID_Y, a: 0 };
const gun = { cd: 0 };
let bullets = [], ebullets = [], enemies = [], particles = [], ghosts = [], fx = [];
let rec = null, spawnTable = [], spawnIdx = 0, draft = [];
let boss = null, bossLevel = 0;      // boss: { hp, maxHp, level } ループをまたいで持ち越す
let best = loadBest(), newBest = false;
let frameCount = 0, curMusic = null, banner = null;
let gcombo = 0, gcomboT = 0, gcomboPop = 0;   // ゴースト撃破コンボ（HUD横に「GHOST ×n」）
// prefers-reduced-motion なら揺れ・フラッシュは既定OFF
const reducedMotion = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
const settings = Object.assign({ ghostTrail: true, shake: !reducedMotion, flash: !reducedMotion, lang: 'auto' }, loadJSON(SETTINGS_KEY, {}));
const tutorialSeen = loadJSON(TUTORIAL_KEY, {});

// ================= 言語（日本語 / English） =================
// UI の文字列はすべてここ。{name} は T() の引数で置き換える
const STR = {
  ja: {
    docTitle: 'ループ・ナイト',
    titleMain: 'ループ・ナイト', titleSub: 'LOOP KNIGHT',
    howLine1Pc: 'WASD／矢印キーで移動、マウスで照準、クリック（長押し可）で射撃',
    howLine1Touch: '左半分をドラッグで移動、右半分をドラッグで照準（押している間は自動射撃）',
    howLine2: '10秒ごとに時間が巻き戻り、直前の自分が「ゴースト」になって一緒に戦う',
    howLine3: 'ループごとに強化を1つ選ぶ（ゴーストにも効く）。5ループごとにボス',
    tapStart: 'タップでスタート', clickStart: 'クリックでスタート',
    bestScore: 'ベストスコア {n}', settings: '設定', howto: '遊び方',
    keyHint: 'P / Esc: 一時停止　G: ゴースト軌跡 ON/OFF',
    secs: '{n}秒', rewindHud: '◀◀ REWIND', hudGhosts: 'ゴースト {a}/{b}', hudScore: 'スコア {n}', bossLv: 'BOSS Lv{n}',
    tut_loop1: '10秒後、今の動きが「ゴースト」になって一緒に戦う',
    tut_loop2: '過去の自分が戦っている！ ゴーストの弾も敵を倒す',
    tut_boss: 'ボスは巻き戻っても消えない。ゴーストと集中砲火！',
    trailToggle: 'ゴースト軌跡: {v}',
    loopClear: 'ループ {n} クリア', loopBonus: 'ループボーナス +{n}', hpUp: '　HP+1',
    bossCarry: 'ボス残りHP {p}% — 次のループへ持ち越し',
    draftTitle: 'アップグレードを選択', draftSub: '強化は過去の自分（ゴースト）の射撃にも効く',
    draftHintTouch: 'カードをタップして選択', draftHintPc: 'クリック または 1〜3 キーで選択', owned: '所持 {a}/{b}',
    rarity0: 'コモン', rarity1: 'アンコモン', rarity2: 'レア',
    rewinding: '◀◀ 巻き戻し', bossKill: 'ボス撃破 +{n}',
    gameOver: 'ゲームオーバー', score: 'スコア {n}', best: 'ベスト {n}', newBest: '　NEW!',
    stats: '到達ループ {l}　撃破 {k}　ゴースト撃破 {g}　ボス撃破 {b}',
    upgrades: '取得アップグレード', none: 'なし',
    share: 'シェア', retry: 'リトライ', toTitle: 'タイトルへ', retryKey: 'R: リトライ　←→ / Enter: 選択',
    paused: 'PAUSE', resume: '再開', restart: 'リスタート', pauseHint: 'Esc / P で再開　↑↓ / Enter: 選択',
    volMaster: 'マスター音量', volSfx: '効果音', volMusic: 'BGM',
    optShake: '画面の揺れ', optFlash: 'フラッシュ', optTrail: 'ゴースト軌跡', language: '言語',
    langAuto: '自動', on: 'ON', off: 'OFF', back: '戻る',
    settingsHint: '↑↓: 選択　←→: 調整　Enter: 切替　Esc: 戻る',
    portrait: '横向きにしてください',
    copied: 'シェア文をコピーしました', shareOpened: 'X の投稿画面を開きました',
    shareText: 'ループ・ナイトでLOOP {n}まで到達！スコア {s} #ループナイト',
    howTitle: '遊び方',
    how1: 'ループ1：あなたが動いて撃つ', how2: '10秒で巻き戻り、その動きがゴーストに', how3: 'ゴーストと一緒に戦う（最大8体）',
    howPc: 'PC：WASD / 矢印で移動、マウスで照準、クリックで射撃、P / Esc で一時停止',
    howTouch: 'スマホ：左半分ドラッグで移動、右半分ドラッグで照準＋自動射撃',
    howTips: '強化はゴーストにも効く。5ループごとにボス（HPは巻き戻っても持ち越し）',
    up_rapid: '連射+', upd_rapid: '射撃間隔が短くなる\nゴーストにも効く',
    up_big: '弾サイズ+', upd_big: '弾の当たり判定が\n大きくなる',
    up_speed: '移動速度+', upd_speed: '移動が速くなる',
    up_heal: '全回復', upd_heal: 'HPを最大まで回復',
    up_pierce: '貫通弾', upd_pierce: '弾が敵を1体多く\n貫通する',
    up_maxhp: '最大HP+1', upd_maxhp: '最大HP+1\nさらに1回復',
    up_blast: 'ゴースト炸裂弾', upd_blast: 'ゴーストの弾が\n着弾で小爆発する',
    up_spread: '3way拡散', upd_spread: '弾が2発増える\nゴーストにも効く',
    up_power: '威力+', upd_power: '弾のダメージ+1\nゴーストにも効く',
    up_ghosts: 'ゴースト上限+2', upd_ghosts: '残せる過去の自分が\n2体増える',
  },
  en: {
    docTitle: 'Loop Knight',
    titleMain: 'LOOP KNIGHT', titleSub: 'ループ・ナイト',
    howLine1Pc: 'WASD / arrows to move, mouse to aim, click (or hold) to fire',
    howLine1Touch: 'Drag the left half to move, drag the right half to aim (auto-fire while held)',
    howLine2: 'Every 10 seconds time rewinds and your last run fights beside you as a ghost',
    howLine3: 'Pick an upgrade each loop (ghosts get it too). A boss every 5 loops',
    tapStart: 'Tap to start', clickStart: 'Click to start',
    bestScore: 'Best score {n}', settings: 'Settings', howto: 'How to play',
    keyHint: 'P / Esc: pause   G: ghost paths on/off',
    secs: '{n}s', rewindHud: '◀◀ REWIND', hudGhosts: 'Ghosts {a}/{b}', hudScore: 'Score {n}', bossLv: 'BOSS Lv{n}',
    tut_loop1: 'In 10 seconds, what you do now becomes a ghost that fights with you',
    tut_loop2: 'Your past self is fighting! Ghost bullets kill enemies too',
    tut_boss: 'The boss survives the rewind. Focus fire with your ghosts!',
    trailToggle: 'Ghost paths: {v}',
    loopClear: 'LOOP {n} CLEAR', loopBonus: 'Loop bonus +{n}', hpUp: '   HP+1',
    bossCarry: 'Boss HP {p}% — carries over to the next loop',
    draftTitle: 'Choose an upgrade', draftSub: 'Upgrades also power up your ghosts\' shots',
    draftHintTouch: 'Tap a card', draftHintPc: 'Click a card or press 1-3', owned: 'Owned {a}/{b}',
    rarity0: 'COMMON', rarity1: 'UNCOMMON', rarity2: 'RARE',
    rewinding: '◀◀ REWIND', bossKill: 'BOSS DOWN +{n}',
    gameOver: 'GAME OVER', score: 'Score {n}', best: 'Best {n}', newBest: '   NEW!',
    stats: 'Loop {l}   Kills {k}   Ghost kills {g}   Bosses {b}',
    upgrades: 'Upgrades', none: 'None',
    share: 'Share', retry: 'Retry', toTitle: 'Title', retryKey: 'R: retry   ←→ / Enter: select',
    paused: 'PAUSED', resume: 'Resume', restart: 'Restart', pauseHint: 'Esc / P to resume   ↑↓ / Enter: select',
    volMaster: 'Master volume', volSfx: 'Sound effects', volMusic: 'Music',
    optShake: 'Screen shake', optFlash: 'Flashes', optTrail: 'Ghost paths', language: 'Language',
    langAuto: 'Auto', on: 'ON', off: 'OFF', back: 'Back',
    settingsHint: '↑↓ select   ←→ adjust   Enter toggle   Esc back',
    portrait: 'Please rotate to landscape',
    copied: 'Share text copied', shareOpened: 'Opened a post on X',
    shareText: 'I reached LOOP {n} in Loop Knight! Score {s} #LoopKnight',
    howTitle: 'How to play',
    how1: 'Loop 1: you move and shoot', how2: 'After 10 s time rewinds; that run becomes a ghost', how3: 'Fight with your ghosts (max 8)',
    howPc: 'PC: WASD / arrows to move, mouse to aim, click to fire, P / Esc to pause',
    howTouch: 'Phone: drag left half to move, drag right half to aim + auto-fire',
    howTips: 'Upgrades apply to ghosts. A boss every 5 loops (its HP survives the rewind)',
    up_rapid: 'Rapid Fire+', upd_rapid: 'Shoot more often\nGhosts too',
    up_big: 'Big Shots', upd_big: 'Larger bullet\nhitbox',
    up_speed: 'Move Speed+', upd_speed: 'Move faster',
    up_heal: 'Full Heal', upd_heal: 'Restore all HP',
    up_pierce: 'Piercing', upd_pierce: 'Bullets pierce\none more enemy',
    up_maxhp: 'Max HP +1', upd_maxhp: 'Max HP +1\nand heal 1',
    up_blast: 'Ghost Blast', upd_blast: 'Ghost bullets\nexplode on hit',
    up_spread: '3-Way Shot', upd_spread: '+2 bullets per shot\nGhosts too',
    up_power: 'Power+', upd_power: 'Bullet damage +1\nGhosts too',
    up_ghosts: 'Ghost Cap +2', upd_ghosts: 'Keep 2 more\npast selves',
  },
};
let curLang = 'ja';
function T(key, p) {
  let s = STR[curLang][key];
  if (s === undefined) s = STR.ja[key] !== undefined ? STR.ja[key] : key;
  return p ? s.replace(/\{(\w+)\}/g, (_, k) => (p[k] !== undefined ? p[k] : '')) : s;
}
function applyLang() {
  const nav = String((navigator && navigator.language) || '').toLowerCase();
  curLang = settings.lang === 'ja' || settings.lang === 'en' ? settings.lang : (nav.startsWith('ja') ? 'ja' : 'en');
  document.documentElement.lang = curLang;
  document.title = T('docTitle');
}
applyLang();

function showBanner(text, t = 240) { banner = { text, t, max: t }; }
// 初回プレイのみ表示するヒント
function tutorial(key) {
  if (tutorialSeen[key]) return;
  tutorialSeen[key] = 1;
  saveJSON(TUTORIAL_KEY, tutorialSeen);
  showBanner(T('tut_' + key), 300);
}

function startGame() {
  loopNo = 1; score = 0; kills = 0; ghostKills = 0; bossKills = 0;
  stats = { ...BASE_STATS }; taken = {}; hp = stats.maxHp;
  ghosts = []; particles = []; fx = []; banner = null;
  shake = 0; hurtFlash = 0; hitstop = 0; hitstopCd = 0; newBest = false;
  boss = null; bossLevel = 0;
  menu = null;
  Snd.play('uiTap');
  Snd.music('off'); curMusic = 'off';   // 次の syncMusic で 'play' が1小節目から始まる
  startLoop();
  state = 'play';
  tutorial('loop1');
}

function startLoop() {
  tick = 0; invuln = 30; gun.cd = 0; touch.angle = null;
  player = { x: W / 2, y: MID_Y, a: 0 };
  bullets = []; ebullets = []; enemies = [];
  spawnTable = buildSpawnTable(loopNo);
  spawnIdx = 0;
  for (const g of ghosts) g.cd = 0;
  gcombo = 0; gcomboT = 0;
  rec = {
    x: new Float32Array(LOOP_TICKS), y: new Float32Array(LOOP_TICKS),
    a: new Float32Array(LOOP_TICKS), s: new Uint8Array(LOOP_TICKS),
    hue: GHOST_HUES[(loopNo - 1) % GHOST_HUES.length], cd: 0,
  };
  if (!boss && loopNo % BOSS_EVERY === 0) {
    bossLevel++;
    const maxHp = BOSS_HP + BOSS_HP_STEP * (bossLevel - 1);
    boss = { hp: maxHp, maxHp, level: bossLevel };
    Snd.play('bossSpawn');
    tutorial('boss');
  }
  if (boss) {
    // ボスのいるループは通常の敵を約40%減らす（ボス弾と合わせて急に難しくなりすぎないように）
    spawnTable = spawnTable.filter((_, i) => !BOSS_LOOP_SPAWN_CUT.includes(i % 5));
    const p = bossPath(0), e = makeEnemy('boss', p.x, p.y, 60);
    e.hp = boss.hp;
    enemies.push(e);
  }
  Snd.setIntensity(Math.min(1, loopNo / 10));
  if (loopNo === 2) tutorial('loop2');
}

// ================= 更新 =================
function update() {
  if (hitstop > 0) { hitstop--; return; }        // ヒットストップ中は全て止める
  if (banner && --banner.t <= 0) banner = null;
  if (state === 'play') updatePlay();
  else if (state === 'clear') { if (++phaseT >= CLEAR_TICKS) openDraft(); }
  else if (state === 'draft') draftT++;
  else if (state === 'rewind') { if (++phaseT >= REWIND_TICKS) nextLoop(); }
  else if (state === 'over') overTicks++;
  updateParticles();
  shake *= 0.85;
  if (hurtFlash > 0) hurtFlash--;
}

function openDraft() {
  draft = rollDraft();
  draftT = 0;
  if (draft.length) state = 'draft'; else startRewind();
}

function pickUpgrade(i) {
  if (state !== 'draft' || draftT < DRAFT_GUARD || !draft[i]) return;
  const u = draft[i];
  u.apply(stats);
  taken[u.id] = (taken[u.id] || 0) + 1;
  Snd.play('upgradePick');
  const r = cardRect(i);
  puff(r.x + r.w / 2, r.y + r.h / 2, RARITY[u.rarity].color, 30, 6);
  startRewind();
}

function startRewind() {
  state = 'rewind';
  phaseT = 0;
  Snd.play('rewind');
}

function nextLoop() {
  ghosts.push(rec);
  while (ghosts.length > stats.maxGhosts) ghosts.shift();
  loopNo++;
  startLoop();
  state = 'play';
}

function updatePlay() {
  while (spawnIdx < spawnTable.length && spawnTable[spawnIdx].t <= tick) {
    const s = spawnTable[spawnIdx++];
    enemies.push(makeEnemy(s.type, s.x, s.y, SPAWN_WARN));
  }

  // プレイヤー移動（加速なし＝キビキビ）
  let dx = ((keys.KeyD || keys.ArrowRight) ? 1 : 0) - ((keys.KeyA || keys.ArrowLeft) ? 1 : 0);
  let dy = ((keys.KeyS || keys.ArrowDown) ? 1 : 0) - ((keys.KeyW || keys.ArrowUp) ? 1 : 0);
  if (dx && dy) { dx *= Math.SQRT1_2; dy *= Math.SQRT1_2; }
  if (touch.move) { const v = stickVec(touch.move); dx = v.x; dy = v.y; }
  player.x = clamp(player.x + dx * stats.speed, PLAYER_R, W - PLAYER_R);
  player.y = clamp(player.y + dy * stats.speed, HUD_H + PLAYER_R, H - PLAYER_R);

  let firing;
  if (isTouch) {
    // 照準スティック: 引いた方向に向き、押している間は撃ち続ける
    if (touch.aim) {
      const v = stickVec(touch.aim);
      if (v.len > 0) touch.angle = Math.atan2(v.y, v.x);
    }
    if (touch.angle !== null) player.a = touch.angle;
    firing = !!touch.aim;
  } else {
    player.a = Math.atan2(mouse.y - player.y, mouse.x - player.x);
    firing = mouse.down && !mouse.block;
  }

  if (tryFire(gun, firing)) {
    fireVolley(player.x, player.y, player.a, '#8ffcff', -1);
    Snd.play('shoot', { pan: panOf(player.x) });
  }

  // 記録（位置・照準角・トリガー）。射撃間隔などは再生時の能力値で決まる
  rec.x[tick] = player.x; rec.y[tick] = player.y; rec.a[tick] = player.a; rec.s[tick] = firing ? 1 : 0;

  // ゴースト再生: 記録したトリガーを現在の能力値で撃つ（アップグレードが過去の自分にも効く）
  for (const g of ghosts) {
    if (tryFire(g, g.s[tick])) {
      fireVolley(g.x[tick], g.y[tick], g.a[tick], ghostBulletColor(g.hue), g.hue);
      Snd.play('ghostShoot', { pan: panOf(g.x[tick]) });
    }
  }

  updateBullets();
  updateEnemies();
  bulletHits();
  playerHits();
  if (state !== 'play') return; // ゲームオーバー

  if (invuln > 0) invuln--;
  if (gcomboT > 0 && --gcomboT === 0) gcombo = 0;
  if (gcomboPop > 0) gcomboPop--;
  if (hitstopCd > 0) hitstopCd--;
  if (bossHitCd > 0) bossHitCd--;
  tick++;
  if (tick >= LOOP_TICKS) loopClear();
}

// 射撃クールダウン（プレイヤー・ゴースト共通）
function tryFire(shooter, held) {
  if (shooter.cd > 0) shooter.cd--;
  if (!held || shooter.cd > 0) return false;
  shooter.cd = stats.fireCd;
  return true;
}

function fireVolley(x, y, a, color, ghostHue) {
  const n = stats.spread;
  for (let i = 0; i < n; i++) {
    const ang = a + (i - (n - 1) / 2) * SPREAD_STEP;
    const c = Math.cos(ang), s = Math.sin(ang);
    bullets.push({
      x: x + c * 14, y: y + s * 14, vx: c * BULLET_SPEED, vy: s * BULLET_SPEED, life: BULLET_LIFE,
      color, ghostHue, r: stats.bulletR, dmg: stats.dmg, pierce: stats.pierce, hits: null,
    });
  }
}

function fireEnemyBullet(x, y, a, speed) {
  ebullets.push({ x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, r: 5, life: 600 });
}

function updateBullets() {
  for (const b of bullets) {
    b.x += b.vx; b.y += b.vy; b.life--;
    if (b.x < -10 || b.x > W + 10 || b.y < HUD_H - 10 || b.y > H + 10) b.life = 0;
  }
  bullets = bullets.filter((b) => b.life > 0);
  for (const b of ebullets) {
    b.x += b.vx; b.y += b.vy; b.life--;
    if (b.x < -10 || b.x > W + 10 || b.y < HUD_H - 10 || b.y > H + 10) b.life = 0;
  }
  ebullets = ebullets.filter((b) => b.life > 0);
}

function makeEnemy(type, x, y, warn) {
  const d = ENEMY[type];
  return {
    type, x, y, vx: 0, vy: 0, r: d.r, hp: Math.max(1, Math.round(d.hp * hpMul(loopNo))), warn, flash: 0,
    phase: 'aim', t: d.aimT || d.fireT || 0, ang: 0, dead: false,
  };
}

function updateEnemies() {
  for (const e of enemies) {
    const d = ENEMY[e.type];
    if (e.type === 'boss') { const p = bossPath(tick); e.x = p.x; e.y = p.y; }
    if (e.warn > 0) { e.warn--; continue; }
    if (e.flash > 0) e.flash--;
    const toP = Math.atan2(player.y - e.y, player.x - e.x);
    if (e.type === 'boss') { bossAttack(e, toP); continue; }
    if (e.type === 'charger') {
      if (e.phase === 'aim') {
        if (e.t === d.aimT) Snd.play('chargerWarn', { pan: panOf(e.x) });
        e.ang = toP;
        e.x += Math.cos(toP) * d.speed; e.y += Math.sin(toP) * d.speed;
        if (--e.t <= 0) { e.phase = 'dash'; e.t = d.dashT; }
      } else if (e.phase === 'dash') {
        e.x += Math.cos(e.ang) * d.dash; e.y += Math.sin(e.ang) * d.dash;
        if (frameCount % 2 === 0) puff(e.x, e.y, d.color, 1, 1.5);
        if (--e.t <= 0) { e.phase = 'rest'; e.t = d.restT; }
      } else if (--e.t <= 0) { e.phase = 'aim'; e.t = d.aimT; }
    } else if (e.type === 'turret') {
      // 射撃型: 一定距離まで寄って、溜めてから遅い弾を撃つ
      e.ang = toP;
      if (Math.hypot(player.x - e.x, player.y - e.y) > d.keep) {
        e.x += Math.cos(toP) * d.speed; e.y += Math.sin(toP) * d.speed;
      }
      if (--e.t <= 0) {
        fireEnemyBullet(e.x, e.y, toP, d.shot);
        e.t = d.fireT;
        Snd.play('enemyShot', { pan: panOf(e.x) });
      }
    } else {
      e.x += Math.cos(toP) * d.speed; e.y += Math.sin(toP) * d.speed;
    }
    e.x += e.vx; e.y += e.vy; e.vx *= 0.85; e.vy *= 0.85;
    e.x = clamp(e.x, e.r, W - e.r);
    e.y = clamp(e.y, HUD_H + e.r, H - e.r);
  }
  // 敵同士の押し合い（重なり防止）。ボスは押されない
  // ponytail: O(n^2)、敵数が数百を超えたら空間グリッドに
  for (let i = 0; i < enemies.length; i++) {
    const a = enemies[i];
    if (a.warn > 0) continue;
    for (let j = i + 1; j < enemies.length; j++) {
      const b = enemies[j];
      if (b.warn > 0) continue;
      const dx = b.x - a.x, dy = b.y - a.y, min = a.r + b.r;
      const d2 = dx * dx + dy * dy;
      if (d2 > 0 && d2 < min * min) {
        const d = Math.sqrt(d2), over = min - d;
        const nx = dx / d, ny = dy / d;
        if (a.type === 'boss') { b.x += nx * over; b.y += ny * over; }
        else if (b.type === 'boss') { a.x -= nx * over; a.y -= ny * over; }
        else { a.x -= nx * over / 2; a.y -= ny * over / 2; b.x += nx * over / 2; b.y += ny * over / 2; }
      }
    }
  }
}

function bossAttack(e, toP) {
  const ringEvery = boss.hp < boss.maxHp / 2 ? 60 : 90;   // HP半分以下で激しく
  if (tick % ringEvery === 30) {
    const n = 10 + 2 * boss.level, off = tick * 0.05;
    for (let i = 0; i < n; i++) fireEnemyBullet(e.x, e.y, off + i * Math.PI * 2 / n, 2.2);
    Snd.play('enemyShot', { pan: panOf(e.x) });
  }
  if (tick % 120 === 0 && tick > 0) {
    for (const s of [-1, 0, 1]) fireEnemyBullet(e.x, e.y, toP + s * 0.25, 3.2);
  }
}

function bulletHits() {
  for (const b of bullets) {
    for (const e of enemies) {
      if (e.warn > 0 || e.dead) continue;
      if (b.hits && b.hits.includes(e)) continue;
      const dx = b.x - e.x, dy = b.y - e.y, rr = e.r + b.r;
      if (dx * dx + dy * dy >= rr * rr) continue;
      damageEnemy(e, b.dmg, b);
      puff(b.x, b.y, b.color, 3, 2.5);
      if (b.ghostHue >= 0 && stats.ghostBlast > 0) ghostBlast(b, e);
      if (b.pierce > 0) { b.pierce--; (b.hits || (b.hits = [])).push(e); }
      else { b.life = 0; break; }
    }
  }
  bullets = bullets.filter((b) => b.life > 0);
  enemies = enemies.filter((e) => !e.dead);
}

// ゴースト炸裂弾: 着弾点の周りの敵にも1ダメージ
function ghostBlast(b, hitEnemy) {
  const R = 34 + 14 * (stats.ghostBlast - 1);
  addFx({ kind: 'ring', x: b.x, y: b.y, r: 6, grow: R - 6, life: 12, max: 12, color: b.color });
  for (const o of enemies) {
    if (o === hitEnemy || o.dead || o.warn > 0) continue;
    const dx = o.x - b.x, dy = o.y - b.y, rr = R + o.r;
    if (dx * dx + dy * dy < rr * rr) damageEnemy(o, 1, b);
  }
}

function damageEnemy(e, dmg, b) {
  e.hp -= dmg;
  e.flash = 5;
  if (e.type === 'boss') {
    boss.hp = Math.max(0, e.hp);
    if (bossHitCd === 0) { Snd.play('bossHit', { pan: panOf(e.x) }); bossHitCd = 4; }
    if (e.hp <= 0) killBoss(e, b);
    return;
  }
  // ノックバックは上限つき（弾幕で敵が壁に張り付いて永久に近づけない、を防ぐ）
  e.vx += b.vx * 0.08; e.vy += b.vy * 0.08;
  const kv = Math.hypot(e.vx, e.vy);
  if (kv > KNOCK_MAX) { e.vx *= KNOCK_MAX / kv; e.vy *= KNOCK_MAX / kv; }
  Snd.play('hit', { pan: panOf(e.x) });
  if (e.hp <= 0) killEnemy(e, b);
}

function killEnemy(e, b) {
  e.dead = true;
  kills++;
  const d = ENEMY[e.type], big = e.type === 'splitter';
  if (b.ghostHue >= 0) {
    // ゴーストの撃破: ゴースト色のリング＋HUD横のコンボ表示（浮き文字は積み重なるので出さない）
    ghostKills++;
    score += GHOST_KILL_SCORE;
    addFx({ kind: 'ring', x: e.x, y: e.y, r: e.r, grow: 28, life: 22, max: 22, color: ghostBulletColor(b.ghostHue) });
    gcombo++; gcomboT = 90; gcomboPop = 8;
    Snd.play('ghostKill', { pan: panOf(e.x) });
  } else {
    score++;
    Snd.play('enemyDie', { pan: panOf(e.x) });
  }
  puff(e.x, e.y, d.color, big ? 30 : 18, big ? 5 : 4.5);
  puff(e.x, e.y, '#ffffff', 5, 2);
  addFx({ kind: 'ring', x: e.x, y: e.y, r: e.r * 0.6, grow: 18, life: 14, max: 14, color: d.color });
  shake = Math.max(shake, big ? 5 : 3);
  if (hitstopCd === 0) { hitstop = big ? 3 : 2; hitstopCd = 10; }
  if (big) {
    Snd.play('split', { pan: panOf(e.x) });
    for (const s of [-1, 1]) {
      const a = Math.atan2(player.y - e.y, player.x - e.x) + s * Math.PI / 2;
      const m = makeEnemy('mini', e.x + Math.cos(a) * 10, e.y + Math.sin(a) * 10, 0);
      m.vx = Math.cos(a) * 5; m.vy = Math.sin(a) * 5;
      enemies.push(m);
    }
  }
}

function killBoss(e, b) {
  e.dead = true;
  kills++; bossKills++;
  if (b.ghostHue >= 0) ghostKills++;
  const bonus = 100 * boss.level;
  score += bonus;
  addFx({ kind: 'text', x: e.x, y: e.y - 50, life: 90, max: 90, color: '#ffe14d', size: 24, text: T('bossKill', { n: bonus }) });
  for (let i = 0; i < 4; i++) addFx({ kind: 'ring', x: e.x, y: e.y, r: 20 + i * 10, grow: 80 + i * 30, life: 30 + i * 8, max: 30 + i * 8, color: i % 2 ? '#ffffff' : ENEMY.boss.color });
  puff(e.x, e.y, ENEMY.boss.color, 80, 9);
  puff(e.x, e.y, '#ffe14d', 40, 6);
  shake = 20; hitstop = 24; hitstopCd = 30;
  Snd.play('bossDie', { pan: panOf(e.x) });
  vibrate(150);
  boss = null;
}

function playerHits() {
  if (invuln > 0) return;
  for (const b of ebullets) {
    const dx = b.x - player.x, dy = b.y - player.y, rr = b.r + PLAYER_R - 3;
    if (dx * dx + dy * dy < rr * rr) { b.life = 0; hurtPlayer(); return; }
  }
  for (const e of enemies) {
    if (e.warn > 0) continue;
    const dx = e.x - player.x, dy = e.y - player.y, rr = e.r + PLAYER_R - 2;
    if (dx * dx + dy * dy < rr * rr) {
      if (e.type !== 'boss') {
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        e.vx += dx / d * 9; e.vy += dy / d * 9;
        if (e.type === 'charger') { e.phase = 'rest'; e.t = ENEMY.charger.restT; }
      }
      hurtPlayer();
      return;
    }
  }
}

function hurtPlayer() {
  hp--;
  invuln = INVULN_TICKS;
  shake = 12; hurtFlash = 14;
  puff(player.x, player.y, '#ffffff', 20, 5);
  Snd.play('playerHurt');
  vibrate(hp <= 0 ? 200 : 60);
  if (hp <= 0) gameOver();
}

function loopClear() {
  lastBonus = loopNo * 10;
  score += lastBonus;
  const before = hp;
  if (loopNo < HEAL_UNTIL) hp = Math.min(stats.maxHp, hp + LOOP_HEAL);
  healed = hp > before;
  for (const e of enemies) puff(e.x, e.y, ENEMY[e.type].color, 8, 3);
  enemies = []; bullets = []; ebullets = [];   // ボスのHPは boss に残る
  state = 'clear';
  phaseT = 0;
  shake = 6;
  Snd.play('loopClear');
}

function gameOver() {
  state = 'over';
  overTicks = 0;
  touch.move = touch.aim = null;
  puff(player.x, player.y, '#8ffcff', 50, 7);
  shake = 16;
  Snd.play('gameOver');
  if (score > best) { best = score; newBest = true; saveBest(best); Snd.play('newBest'); }
}

// ================= パーティクル（見た目のみ・非決定でOK） =================
function addFx(f) {
  fx.push(f);
  if (fx.length > MAX_FX) fx.splice(0, fx.length - MAX_FX);
}
function puff(x, y, color, n, spd) {
  for (let i = 0; i < n && particles.length < MAX_PARTICLES; i++) {
    const a = Math.random() * Math.PI * 2, v = Math.random() * spd + 0.5;
    const life = 18 + Math.random() * 18;
    particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life, max: life, color, size: 1.5 + Math.random() * 3 });
  }
}
function updateParticles() {
  for (const p of particles) { p.x += p.vx; p.y += p.vy; p.vx *= 0.92; p.vy *= 0.92; p.life--; }
  particles = particles.filter((p) => p.life > 0);
  for (const f of fx) { f.life--; if (f.kind === 'text') f.y -= 0.6; }
  fx = fx.filter((f) => f.life > 0);
}

// ================= 描画 =================
function syncMusic() {
  const m = state === 'title' ? 'title' : state === 'over' ? 'off' : boss ? 'boss' : 'play';
  if (m !== curMusic) { curMusic = m; Snd.music(m); }
}

function draw() {
  frameCount++;
  ctx.setTransform(viewScale, 0, 0, viewScale, 0, 0);
  ctx.fillStyle = '#0a0a16';
  ctx.fillRect(0, 0, W, H);
  screenNow();

  ctx.save();
  if (settings.shake && shake > 0.3) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
  drawGrid();
  if (state === 'title') {
    drawParticles();
    ctx.restore();
    drawTitle();
  } else {
    if (isPortrait() && !paused) pause();
    drawWorld();
    ctx.restore();
    drawHUD();
    drawBossBar();
    drawBanner();
    if (!paused) {
      if (state === 'clear') drawClear();
      if (state === 'draft') drawDraft();
      if (state === 'rewind') drawRewind();
    }
    if (state === 'over') drawOver();
    if (hurtFlash > 0) {
      if (settings.flash) {
        ctx.fillStyle = `rgba(255,40,80,${hurtFlash / 35})`;
        ctx.fillRect(0, 0, W, H);
      } else {
        // フラッシュOFF: 画面全体は光らせず、縁だけ赤くする
        ctx.strokeStyle = `rgba(255,40,80,${hurtFlash / 14})`;
        ctx.lineWidth = 8;
        ctx.strokeRect(4, 4, W - 8, H - 8);
      }
    }
    drawSticks();
    if (paused && !menu) drawPause();
  }
  if (menu === 'settings') drawSettings();
  else if (menu === 'howto') drawHowto();
  drawToast();
  if (isPortrait()) drawPortrait();
}

function drawPortrait() {
  ctx.fillStyle = '#05050b';
  ctx.fillRect(0, 0, W, H);
  text('⟳', W / 2, H / 2 - 50, 64, '#8ffcff');
  text(T('portrait'), W / 2, H / 2 + 30, 40, '#ffffff');
}

function drawSticks() {
  if (!touch.move && !touch.aim) return;
  const r = canvas.getBoundingClientRect(), k = W / r.width; // CSS px → 論理px
  for (const s of [touch.move, touch.aim]) {
    if (!s) continue;
    const o = toLogical(s.ox, s.oy);
    const ox = clamp(o.x, 0, W), oy = clamp(o.y, 0, H);
    const R = JOY_PX * k;
    let dx = (s.x - s.ox) * k, dy = (s.y - s.oy) * k;
    const len = Math.hypot(dx, dy);
    if (len > R) { dx *= R / len; dy *= R / len; }
    const color = s === touch.aim ? '255,59,141' : '143,252,255';
    ctx.fillStyle = `rgba(${color},0.12)`;
    ctx.strokeStyle = `rgba(${color},0.45)`;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(ox, oy, R, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = `rgba(${color},0.45)`;
    ctx.beginPath(); ctx.arc(ox + dx, oy + dy, R * 0.4, 0, Math.PI * 2); ctx.fill();
  }
}

function drawGrid() {
  ctx.strokeStyle = 'rgba(90,100,255,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= W; x += 40) { ctx.moveTo(x + 0.5, HUD_H); ctx.lineTo(x + 0.5, H); }
  for (let y = HUD_H; y <= H; y += 40) { ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); }
  ctx.stroke();
}

function drawWorld() {
  // 幕間（クリア/選択/巻き戻し）はプレイヤーもゴーストも描かない（文字と重ならないように）
  const idx = Math.min(tick, LOOP_TICKS - 1);
  if (state === 'play' || state === 'over') {
    if (state === 'play' && settings.ghostTrail) drawGhostTrails(idx);
    for (const g of ghosts) drawShip(g.x[idx], g.y[idx], g.a[idx], ghostColor(g.hue), GHOST_ALPHA, false);
  }
  if (state === 'rewind') drawRewindPaths();
  drawEnemies();
  drawBullets();
  drawEnemyBullets();
  drawFx();
  drawParticles();
  // プレイヤーは最前面。白い輪で、ゴーストの群れの中でも見失わない
  if (state === 'play') {
    const blink = invuln > 0 && Math.floor(invuln / 4) % 2 === 0;
    drawPlayer(player.x, player.y, player.a, blink ? 0.35 : 1);
  }
}

function drawPlayer(x, y, a, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = 'lighter';
  drawGlow('#8ffcff', x, y, 14);
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x, y, PLAYER_R + 6, 0, Math.PI * 2); ctx.stroke();
  const pulse = 0.25 + 0.2 * Math.sin(frameCount * 0.15);
  ctx.strokeStyle = `rgba(143,252,255,${pulse})`;
  ctx.beginPath(); ctx.arc(x, y, PLAYER_R + 11, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
  drawShip(x, y, a, '#8ffcff', alpha, true);
}

// 巻き戻し: 記録した経路（自分＋ゴースト）を高速で逆再生し、軌跡を残す
function drawRewindPaths() {
  const idx = Math.max(0, Math.round((1 - phaseT / REWIND_TICKS) * (LOOP_TICKS - 1)));
  const tail = 120, chunk = 20;
  const path = (g, color, width) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    for (let c = 0; c < tail / chunk; c++) {
      const a = idx + c * chunk, b = Math.min(LOOP_TICKS - 1, a + chunk);
      if (a >= LOOP_TICKS - 1) break;
      ctx.globalAlpha = 0.85 * (1 - c / (tail / chunk));
      ctx.beginPath();
      ctx.moveTo(g.x[a], g.y[a]);
      for (let t = a + 2; t <= b; t += 2) ctx.lineTo(g.x[t], g.y[t]);
      ctx.stroke();
    }
  };
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  for (const g of ghosts) path(g, ghostBulletColor(g.hue), 2);
  path(rec, '#8ffcff', 3);
  ctx.restore();
  for (const g of ghosts) drawShip(g.x[idx], g.y[idx], g.a[idx], ghostColor(g.hue), GHOST_ALPHA, false);
  drawPlayer(rec.x[idx], rec.y[idx], rec.a[idx], 1);
}

// 各ゴーストの0.7秒先までの経路を薄く表示
function drawGhostTrails(idx) {
  const end = Math.min(LOOP_TICKS - 1, idx + TRAIL_TICKS);
  if (end <= idx) return;
  ctx.save();
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.3;
  ctx.setLineDash([3, 5]);
  for (const g of ghosts) {
    ctx.strokeStyle = ghostColor(g.hue);
    ctx.beginPath();
    ctx.moveTo(g.x[idx], g.y[idx]);
    for (let t = idx + 3; t <= end; t += 3) ctx.lineTo(g.x[t], g.y[t]);
    ctx.stroke();
  }
  ctx.restore();
}

function drawBullets() {
  // 色ごとにまとめて1回で描く（弾が数百発でも軽い）
  const groups = new Map();
  for (const b of bullets) {
    let arr = groups.get(b.color);
    if (!arr) groups.set(b.color, (arr = []));
    arr.push(b);
  }
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(3, stats.bulletR * 1.3);
  for (const [color, arr] of groups) {
    ctx.strokeStyle = color;
    ctx.beginPath();
    for (const b of arr) { ctx.moveTo(b.x - b.vx * 0.8, b.y - b.vy * 0.8); ctx.lineTo(b.x, b.y); }
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
}

function drawEnemyBullets() {
  if (!ebullets.length) return;
  const layers = [['rgba(255,107,74,0.3)', 4], ['#ff6b4a', 0], ['#ffffff', -2.8]];
  for (const [color, grow] of layers) {
    ctx.fillStyle = color;
    ctx.beginPath();
    for (const b of ebullets) {
      if (b.life <= 0) continue;
      ctx.moveTo(b.x + b.r + grow, b.y);
      ctx.arc(b.x, b.y, b.r + grow, 0, Math.PI * 2);
    }
    ctx.fill();
  }
}

function drawFx() {
  for (const f of fx) {
    const k = f.life / f.max;
    ctx.globalAlpha = k;
    if (f.kind === 'ring') {
      ctx.strokeStyle = f.color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r + (1 - k) * f.grow, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      text(f.text, f.x, f.y, f.size, f.color);
    }
  }
  ctx.globalAlpha = 1;
}

function drawShip(x, y, a, color, alpha, glow) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x + Math.cos(a) * 6, y + Math.sin(a) * 6);
  ctx.lineTo(x + Math.cos(a) * 20, y + Math.sin(a) * 20);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, PLAYER_R, 0, Math.PI * 2);
  ctx.fill();
  if (!glow) { ctx.globalAlpha = Math.min(1, alpha + 0.25); ctx.lineWidth = 1.5; ctx.stroke(); }
  ctx.restore();
}

function poly(x, y, r, n, rot) {
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const a = rot + i * Math.PI * 2 / n;
    ctx[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  ctx.closePath();
}

function drawEnemies() {
  ctx.globalCompositeOperation = 'lighter';
  for (const e of enemies) {
    if (e.warn > 0) continue;
    drawGlow(ENEMY[e.type].color, e.x, e.y, e.type === 'boss' ? e.r + 6 : e.r);
  }
  ctx.globalCompositeOperation = 'source-over';
  for (const e of enemies) drawEnemy(e);
}

function drawEnemy(e) {
  const d = ENEMY[e.type];
  ctx.save();
  if (e.warn > 0) {
    // 出現予告: 縮む点線リング
    const k = e.warn / (e.type === 'boss' ? 60 : SPAWN_WARN);
    ctx.globalAlpha = 0.35 + 0.35 * Math.sin(frameCount * 0.4);
    ctx.strokeStyle = d.color;
    ctx.lineWidth = e.type === 'boss' ? 4 : 2;
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.arc(e.x, e.y, e.r + k * 22, frameCount * 0.05, frameCount * 0.05 + Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    return;
  }
  let x = e.x, y = e.y;
  if (e.type === 'charger' && e.phase === 'aim') {
    // 溜め: 照準線（だんだん濃く）＋終盤は震える
    const k = 1 - e.t / d.aimT;
    ctx.strokeStyle = `rgba(255,154,46,${0.1 + k * 0.5})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(e.ang) * 160, y + Math.sin(e.ang) * 160);
    ctx.stroke();
    if (e.t < 15) { x += (Math.random() - 0.5) * 4; y += (Math.random() - 0.5) * 4; }
  }
  const color = e.flash > 0 ? '#ffffff' : d.color;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  if (e.type === 'chaser') {
    poly(x, y, e.r, 3, Math.atan2(player.y - y, player.x - x));
    ctx.fill();
  } else if (e.type === 'charger') {
    poly(x, y, e.r + 2, 4, e.ang);
    ctx.fill();
  } else if (e.type === 'splitter') {
    poly(x, y, e.r, 6, frameCount * 0.02);
    ctx.globalAlpha = 0.35; ctx.fill(); ctx.globalAlpha = 1; ctx.stroke();
    poly(x, y, e.r * 0.45, 6, -frameCount * 0.04);
    ctx.fill();
  } else if (e.type === 'turret') {
    // 砲台: 四角い胴＋砲身。発射前は砲口が光って予告
    poly(x, y, e.r, 4, Math.PI / 4);
    ctx.globalAlpha = 0.4; ctx.fill(); ctx.globalAlpha = 1; ctx.stroke();
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(e.ang) * (e.r + 8), y + Math.sin(e.ang) * (e.r + 8));
    ctx.stroke();
    if (e.t < d.warnT) {
      const k = 1 - e.t / d.warnT;
      ctx.fillStyle = '#ffffff';
      ctx.globalAlpha = 0.4 + 0.6 * k;
      ctx.beginPath();
      ctx.arc(x + Math.cos(e.ang) * (e.r + 8), y + Math.sin(e.ang) * (e.r + 8), 2 + 5 * k, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (e.type === 'boss') {
    poly(x, y, e.r, 6, frameCount * 0.015);
    ctx.globalAlpha = 0.3; ctx.fill(); ctx.globalAlpha = 1;
    ctx.lineWidth = 4; ctx.stroke();
    poly(x, y, e.r * 0.62, 6, -frameCount * 0.03);
    ctx.lineWidth = 2; ctx.stroke();
    const toP = Math.atan2(player.y - y, player.x - x);
    ctx.fillStyle = e.flash > 0 ? '#ffffff' : '#ffe0e8';
    ctx.beginPath();
    ctx.arc(x + Math.cos(toP) * 8, y + Math.sin(toP) * 8, 9, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.arc(x, y, e.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawParticles() {
  ctx.globalCompositeOperation = 'lighter';
  for (const p of particles) {
    ctx.globalAlpha = p.life / p.max;
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

function wrapText(str, maxW, size, weight = 'normal') {
  ctx.font = `${weight} ${fontPx(size)}px ${FONT}`;
  const parts = str.includes(' ') ? str.split(' ') : [...str], sep = str.includes(' ') ? ' ' : '';
  const lines = [];
  let cur = '';
  for (const p of parts) {
    const next = cur ? cur + sep + p : p;
    if (cur && ctx.measureText(next).width > maxW) { lines.push(cur); cur = p; } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}
// 論理pxの文字サイズを、画面上で MIN_FONT_CSS 未満にならないよう底上げ
// cap the boost at 1.35x: real phones (>=568px landscape) need less, and tiny windows would otherwise blow the layout apart
const fontPx = (size) => Math.max(size, Math.min(size * 1.35, MIN_FONT_CSS / cssScale));
function text(str, x, y, size, color, align = 'center', weight = 'bold') {
  ctx.font = `${weight} ${fontPx(size)}px ${FONT}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  // the CSS-px font floor can make long lines wider than the screen on narrow
  // viewports; maxWidth squeezes them to stay on-canvas
  const room = align === 'left' ? W - x : align === 'right' ? x : 2 * Math.min(x, W - x);
  ctx.fillText(str, x, y, Math.max(40, room - 24));
}

function drawHUD() {
  ctx.fillStyle = 'rgba(8,8,20,0.85)';
  ctx.fillRect(0, 0, W, HUD_H);
  ctx.fillStyle = 'rgba(120,130,255,0.3)';
  ctx.fillRect(0, HUD_H - 1, W, 1);

  text(`LOOP ${loopNo}`, 16, 22, 22, '#8ffcff', 'left');

  // 残り時間バー（幕間は REWIND 表示）
  const bx = 130, bw = 300, by = 16, bh = 12;
  const playing = state === 'play';
  const remain = playing ? 1 - tick / LOOP_TICKS : 0;
  ctx.strokeStyle = 'rgba(143,252,255,0.5)';
  ctx.lineWidth = 1;
  ctx.strokeRect(bx + 0.5, by + 0.5, bw, bh);
  ctx.fillStyle = remain < 0.25 ? '#ff3b8d' : '#8ffcff';
  ctx.fillRect(bx + 2, by + 2, (bw - 3) * remain, bh - 3);
  if (playing) text(T('secs', { n: Math.ceil(remain * 10) }), bx + bw + 10, 22, 14, '#9aa', 'left', 'normal');
  else if (state === 'rewind') text(T('rewindHud'), bx + bw / 2, 22, 13, '#c9a6ff');

  // HP
  for (let i = 0; i < stats.maxHp; i++) {
    text('♥', 500 + i * 20, 22, 19, i < hp ? '#ff3b8d' : '#333348');
  }
  text(T('hudGhosts', { a: ghosts.length, b: stats.maxGhosts }), 640, 22, 14, '#c9a6ff', 'left', 'normal');
  text(T('hudScore', { n: score }), PAUSE_BTN.x - 12, 22, 18, '#ffffff', 'right');
  // ゴースト撃破コンボ（撃破のたびに少し大きく脈打つ）
  if (gcombo > 0 && state === 'play') {
    ctx.save();
    ctx.globalAlpha = Math.min(1, gcomboT / 20);
    text(`GHOST ×${gcombo}`, W - 16, HUD_H + 22, 18 + gcomboPop * 1.2, ghostBulletColor(GHOST_HUES[0]), 'right');
    ctx.restore();
  }
  // 一時停止ボタン（クリック/タップ可）
  if (ACTIVE[state]) {
    const b = PAUSE_BTN;
    ctx.strokeStyle = 'rgba(143,252,255,0.6)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w, b.h);
    ctx.fillStyle = '#8ffcff';
    if (paused) { poly(b.x + b.w / 2 + 1, b.y + b.h / 2, 8, 3, 0); ctx.fill(); }
    else { ctx.fillRect(b.x + 12, b.y + 8, 5, 16); ctx.fillRect(b.x + 21, b.y + 8, 5, 16); }
  }
}

function drawBossBar() {
  if (!boss || !ACTIVE[state]) return;
  const x = 240, w = 480, y = HUD_H + 8, h = 10;
  ctx.fillStyle = 'rgba(8,8,20,0.8)';
  ctx.fillRect(x - 70, y - 4, w + 140, h + 8);
  text(T('bossLv', { n: boss.level }), x - 10, y + h / 2, 13, ENEMY.boss.color, 'right');
  ctx.strokeStyle = 'rgba(255,46,99,0.7)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  ctx.fillStyle = ENEMY.boss.color;
  ctx.fillRect(x + 2, y + 2, (w - 3) * boss.hp / boss.maxHp, h - 3);
  text(`${Math.ceil(boss.hp)}`, x + w + 10, y + h / 2, 12, '#ffd0dc', 'left', 'normal');
}

function drawBanner() {
  if (!banner || !ACTIVE[state] || state === 'draft' || paused) return;
  const y = boss ? HUD_H + 48 : HUD_H + 30;
  const k = Math.min(1, banner.t / 20, (banner.max - banner.t) / 10);
  ctx.globalAlpha = k;
  ctx.font = `bold ${fontPx(16)}px ${FONT}`;
  const w = ctx.measureText(banner.text).width + 36;
  ctx.fillStyle = 'rgba(12,12,36,0.85)';
  ctx.fillRect(W / 2 - w / 2, y - 16, w, 32);
  ctx.strokeStyle = 'rgba(201,166,255,0.6)';
  ctx.strokeRect(W / 2 - w / 2 + 0.5, y - 15.5, w - 1, 31);
  text(banner.text, W / 2, y, 16, '#ffffff');
  ctx.globalAlpha = 1;
}

function drawClear() {
  ctx.fillStyle = `rgba(40,20,90,${0.35 * Math.min(1, phaseT / 10)})`;
  ctx.fillRect(0, HUD_H, W, H - HUD_H);
  ctx.save();
  ctx.shadowColor = '#c9a6ff'; ctx.shadowBlur = 20;
  text(T('loopClear', { n: loopNo }), W / 2, H / 2 - 30, 44, '#ffffff');
  ctx.restore();
  text(T('loopBonus', { n: lastBonus }) + (healed ? T('hpUp') : ''), W / 2, H / 2 + 20, 18, '#c9a6ff');
  if (boss) {
    const pct = Math.ceil(boss.hp / boss.maxHp * 100);
    text(T('bossCarry', { p: pct }), W / 2, H / 2 + 52, 16, ENEMY.boss.color, 'center', 'normal');
  }
}

function drawDraft() {
  const k = Math.min(1, draftT / DRAFT_GUARD);
  ctx.fillStyle = 'rgba(5,5,14,0.85)';
  ctx.fillRect(0, HUD_H, W, H - HUD_H);
  text(T('draftTitle'), W / 2, 95, 30, '#ffffff');
  text(T('draftSub'), W / 2, 132, 15, '#c9a6ff', 'center', 'normal');
  const hover = draftPress.card >= 0 ? draftPress.card : (isTouch ? -1 : cardAt(mouse));
  draft.forEach((u, i) => {
    const r = cardRect(i), rar = RARITY[u.rarity];
    const y = r.y + (1 - k) * 30;
    ctx.save();
    ctx.globalAlpha = 0.4 + 0.6 * k;
    ctx.fillStyle = hover === i ? 'rgba(40,40,80,0.98)' : 'rgba(18,18,40,0.96)';
    ctx.fillRect(r.x, y, r.w, r.h);
    ctx.shadowColor = rar.color; ctx.shadowBlur = hover === i ? 22 : 10;
    ctx.strokeStyle = rar.color;
    ctx.lineWidth = hover === i ? 4 : 2;
    ctx.strokeRect(r.x + 1, y + 1, r.w - 2, r.h - 2);
    ctx.shadowBlur = 0;
    text(T('rarity' + u.rarity), r.x + r.w / 2, y + 22, 12, rar.color);
    text(u.icon, r.x + r.w / 2, y + 78, 46, rar.color);
    text(T('up_' + u.id), r.x + r.w / 2, y + 136, 22, '#ffffff');
    T('upd_' + u.id).split('\n').forEach((line, j) => text(line, r.x + r.w / 2, y + 170 + j * 20, 14, '#d8dcff', 'center', 'normal'));
    const owned = taken[u.id] || 0;
    if (owned) text(T('owned', { a: owned, b: u.max }), r.x + 12, y + r.h - 16, 12, '#9aa', 'left', 'normal');
    if (!isTouch) text(`[${i + 1}]`, r.x + r.w - 12, y + r.h - 16, 13, '#9aa', 'right', 'normal');
    ctx.restore();
  });
  text(T(isTouch ? 'draftHintTouch' : 'draftHintPc'), W / 2, 445, 14, '#9aa', 'center', 'normal');
}

function drawRewind() {
  const k = phaseT / REWIND_TICKS;
  // 最初だけうっすら白く（フラッシュOFFなら無し）
  if (settings.flash && phaseT < 8) {
    ctx.fillStyle = `rgba(200,230,255,${0.16 * (1 - phaseT / 8)})`;
    ctx.fillRect(0, 0, W, H);
  }
  // 走査線＋横ズレのノイズ帯（軌跡が見えるよう薄め）
  ctx.fillStyle = 'rgba(0,0,0,0.16)';
  for (let y = HUD_H; y < H; y += 4) ctx.fillRect(0, y, W, 2);
  for (let i = 0; i < 3; i++) {
    const y = HUD_H + Math.random() * (H - HUD_H), h = 3 + Math.random() * 12;
    ctx.fillStyle = `rgba(143,252,255,${0.05 + Math.random() * 0.07})`;
    ctx.fillRect(0, y, W, h);
  }
  ctx.fillStyle = `rgba(80,40,160,${0.18 * (1 - k)})`;
  ctx.fillRect(0, HUD_H, W, H - HUD_H);
  ctx.save();
  ctx.shadowColor = '#8ffcff'; ctx.shadowBlur = 16;
  text(T('rewinding'), W / 2 + (settings.shake ? (Math.random() - 0.5) * 4 : 0), HUD_H + 50, 30, '#ffffff');
  ctx.restore();
  text(`LOOP ${loopNo + 1}`, W / 2, HUD_H + 82, 16, '#8ffcff');
}

function drawTitle() {
  ctx.save();
  ctx.shadowColor = '#8ffcff'; ctx.shadowBlur = 24;
  text(T('titleMain'), W / 2, 110, 60, '#8ffcff');
  ctx.restore();
  text(T('titleSub'), W / 2, 160, 18, '#c9a6ff', 'center', 'normal');
  text('v1.0', W - 14, 18, 13, '#667', 'right', 'normal');
  const lines = [T(isTouch ? 'howLine1Touch' : 'howLine1Pc'), T('howLine2'), T('howLine3')];
  lines.forEach((l, i) => text(l, W / 2, 214 + i * 30, 16, '#d8dcff', 'center', 'normal'));
  if (best > 0) text(T('bestScore', { n: best }), W / 2, 304, 16, '#ffe14d', 'center', 'normal');
  drawWidgets(widgets('title'));
  if (!isTouch) text(T('keyHint'), W / 2, 510, 13, '#667', 'center', 'normal');
}

// 取得アップグレードを「名前×数」で並べ、幅に収まるよう折り返す
function upgradeLines(maxW, size) {
  const tokens = Object.keys(taken).map((id) => {
    const max = UPGRADES.find((u) => u.id === id).max;
    return max > 1 ? `${T('up_' + id)} (${taken[id]}/${max})` : T('up_' + id);
  });
  if (!tokens.length) return [T('none')];
  ctx.font = `normal ${fontPx(size)}px ${FONT}`;
  const lines = [];
  let cur = '';
  for (const t of tokens) {
    const next = cur ? `${cur}　${t}` : t;
    if (cur && ctx.measureText(next).width > maxW) { lines.push(cur); cur = t; } else cur = next;
  }
  lines.push(cur);
  return lines;
}

function drawOver() {
  ctx.fillStyle = 'rgba(5,5,12,0.8)';
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.shadowColor = '#ff3b8d'; ctx.shadowBlur = 24;
  text(T('gameOver'), W / 2, 82, 48, '#ff3b8d');
  ctx.restore();
  text(T('score', { n: score }), W / 2, 142, 32, '#ffffff');
  text(T('best', { n: best }) + (newBest ? T('newBest') : ''), W / 2, 180, 18, newBest ? '#ffe14d' : '#c9a6ff');
  text(T('stats', { l: loopNo, k: kills, g: ghostKills, b: bossKills }), W / 2, 222, 17, '#d8dcff', 'center', 'normal');
  text(T('upgrades'), W / 2, 262, 13, '#9aa', 'center', 'normal');
  upgradeLines(780, 15).slice(0, 4).forEach((l, i) => text(l, W / 2, 288 + i * 23, 15, '#8ffcff', 'center', 'normal'));
  drawWidgets(widgets('over'));
  if (!isTouch) text(T('retryKey'), W / 2, 472, 13, '#667', 'center', 'normal');
}

function drawPause() {
  ctx.fillStyle = 'rgba(5,5,12,0.72)';
  ctx.fillRect(0, 0, W, H);
  text(T('paused'), W / 2, 100, 40, '#ffffff');
  drawWidgets(widgets('pause'));
  if (!isTouch) text(T('pauseHint'), W / 2, 466, 13, '#9aa', 'center', 'normal');
}

function drawSettings() {
  ctx.fillStyle = '#07070f';
  ctx.fillRect(0, 0, W, H);
  text(T('settings'), W / 2, 54, 30, '#ffffff');
  drawWidgets(widgets('settings'));
  if (!isTouch) text(T('settingsHint'), W / 2, 504, 13, '#667', 'center', 'normal');
}

// 遊び方: 「動く → 巻き戻る → ゴーストと戦う」を3コマの図で見せる
function drawHowto() {
  ctx.fillStyle = '#07070f';
  ctx.fillRect(0, 0, W, H);
  text(T('howTitle'), W / 2, 46, 28, '#ffffff');
  const caps = [T('how1'), T('how2'), T('how3')];
  for (let i = 0; i < 3; i++) {
    const x = 45 + i * 300, y = 78, w = 270, h = 200;
    ctx.fillStyle = 'rgba(18,18,40,0.92)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(143,252,255,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h - 46); ctx.clip();
    drawHowPanel(i, x, y, w);
    ctx.restore();
    const lines = wrapText(caps[i], w - 16, 13).slice(0, 2), lh = fontPx(13) + 3;
    lines.forEach((l, j) => text(l, x + w / 2, y + h - 24 - (lines.length - 1) * lh / 2 + j * lh, 13, '#d8dcff', 'center', 'normal'));
    if (i < 2) text('▶', x + w + 15, y + h / 2, 18, '#c9a6ff');
  }
  text(T('howPc'), W / 2, 318, 15, isTouch ? '#778' : '#8ffcff', 'center', 'normal');
  text(T('howTouch'), W / 2, 346, 15, isTouch ? '#8ffcff' : '#778', 'center', 'normal');
  text(T('howTips'), W / 2, 392, 15, '#ffe14d', 'center', 'normal');
  drawWidgets(widgets('howto'));
}

function drawHowPanel(i, x, y, w) {
  const u = (frameCount % 150) / 150;
  const path = (t) => ({ x: x + 40 + t * (w - 110), y: y + 112 - Math.sin(t * Math.PI) * 60 });
  const enemyA = { x: x + w - 40, y: y + 56 }, enemyB = { x: x + w - 50, y: y + 124 };
  // 経路（点線）
  ctx.setLineDash([3, 5]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = i === 0 ? 'rgba(143,252,255,0.5)' : 'rgba(61,255,138,0.5)';
  ctx.beginPath();
  for (let t = 0; t <= 1.001; t += 0.05) { const p = path(t); ctx[t ? 'lineTo' : 'moveTo'](p.x, p.y); }
  ctx.stroke();
  ctx.setLineDash([]);
  const p = path(u), a = Math.atan2(enemyA.y - p.y, enemyA.x - p.x);
  const shots = (from, to, color) => {
    ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.lineCap = 'round';
    const ang = Math.atan2(to.y - from.y, to.x - from.x), d = Math.hypot(to.x - from.x, to.y - from.y);
    for (let s = (frameCount * 4) % 30; s < d - 14; s += 30) {
      ctx.beginPath();
      ctx.moveTo(from.x + Math.cos(ang) * s, from.y + Math.sin(ang) * s);
      ctx.lineTo(from.x + Math.cos(ang) * (s + 8), from.y + Math.sin(ang) * (s + 8));
      ctx.stroke();
    }
  };
  const enemy = (e) => { ctx.fillStyle = ENEMY.chaser.color; poly(e.x, e.y, 12, 3, Math.PI); ctx.fill(); };
  if (i === 0) {
    enemy(enemyA);
    shots(p, enemyA, '#8ffcff');
    drawPlayer(p.x, p.y, a, 1);
  } else if (i === 1) {
    ctx.save();
    ctx.shadowColor = '#c9a6ff'; ctx.shadowBlur = 16;
    text('◀◀', x + w / 2, y + 96, 30, '#c9a6ff');
    ctx.restore();
    text('LOOP 1 → LOOP 2', x + w / 2, y + 128, 13, '#8ffcff');
    const g = path(1 - u);
    drawShip(g.x, g.y, a, ghostColor(GHOST_HUES[0]), GHOST_ALPHA, false);
  } else {
    enemy(enemyA); enemy(enemyB);
    shots(p, enemyA, ghostBulletColor(GHOST_HUES[0]));
    drawShip(p.x, p.y, a, ghostColor(GHOST_HUES[0]), GHOST_ALPHA, false);
    const me = { x: x + 70, y: y + 124 };
    shots(me, enemyB, '#8ffcff');
    drawPlayer(me.x, me.y, Math.atan2(enemyB.y - me.y, enemyB.x - me.x), 1);
    if (u > 0.5) text(`GHOST ×${1 + Math.floor((u - 0.5) * 8)}`, x + w - 12, y + 22, 14, ghostBulletColor(GHOST_HUES[0]), 'right');
  }
}

function drawWidgets(ws) {
  ws.forEach((w, i) => {
    const focused = i === ui.focus && (ui.kb || (!isTouch && inRect(w, mouse)));
    ctx.save();
    if (w.disabled) ctx.globalAlpha = 0.35;
    if (w.style === 'text') {
      // タイトルの「タップ／クリックでスタート」
      if (focused) { ctx.strokeStyle = 'rgba(143,252,255,0.6)'; ctx.lineWidth = 2; ctx.strokeRect(w.x + 0.5, w.y + 0.5, w.w, w.h); }
      ctx.globalAlpha *= 0.75 + 0.25 * Math.sin(frameCount * 0.08);
      text(w.label, w.x + w.w / 2, w.y + w.h / 2, 26, '#ffffff');
      ctx.restore();
      return;
    }
    ctx.fillStyle = focused ? 'rgba(40,44,90,0.96)' : 'rgba(16,16,38,0.92)';
    ctx.fillRect(w.x, w.y, w.w, w.h);
    if (focused) { ctx.shadowColor = '#8ffcff'; ctx.shadowBlur = 12; }
    ctx.strokeStyle = focused ? '#8ffcff' : (w.primary ? 'rgba(143,252,255,0.7)' : 'rgba(143,252,255,0.3)');
    ctx.lineWidth = focused ? 2.5 : 1.5;
    ctx.strokeRect(w.x + 0.5, w.y + 0.5, w.w - 1, w.h - 1);
    ctx.shadowBlur = 0;
    const cy = w.y + w.h / 2;
    if (w.kind === 'button') {
      text(w.label, w.x + w.w / 2, cy, 20, '#ffffff');
    } else {
      text(w.label, w.x + 16, cy, 16, '#d8dcff', 'left', 'normal');
      if (w.kind === 'slider') {
        const t = sliderTrack(w);
        ctx.fillStyle = 'rgba(143,252,255,0.2)';
        ctx.fillRect(t.x, cy - 3, t.w, 6);
        ctx.fillStyle = '#8ffcff';
        ctx.fillRect(t.x, cy - 3, t.w * w.value, 6);
        ctx.beginPath(); ctx.arc(t.x + t.w * w.value, cy, 10, 0, Math.PI * 2); ctx.fill();
        text(`${Math.round(w.value * 100)}%`, w.x + w.w - 14, cy, 15, '#ffffff', 'right', 'normal');
      } else if (w.kind === 'toggle') {
        const px = w.x + w.w - 74, pw = 58, ph = 28;
        ctx.fillStyle = w.value ? '#8ffcff' : 'rgba(120,120,150,0.35)';
        roundRect(px, cy - ph / 2, pw, ph, ph / 2); ctx.fill();
        ctx.fillStyle = w.value ? '#0a0a16' : '#d8dcff';
        ctx.beginPath(); ctx.arc(w.value ? px + pw - 14 : px + 14, cy, 10, 0, Math.PI * 2); ctx.fill();
        text(T(w.value ? 'on' : 'off'), px - 10, cy, 14, w.value ? '#8ffcff' : '#9aa', 'right');
      } else if (w.kind === 'choice') {
        w.options.forEach((o, j) => {
          const r = choiceSeg(w, j), sel = o === w.value;
          ctx.fillStyle = sel ? '#8ffcff' : 'rgba(143,252,255,0.08)';
          ctx.fillRect(r.x, r.y, r.w, r.h);
          text(w.labels[j], r.x + r.w / 2, r.y + r.h / 2, 16, sel ? '#0a0a16' : '#d8dcff', 'center', sel ? 'bold' : 'normal');
        });
      }
    }
    ctx.restore();
  });
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawToast() {
  if (!toast || frameCount > toast.until) return;
  ctx.save();
  ctx.globalAlpha = Math.min(1, (toast.until - frameCount) / 20);
  ctx.font = `bold ${fontPx(16)}px ${FONT}`;
  const w = ctx.measureText(toast.text).width + 40;
  ctx.fillStyle = 'rgba(20,20,48,0.95)';
  roundRect(W / 2 - w / 2, H - 46, w, 38, 19); ctx.fill();
  ctx.strokeStyle = 'rgba(143,252,255,0.6)'; ctx.lineWidth = 1.5; ctx.stroke();
  text(toast.text, W / 2, H - 27, 16, '#ffffff');
  ctx.restore();
}

// ================= メインループ（固定60Hz） =================
let last = performance.now(), acc = 0;
function frame(now) {
  acc += Math.min(250, now - last);
  last = now;
  while (acc >= TICK_MS) { if (!paused) update(); acc -= TICK_MS; }
  syncMusic();
  draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
})();
