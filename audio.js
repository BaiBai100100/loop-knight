/* audio.js — Loop Knight procedural sound. WebAudio only, no files, no deps.
 * Defines window.Sound (see RELEASE_PLAN.md "サウンド API"). Every method is a safe no-op
 * before unlock() or when WebAudio is missing, and never throws. */
(function () {
  'use strict';
  var noop = function () {};
  var AC = window.AudioContext || window.webkitAudioContext;
  var VOL_KEY = 'loopKnightVolume';
  var STEP = 0.125;        // 16th note @ 120 BPM
  var PHRASE = 80;         // 5 bars of 4/4 = 20 beats = 10 s = one game loop
  var REWIND_GAP = 0.8;    // game rewind effect (REWIND_TICKS 48 @ 60Hz): phrase restarts at bar 1 when the next loop begins
  var LOOKAHEAD = 0.12;
  var MAX_VOICES = 24;

  var vol = { master: 0.8, sfx: 0.8, music: 0.5 };
  try { setVol(JSON.parse(localStorage.getItem(VOL_KEY) || 'null')); } catch (e) {}

  var ctx = null, dead = false, paused = false;
  var noiseBuf, masterG, sfxG, musicG, musicDuck, musicLP, musicVerb, sfxVerb, delayIn;
  var voices = [], lastPlay = {};
  var curMode = 'off', wantMode = 'off', intensity = 0, players = [];
  var tp = { next: 0, step: 0 };

  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function num(x) { return typeof x === 'number' && isFinite(x); }
  function mf(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function quiet(p) { if (p && p.catch) p.catch(noop); }
  function setVol(o) {
    if (!o || typeof o !== 'object') return;
    ['master', 'sfx', 'music'].forEach(function (k) { if (num(o[k])) vol[k] = clamp(o[k], 0, 1); });
  }

  // ---------- graph ----------
  function impulse(sec) {
    var r = ctx.sampleRate, n = (r * sec) | 0, b = ctx.createBuffer(2, n, r);
    for (var c = 0; c < 2; c++) {
      var d = b.getChannelData(c);
      for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2.6);
    }
    return b;
  }
  function gain(v, to) { var g = ctx.createGain(); g.gain.value = v; if (to) g.connect(to); return g; }

  function build() {
    var r = ctx.sampleRate;
    noiseBuf = ctx.createBuffer(1, r, r);
    var nd = noiseBuf.getChannelData(0);
    for (var i = 0; i < r; i++) nd[i] = Math.random() * 2 - 1;

    // buses -> gentle glue compressor -> brickwall-ish limiter -> master -> out
    masterG = gain(1, ctx.destination);
    var lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.12;
    lim.connect(masterG);
    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 14; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.2;
    comp.connect(lim);
    sfxG = gain(1, comp);
    musicG = gain(1, comp);
    musicLP = ctx.createBiquadFilter(); musicLP.type = 'lowpass'; musicLP.frequency.value = 20000; musicLP.connect(musicG);
    musicDuck = gain(1, musicLP);

    var ir = impulse(1.8);
    musicVerb = ctx.createConvolver(); musicVerb.buffer = ir; musicVerb.connect(gain(0.32, musicDuck));
    sfxVerb = ctx.createConvolver(); sfxVerb.buffer = ir; sfxVerb.connect(gain(0.3, sfxG));

    // dotted-8th feedback delay for arp / lead
    delayIn = ctx.createDelay(1); delayIn.delayTime.value = STEP * 3;
    var dlp = ctx.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 2400;
    delayIn.connect(dlp); dlp.connect(gain(0.36, delayIn)); dlp.connect(gain(0.4, musicDuck));
    applyVol(true);
  }

  function applyVol(now) {
    if (!ctx) return;
    var t = ctx.currentTime;
    [[masterG, vol.master], [sfxG, vol.sfx], [musicG, vol.music]].forEach(function (p) {
      var v = p[1] * p[1]; // squared = perceptually even slider
      if (now) p[0].gain.value = v; else p[0].gain.setTargetAtTime(v, t, 0.03);
    });
  }

  // One enveloped source. o: type ('sine'|'square'|'sawtooth'|'triangle'|'noise'), f, f2 (glide to), gl (glide time),
  // g (peak), a (attack), s (hold), d (decay), lp/lp2/fgl/ft/q (filter), det (cents), vib (vibrato cents)
  function note(dest, t, o, list) {
    var a = o.a || 0.002, s = o.s || 0, d = o.d || 0.1, end = t + a + s + d, src;
    if (o.type === 'noise') { src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true; }
    else {
      src = ctx.createOscillator(); src.type = o.type;
      src.frequency.setValueAtTime(o.f, t);
      if (o.f2) src.frequency.exponentialRampToValueAtTime(o.f2, t + (o.gl || a + s + d));
      if (o.det) src.detune.setValueAtTime(o.det, t);
    }
    var out = src, nodes = [src];
    if (o.lp) {
      var fl = ctx.createBiquadFilter(); fl.type = o.ft || 'lowpass'; fl.Q.value = o.q || 0.7;
      fl.frequency.setValueAtTime(o.lp, t);
      if (o.lp2) fl.frequency.exponentialRampToValueAtTime(o.lp2, t + (o.fgl || a + s + d));
      out.connect(fl); out = fl; nodes.push(fl);
    }
    var g = ctx.createGain(); nodes.push(g);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(o.g, t + a);
    if (s) g.gain.setValueAtTime(o.g, t + a + s);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    out.connect(g);
    if (dest.length) for (var i = 0; i < dest.length; i++) g.connect(dest[i]); else g.connect(dest);
    if (o.vib && src.detune) {
      var lfo = ctx.createOscillator(), lg = gain(o.vib, src.detune);
      lfo.frequency.value = 5.5; lfo.connect(lg); lfo.start(t); lfo.stop(end); nodes.push(lfo, lg);
    }
    if (o.type === 'noise') src.start(t, Math.random() * 0.5); else src.start(t);
    src.stop(end + 0.02);
    src.onended = function () { for (var j = 0; j < nodes.length; j++) try { nodes[j].disconnect(); } catch (e) {} };
    if (list) list.push(src);
    return end;
  }

  // ---------- SFX ----------
  function N(v, t, o) { var e = note(v.g, t, o, v.srcs); if (e > v.end) v.end = e; }
  function rnd(x) { return 1 + (Math.random() - 0.5) * x; }

  // gap: min seconds between triggers, max: concurrent voices of this name, pri: may steal when the global cap is hit,
  // vol: voice gain, rev: reverb send
  var SFX = {
    shoot: { gap: 0.045, max: 3, vol: 0.5, fn: function (v, t) {
      var r = rnd(0.1);
      N(v, t, { type: 'square', f: 1250 * r, f2: 420 * r, d: 0.065, g: 0.16, lp: 3800, lp2: 1200 });
      N(v, t, { type: 'triangle', f: 260 * r, f2: 110, d: 0.05, g: 0.22 });
      N(v, t, { type: 'noise', d: 0.02, g: 0.07, lp: 5000, ft: 'highpass' });
    } },
    ghostShoot: { gap: 0.11, max: 2, vol: 0.28, fn: function (v, t) {
      var r = rnd(0.16);
      N(v, t, { type: 'triangle', f: 1000 * r, f2: 420 * r, d: 0.06, g: 0.2, lp: 1600 });
    } },
    hit: { gap: 0.035, max: 4, vol: 0.65, fn: function (v, t) {
      N(v, t, { type: 'noise', d: 0.045, g: 0.35, lp: 2600 * rnd(0.2), ft: 'bandpass', q: 1.2 });
      N(v, t, { type: 'square', f: 620, f2: 240, d: 0.04, g: 0.07, lp: 3000 });
    } },
    enemyDie: { gap: 0.03, max: 5, vol: 0.7, pri: 1, rev: 0.15, fn: function (v, t, k) {
      var s = 0.8 + 0.5 * k;
      N(v, t, { type: 'sine', f: 170 / s, f2: 42, d: 0.2 * s, g: 0.8 });
      N(v, t, { type: 'noise', d: 0.28 * s, g: 0.5, lp: 5000, lp2: 250 });
      N(v, t, { type: 'square', f: 900 * rnd(0.15), f2: 110, d: 0.12, g: 0.08, lp: 2400 });
    } },
    ghostKill: { gap: 0.06, max: 3, vol: 0.75, rev: 0.4, fn: function (v, t) {
      var m = [79, 81, 84, 86, 88][(Math.random() * 5) | 0];
      N(v, t, { type: 'triangle', f: mf(m), d: 0.22, g: 0.25 });
      N(v, t + 0.055, { type: 'triangle', f: mf(m + 7), d: 0.3, g: 0.2 });
      N(v, t + 0.055, { type: 'sine', f: mf(m + 19), d: 0.25, g: 0.06 });
      N(v, t, { type: 'noise', d: 0.12, g: 0.2, lp: 1500, lp2: 200 });
    } },
    split: { gap: 0.05, max: 3, vol: 0.8, fn: function (v, t) {
      N(v, t, { type: 'square', f: 280, f2: 720, d: 0.07, g: 0.12, lp: 2200 });
      N(v, t + 0.06, { type: 'square', f: 360, f2: 900, d: 0.08, g: 0.1, lp: 2200 });
      N(v, t, { type: 'noise', d: 0.12, g: 0.25, lp: 2400, lp2: 300 });
    } },
    chargerWarn: { gap: 0.15, max: 3, vol: 0.55, fn: function (v, t) {
      var o = { type: 'sawtooth', f: 160, f2: 720, a: 0.04, s: 0.36, d: 0.12, g: 0.16, lp: 400, lp2: 3000, q: 8 };
      N(v, t, o);
      o.det = 30; o.g = 0.12; N(v, t, o);
    } },
    enemyShot: { gap: 0.07, max: 3, vol: 0.55, fn: function (v, t) {
      N(v, t, { type: 'sine', f: 760 * rnd(0.08), f2: 230, d: 0.15, g: 0.35 });
      N(v, t, { type: 'square', f: 380, f2: 120, d: 0.1, g: 0.05, lp: 1400 });
    } },
    playerHurt: { gap: 0.15, max: 1, vol: 0.8, pri: 3, rev: 0.2, fn: function (v, t) {
      N(v, t, { type: 'sawtooth', f: 320, f2: 55, d: 0.36, g: 0.22, lp: 3200, lp2: 300 });
      N(v, t, { type: 'square', f: 160, f2: 40, d: 0.3, g: 0.1, lp: 1800 });
      N(v, t, { type: 'noise', d: 0.3, g: 0.5, lp: 3500, lp2: 200 });
      N(v, t, { type: 'sine', f: 100, f2: 32, d: 0.28, g: 0.7 });
    } },
    rewind: { gap: 0.3, max: 1, vol: 0.9, pri: 2, rev: 0.3, fn: function (v, t) {
      N(v, t, { type: 'noise', a: 0.55, d: 0.25, g: 0.5, lp: 300, lp2: 6000, fgl: 0.6, ft: 'bandpass', q: 2.5 });
      N(v, t, { type: 'sawtooth', f: 1400, f2: 70, a: 0.01, d: 0.75, g: 0.06, lp: 4000, lp2: 500 });
      N(v, t, { type: 'sine', f: 900, f2: 55, d: 0.7, g: 0.12, vib: 60 });
      for (var i = 0; i < 8; i++) // accelerating clock ticks
        N(v, t + 0.75 * (1 - Math.pow(1 - i / 8, 1.6)), { type: 'noise', d: 0.012, g: 0.15, lp: 4000, ft: 'highpass' });
    } },
    loopClear: { gap: 0.3, max: 1, vol: 0.7, pri: 2, rev: 0.45, fn: function (v, t) {
      [81, 85, 88, 93].forEach(function (m, i) {
        N(v, t + i * 0.06, { type: 'triangle', f: mf(m), d: 0.45, g: 0.25 });
        N(v, t + i * 0.06, { type: 'square', f: mf(m), d: 0.18, g: 0.05, lp: 3000 });
      });
      N(v, t, { type: 'noise', a: 0.05, d: 0.4, g: 0.06, lp: 7000, ft: 'highpass' });
    } },
    upgradePick: { gap: 0.1, max: 2, vol: 0.7, pri: 2, rev: 0.35, fn: function (v, t) {
      [72, 76, 79, 84, 88].forEach(function (m, i) {
        N(v, t + i * 0.04, { type: 'square', f: mf(m), d: 0.14, g: 0.2, lp: 4200 });
      });
      N(v, t + 0.2, { type: 'triangle', f: mf(84), d: 0.6, g: 0.25 });
      N(v, t + 0.2, { type: 'sine', f: mf(96), d: 0.5, g: 0.06, vib: 15 });
      N(v, t, { type: 'noise', a: 0.15, d: 0.1, g: 0.08, lp: 1000, lp2: 8000, ft: 'bandpass', q: 2 });
    } },
    uiTap: { gap: 0.04, max: 2, vol: 0.45, pri: 1, fn: function (v, t) {
      N(v, t, { type: 'sine', f: 1400, f2: 950, d: 0.04, g: 0.3 });
      N(v, t, { type: 'triangle', f: 2800, d: 0.02, g: 0.06 });
    } },
    bossSpawn: { gap: 1, max: 1, vol: 0.8, pri: 3, rev: 0.4, fn: function (v, t) {
      N(v, t, { type: 'sine', f: 70, f2: 32, d: 1.6, g: 0.8 });
      N(v, t, { type: 'noise', d: 1.2, g: 0.5, lp: 1500, lp2: 60 });
      N(v, t, { type: 'sawtooth', f: 55, a: 0.5, s: 0.9, d: 0.8, g: 0.16, lp: 150, lp2: 1400, fgl: 1.4 });
      N(v, t, { type: 'sawtooth', f: 55, det: 14, a: 0.5, s: 0.9, d: 0.8, g: 0.12, lp: 150, lp2: 1400, fgl: 1.4 });
      for (var i = 0; i < 3; i++)
        N(v, t + 0.15 + i * 0.42, { type: 'square', f: 520, f2: 820, gl: 0.3, a: 0.01, s: 0.22, d: 0.08, g: 0.07, lp: 2200 });
    } },
    bossHit: { gap: 0.06, max: 3, vol: 0.55, fn: function (v, t) {
      var p = rnd(0.16);
      N(v, t, { type: 'square', f: 190 * p, d: 0.07, g: 0.09, lp: 1900, ft: 'bandpass', q: 3 });
      N(v, t, { type: 'square', f: 287 * p, d: 0.07, g: 0.07, lp: 1900, ft: 'bandpass', q: 3 });
      N(v, t, { type: 'noise', d: 0.035, g: 0.18, lp: 4500, ft: 'highpass' });
      N(v, t, { type: 'sine', f: 130, f2: 65, d: 0.09, g: 0.35 });
    } },
    bossDie: { gap: 1, max: 1, vol: 0.9, pri: 3, rev: 0.5, fn: function (v, t) {
      N(v, t, { type: 'sine', f: 130, f2: 24, d: 1.3, g: 0.9 });
      N(v, t, { type: 'noise', d: 2, g: 0.6, lp: 7000, lp2: 70 });
      [0.22, 0.45, 0.75].forEach(function (dt) {
        N(v, t + dt, { type: 'noise', d: 0.45, g: 0.35, lp: 3200, lp2: 150 });
        N(v, t + dt, { type: 'sine', f: 110, f2: 32, d: 0.3, g: 0.5 });
      });
      [69, 73, 76, 81].forEach(function (m, i) {
        N(v, t + 0.7, { type: 'sawtooth', f: mf(m), det: i % 2 ? 7 : -7, a: 0.04, s: 0.7, d: 0.9, g: 0.05, lp: 2600 });
      });
    } },
    gameOver: { gap: 1, max: 1, vol: 0.85, pri: 3, rev: 0.45, fn: function (v, t) {
      [69, 65, 62].forEach(function (m, i) {
        N(v, t + i * 0.24, { type: 'sawtooth', f: mf(m), d: 0.32, g: 0.11, lp: 2400, lp2: 600 });
        N(v, t + i * 0.24, { type: 'triangle', f: mf(m - 12), d: 0.32, g: 0.12 });
      });
      N(v, t + 0.72, { type: 'sawtooth', f: mf(57), f2: mf(57) * 0.75, gl: 1.4, a: 0.01, s: 0.4, d: 1, g: 0.12, lp: 2000, lp2: 200 });
      N(v, t + 0.72, { type: 'sine', f: mf(45), f2: mf(45) * 0.75, gl: 1.4, a: 0.01, s: 0.4, d: 1, g: 0.25 });
    } },
    newBest: { gap: 1, max: 1, vol: 0.9, pri: 3, rev: 0.5, fn: function (v, t) {
      [72, 76, 79, 84].forEach(function (m, i) {
        N(v, t + i * 0.08, { type: 'square', f: mf(m), d: 0.16, g: 0.14, lp: 3800 });
        N(v, t + i * 0.08, { type: 'triangle', f: mf(m), d: 0.16, g: 0.18 });
      });
      [84, 88, 91].forEach(function (m) {
        N(v, t + 0.34, { type: 'sawtooth', f: mf(m), a: 0.02, s: 0.5, d: 0.7, g: 0.06, lp: 4000, vib: 12 });
        N(v, t + 0.34, { type: 'triangle', f: mf(m + 12), d: 0.9, g: 0.04 });
      });
      N(v, t + 0.34, { type: 'noise', a: 0.02, d: 0.8, g: 0.05, lp: 6000, ft: 'highpass' });
    } }
  };

  function kill(v, now) {
    v.g.gain.cancelScheduledValues(now);
    v.g.gain.setValueAtTime(v.g.gain.value, now);
    v.g.gain.linearRampToValueAtTime(0, now + 0.03);
    v.srcs.forEach(function (s) { try { s.stop(now + 0.05); } catch (e) {} });
  }

  function play(name, opts) {
    var d = Object.prototype.hasOwnProperty.call(SFX, name) && SFX[name];
    if (!d || !ctx || paused || ctx.state !== 'running') return; // suspended: don't queue sounds to burst on resume
    var now = ctx.currentTime, i;
    if (now - (lastPlay[name] === undefined ? -9 : lastPlay[name]) < d.gap) return;
    voices = voices.filter(function (v) { return v.end > now; });
    var same = 0;
    for (i = 0; i < voices.length; i++) if (voices[i].name === name) same++;
    if (same >= d.max) return;
    if (voices.length >= MAX_VOICES) {
      if (!d.pri) return;
      var victim = voices[0];
      for (i = 1; i < voices.length; i++) if (voices[i].pri < victim.pri) victim = voices[i]; // oldest of lowest priority
      kill(victim, now);
      voices.splice(voices.indexOf(victim), 1);
    }
    lastPlay[name] = now;
    opts = opts || {};
    var k = num(opts.intensity) ? clamp(opts.intensity, 0, 1) : 0.5;
    var v = { name: name, pri: d.pri || 0, srcs: [], end: now, g: gain(d.vol * (0.7 + 0.6 * k)) };
    var out = v.g;
    if (num(opts.pan) && ctx.createStereoPanner) {
      v.pn = ctx.createStereoPanner(); v.pn.pan.value = clamp(opts.pan, -1, 1) * 0.75;
      v.g.connect(v.pn); out = v.pn;
    }
    out.connect(sfxG);
    if (d.rev) { v.r = gain(d.rev, sfxVerb); v.g.connect(v.r); }
    var t = now + 0.005;
    d.fn(v, t, k);
    voices.push(v);
    setTimeout(function () { [v.g, v.r, v.pn].forEach(function (n) { if (n) try { n.disconnect(); } catch (e) {} }); },
      (v.end - now) * 1000 + 500);
    if (name === 'rewind') rewindMusic(t);
  }

  // ---------- music ----------
  // [bass root, chord] per bar; 5 bars = one 10 s loop. Bar 5 is a dominant that resolves when the loop restarts.
  var PROG = {
    title: [[45, [57, 60, 64, 67]], [41, [53, 57, 60, 64]], [48, [55, 60, 64, 67]], [43, [55, 59, 62, 67]], [40, [56, 59, 62, 64]]],
    play: [[33, [57, 60, 64]], [29, [57, 60, 65]], [36, [55, 60, 64]], [31, [55, 59, 62]], [28, [56, 59, 64]]],
    boss: [[33, [57, 60, 64]], [34, [58, 62, 65]], [33, [57, 60, 64]], [29, [57, 60, 65]], [28, [56, 59, 64]]]
  };
  var ARP = [0, 1, 2, 1, 3, 2, 1, 2, 0, 1, 2, 1, 3, 2, 4, 2];
  // step -> [midi, length in steps]
  var LEAD = { 0: [76, 6], 6: [74, 2], 8: [72, 8], 16: [72, 6], 22: [69, 2], 24: [72, 8], 32: [76, 6], 38: [79, 2],
    40: [76, 8], 48: [74, 8], 56: [71, 8], 64: [71, 4], 68: [74, 4], 72: [76, 8] };
  var BOSS_LEAD = { 0: [76, 8], 8: [77, 8], 16: [76, 8], 24: [74, 8], 32: [76, 8], 40: [77, 8], 48: [81, 16], 64: [80, 8], 72: [76, 8] };

  function kick(p, t, g) {
    note(p.out, t, { type: 'sine', f: 155, f2: 42, gl: 0.11, d: 0.3, g: g });
    note(p.out, t, { type: 'noise', d: 0.008, g: g * 0.25, lp: 3000, ft: 'highpass' });
  }
  function snare(p, t, g) {
    note([p.out, p.rev], t, { type: 'noise', d: 0.17, g: g, lp: 1400, ft: 'highpass' });
    note(p.out, t, { type: 'triangle', f: 210, f2: 150, d: 0.09, g: g * 0.6 });
  }
  function hat(p, t, g, open) { note(p.out, t, { type: 'noise', d: open ? 0.22 : 0.035, g: g, lp: 7500, ft: 'highpass' }); }
  function bass(p, t, m, dur, g, cut) {
    note(p.out, t, { type: 'sawtooth', f: mf(m), d: dur, g: g, lp: cut, lp2: 160, q: 4 });
    note(p.out, t, { type: 'square', f: mf(m), det: -10, d: dur, g: g * 0.5, lp: cut * 0.7, lp2: 140 });
  }
  function pad(p, t, chord, cut, g) {
    chord.forEach(function (m) {
      [-9, 9].forEach(function (det) {
        note([p.pump, p.rev], t, { type: 'sawtooth', f: mf(m), det: det, a: 0.35, s: 1.65, d: 0.7, g: g, lp: cut });
      });
    });
  }
  function arp(p, t, m, g, cut, wave) { note([p.pump, p.dly], t, { type: wave, f: mf(m), d: 0.11, g: g, lp: cut, q: 3 }); }
  function lead(p, t, m, len, g) {
    var o = { type: 'sawtooth', f: mf(m), a: 0.02, s: len - 0.1, d: 0.25, g: g, lp: 2600, vib: 10 };
    note([p.pump, p.dly, p.rev], t, o);
    o.type = 'square'; o.det = 7; o.g = g * 0.6; note([p.pump, p.dly], t, o);
  }
  function pump(p, t) { // sidechain feel on pad/arp/lead
    p.pump.gain.setTargetAtTime(0.3, t, 0.008);
    p.pump.gain.setTargetAtTime(1, t + 0.04, 0.09);
  }

  function schedule(p, s, t) {
    var bar = (s / 16) | 0, b = s % 16, I = intensity, ch = PROG[p.mode][bar], root = ch[0], c = ch[1];
    var tones = c.concat([c[0] + 12, c[1] + 12]), am = tones[ARP[b]] + 12;
    if (p.mode === 'title') {
      if (b === 0) {
        pad(p, t, c, 900, 0.035);
        note(p.out, t, { type: 'sine', f: mf(root), a: 0.4, s: 1.1, d: 0.6, g: 0.16 });
      }
      if (b % 2 === 0) arp(p, t, tones[ARP[(s / 2) % 16]] + 12, 0.07, 1800, 'triangle');
      return;
    }
    var boss = p.mode === 'boss';
    if (b % 4 === 0) { kick(p, t, boss ? 0.7 : 0.6); pump(p, t); }
    if (boss && b === 14) kick(p, t, 0.45);
    if (s === 0 && (boss || I >= 0.3)) note([p.out, p.rev], t, { type: 'noise', d: 1.5, g: 0.12, lp: 4500, ft: 'highpass' });
    if (bar === 4 && b >= 12 && (boss || I >= 0.5)) snare(p, t, 0.14 + (b - 12) * 0.06); // fill into the next loop
    else if ((b === 4 || b === 12) && (boss || I >= 0.2)) snare(p, t, 0.32);
    if (b % 4 === 2 && (boss || I >= 0.35)) hat(p, t, 0.09, !boss && I >= 0.8);
    else if (boss || (b % 2 === 1 && I >= 0.65)) hat(p, t, 0.04);
    if (boss) bass(p, t, root + (b % 4 === 2 ? 12 : 0), 0.11, 0.2, 900 + 900 * I);
    else if (b % 2 === 0) bass(p, t, root + (b % 8 === 6 ? 12 : 0), 0.22, 0.2, 700 + 1100 * I);
    if (boss) arp(p, t, b % 8 === 7 ? am + 1 : am, 0.05, 1400 + 2200 * I, 'sawtooth');
    else arp(p, t, am, 0.045 + 0.025 * I, 1100 + 3200 * I, 'square');
    if (b === 0 && (boss || I >= 0.45)) pad(p, t, c, boss ? 700 : 1300, 0.018);
    var L = (boss ? BOSS_LEAD : LEAD)[s];
    if (L && I >= (boss ? 0.4 : 0.7)) lead(p, t, L[0], L[1] * STEP, 0.05);
  }

  function tick() {
    if (!ctx || ctx.state !== 'running') return;
    var now = ctx.currentTime;
    players = players.filter(function (p) { return p.until > now; });
    if (tp.next < now - 0.05) { // main thread stalled: skip missed steps, stay on the grid
      var skip = Math.ceil((now - tp.next) / STEP);
      tp.next += skip * STEP; tp.step = (tp.step + skip) % PHRASE;
    }
    while (tp.next < now + LOOKAHEAD) {
      for (var i = 0; i < players.length; i++) if (players[i].until > tp.next) schedule(players[i], tp.step, tp.next);
      tp.next += STEP; tp.step = (tp.step + 1) % PHRASE;
    }
  }

  function xfade(p, to, now, tc) {
    [p.out, p.rev, p.dly].forEach(function (n) {
      n.gain.cancelScheduledValues(now); n.gain.setValueAtTime(n.gain.value, now); n.gain.setTargetAtTime(to, now, tc);
    });
  }

  function applyMode() {
    if (wantMode === curMode) return;
    var now = ctx.currentTime, prev = curMode;
    players.forEach(function (p) {
      if (p.until !== Infinity) return;
      xfade(p, 0, now, 0.4);
      p.until = now + 1.8;
      setTimeout(function () { [p.out, p.pump, p.rev, p.dly].forEach(function (n) { try { n.disconnect(); } catch (e) {} }); }, 6000);
    });
    curMode = wantMode;
    if (curMode === 'off') return;
    if (prev === 'off' || (prev === 'title' && curMode === 'play')) { tp.next = now + 0.06; tp.step = 0; } // game start = bar 1
    var p = { mode: curMode, until: Infinity, out: gain(0, musicDuck), pump: gain(1), rev: gain(0, musicVerb), dly: gain(0, delayIn) };
    p.pump.connect(p.out);
    xfade(p, 1, now, 0.35);
    players.push(p);
  }

  function rewindMusic(t) { // tape-stop duck during the rewind, then bar 1 lands with the new loop
    if (curMode === 'off') return;
    var f = musicLP.frequency, g = musicDuck.gain;
    f.cancelScheduledValues(t); g.cancelScheduledValues(t);
    f.setTargetAtTime(380, t, 0.12); f.setTargetAtTime(20000, t + REWIND_GAP - 0.04, 0.03);
    g.setTargetAtTime(0.45, t, 0.1); g.setTargetAtTime(1, t + REWIND_GAP - 0.04, 0.04);
    tp.next = t + REWIND_GAP; tp.step = 0;
  }

  // ---------- lifecycle ----------
  function resume() { if (ctx && ctx.state !== 'running' && !paused) quiet(ctx.resume()); }

  function unlock() {
    if (!AC || dead) return;
    if (!ctx) {
      try { ctx = new AC(); build(); } catch (e) { ctx = null; dead = true; return; }
      setInterval(function () { try { tick(); } catch (e) {} }, 25);
      applyMode();
    }
    if (paused) { quiet(ctx.suspend()); return; }
    if (ctx.state === 'running') return;
    resume();
    var b = ctx.createBufferSource(); // iOS: a sound started inside the gesture unlocks output
    b.buffer = ctx.createBuffer(1, 1, ctx.sampleRate); b.connect(ctx.destination); b.start(0);
  }

  function safe(fn) { return function () { try { return fn.apply(null, arguments); } catch (e) {} }; }
  var safeUnlock = safe(unlock);
  ['pointerdown', 'touchend', 'keydown', 'click'].forEach(function (ev) {
    try { window.addEventListener(ev, safeUnlock, { capture: true, passive: true }); } catch (e) {}
  });
  try {
    document.addEventListener('visibilitychange', function () {
      try { if (!ctx) return; if (document.hidden) quiet(ctx.suspend()); else resume(); } catch (e) {}
    });
  } catch (e) {}

  window.Sound = {
    unlock: safeUnlock,
    play: safe(play),
    music: safe(function (mode) {
      if (mode !== 'off' && !Object.prototype.hasOwnProperty.call(PROG, mode)) return;
      wantMode = mode;
      if (ctx) applyMode();
    }),
    setIntensity: safe(function (x) { if (num(x)) intensity = clamp(x, 0, 1); }),
    setVolume: safe(function (o) {
      setVol(o); applyVol();
      try { localStorage.setItem(VOL_KEY, JSON.stringify(vol)); } catch (e) {}
    }),
    getVolume: function () { return { master: vol.master, sfx: vol.sfx, music: vol.music }; },
    pauseAll: safe(function () { paused = true; if (ctx) quiet(ctx.suspend()); }),
    resumeAll: safe(function () { paused = false; resume(); })
  };
})();
