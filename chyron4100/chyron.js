/*
 * Chyron 4100 emulator: a browser recreation of the 4100's character
 * generator workflow. Compose pages on the preview channel, record them to
 * numbered messages on "disk", read them back and take them to air.
 */
(() => {
  'use strict';

  // ---- Raster and hardware constants --------------------------------------
  const W = 720, H = 486;                 // CCIR-601 NTSC active raster
  const SCALE = 2;                        // backing-store oversampling
  const SAFE = { l: 72, r: 648, t: 48, b: 438 };       // 80% title safe
  const ACTION = { l: 36, r: 684, t: 24, b: 462 };     // 90% action safe
  const MIX_SECONDS = 0.5;
  const DISK_KEY = 'cg4100.disk.v1';
  const MAX_MSG = 9999;

  const PALETTE = [
    ['BLACK', '#000000'], ['WHITE', '#ffffff'], ['RED', '#e0201b'], ['GREEN', '#1fb04a'],
    ['BLUE', '#1f4fd8'], ['YELLOW', '#ffe12b'], ['CYAN', '#22d3e6'], ['MAGENTA', '#d62ad0'],
    ['GRAY', '#9a9a9a'], ['CHARCOAL', '#35383c'], ['ORANGE', '#ff8a1c'], ['NAVY', '#0d1f5c'],
    ['MAROON', '#6e0f1f'], ['FOREST', '#0f4d2a'], ['GOLD', '#d4a72c'], ['SKY', '#7fc4ff'],
  ];

  // ITC Korinna is the 4100-era broadcast face. It is commercial, so it is not
  // shipped: the "CG Korinna" family resolves to an installed copy, files in
  // fonts/ (see fonts/README.md), or files loaded with the Load Fonts key.
  const KORINNA = 'CG Korinna';
  const KORINNA_FALLBACK = 'Georgia, "Times New Roman", serif';
  const FONTS = [
    { name: 'KORINNA BD',   family: KORINNA,            weight: 700, size: 36, fallback: KORINNA_FALLBACK },
    { name: 'KORINNA BD',   family: KORINNA,            weight: 700, size: 56, fallback: KORINNA_FALLBACK },
    { name: 'KORINNA',      family: KORINNA,            weight: 400, size: 32, fallback: KORINNA_FALLBACK },
    { name: 'KORINNA',      family: KORINNA,            weight: 400, size: 24, fallback: KORINNA_FALLBACK },
    { name: 'COND X-BOLD',  family: 'Barlow Condensed', weight: 800, size: 46 },
    { name: 'GOTHIC',       family: 'Oswald',           weight: 600, size: 40 },
    { name: 'DISPLAY',      family: 'Anton',            weight: 400, size: 68 },
    { name: 'SANS BOLD',    family: 'Archivo',          weight: 700, size: 30 },
  ];

  const EDGES = ['NONE', 'SHADOW', 'BORDER', 'BDR+SHD', 'GLOW'];
  const JUSTS = ['L', 'C', 'R'];
  const MODE_NAMES = { static: 'STATIC', roll: 'ROLL', crawl: 'CRAWL' };
  const SCOPES = ['cursor', 'row', 'page'];
  const BKGS = ['ICE', 'BARS', 'BLACK', 'MATTE', 'IMAGE'];

  // ---- Helpers --------------------------------------------------------------
  const $ = (s) => document.querySelector(s);
  const pad = (n, w = 4) => String(n).padStart(w, '0');
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const intIn = (v, a, b, d) => (Number.isInteger(v) && v >= a && v <= b ? v : d);
  const numIn = (v, a, b, d) => (typeof v === 'number' && isFinite(v) ? clamp(v, a, b) : d);
  const fontCss = (f) => {
    const F = FONTS[f];
    return `${F.weight} ${F.size}px "${F.family}", ${F.fallback || 'Arial, Helvetica, sans-serif'}`;
  };
  const color = (i) => PALETTE[i][1];

  // ---- Page model -----------------------------------------------------------
  const defAttr = () => ({ f: 0, c: 1, e: 1, ec: 0 });
  const newRow = (f = 0, just = 'C') => ({ chars: [], just, dx: 0, dy: 0, box: null, f });
  const newPage = () => ({ rows: [newRow()], mode: 'static', speed: 3 });

  function sanitizePage(p) {
    const rows = Array.isArray(p && p.rows) ? p.rows : [];
    const out = {
      rows: rows.map((r) => ({
        chars: (Array.isArray(r && r.chars) ? r.chars : [])
          .filter((c) => c && typeof c.ch === 'string' && c.ch.length)
          .map((c) => ({
            ch: [...c.ch][0],
            f: intIn(c.f, 0, 7, 0), c: intIn(c.c, 0, 15, 1),
            e: intIn(c.e, 0, 4, 0), ec: intIn(c.ec, 0, 15, 0),
          })),
        just: JUSTS.includes(r && r.just) ? r.just : 'C',
        dx: numIn(r && r.dx, -W, W, 0),
        dy: numIn(r && r.dy, -H, H * 8, 0),
        box: r && r.box ? { c: intIn(r.box.c, 0, 15, 11), full: !!r.box.full } : null,
        f: intIn(r && r.f, 0, 7, 0),
      })),
      mode: MODE_NAMES[p && p.mode] ? p.mode : 'static',
      speed: intIn(p && p.speed, 1, 9, 3),
    };
    if (!out.rows.length) out.rows.push(newRow());
    return out;
  }

  // Shorthand for the sample disk: one object per row.
  function mkPage(rows, mode = 'static', speed = 3) {
    return {
      mode, speed,
      rows: rows.map(({ t = '', f = 0, c = 1, e = 1, ec = 0, just = 'C', dx = 0, dy = 0, box = null }) => ({
        chars: [...t].map((ch) => ({ ch, f, c, e, ec })), just, dx, dy, box, f,
      })),
    };
  }

  function sampleDisk() {
    const at = new Date().toISOString();
    const pages = {
      1001: mkPage([
        { t: 'GALAXY', f: 1, c: 14, e: 3, dy: 110 },
        { t: 'HOCKEY', f: 1, c: 1, e: 3 },
        { t: 'Live from Orion Arena', f: 2, c: 6, e: 1, dy: 8 },
      ]),
      1002: mkPage([
        { t: '#17  Marek Volkov', f: 0, c: 1, e: 1, just: 'L', dy: 296, box: { c: 11, full: true } },
        { t: 'Center  ·  Orion Astros  ·  22 G  31 A', f: 3, c: 14, e: 0, just: 'L', box: { c: 12, full: true } },
      ]),
      1003: mkPage([
        { t: 'ASTROS  3    COMETS  2', f: 0, c: 1, e: 2, dy: 6, box: { c: 9, full: false } },
        { t: 'End of 2nd Period', f: 2, c: 5, e: 1, box: { c: 9, full: false } },
      ]),
      1004: mkPage([
        { t: 'Galaxy Hockey', f: 1, c: 14, e: 2 },
        { t: '', f: 3 },
        { t: 'Play-by-Play', f: 3, c: 15, e: 1 },
        { t: 'Dana Ruiz', f: 0, c: 1, e: 1 },
        { t: '', f: 3 },
        { t: 'Color Analyst', f: 3, c: 15, e: 1 },
        { t: 'Teodor Niemi', f: 0, c: 1, e: 1 },
        { t: '', f: 3 },
        { t: 'Character Generator', f: 3, c: 15, e: 1 },
        { t: 'CG-4100 Emulator', f: 0, c: 1, e: 1 },
        { t: '', f: 3 },
        { t: 'Thanks for Watching', f: 0, c: 5, e: 3 },
      ], 'roll', 2),
      1005: mkPage([
        { t: 'LEAGUE WIRE:  Comets recall G Pavel Siro from Vega  ·  Astros PP 3 for 4 tonight  ·  Next: Astros at Novas, Saturday 7:05  ·',
          f: 2, c: 1, e: 1, just: 'L', dy: 354, box: { c: 12, full: true } },
      ], 'crawl', 4),
      1006: mkPage([
        { t: 'PENALTY', f: 0, c: 5, e: 1, just: 'R', dy: 300, box: { c: 2, full: false } },
        { t: 'Volkov  ·  Hooking  2:00', f: 2, c: 1, e: 1, just: 'R', box: { c: 9, full: false } },
      ]),
    };
    const disk = {};
    for (const [n, page] of Object.entries(pages)) disk[n] = { page, saved: at };
    return disk;
  }

  // ---- Disk -----------------------------------------------------------------
  let disk = {};
  function loadDisk() {
    try {
      const raw = localStorage.getItem(DISK_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        disk = {};
        for (const [n, m] of Object.entries(parsed)) {
          const k = parseInt(n, 10);
          if (k >= 1 && k <= MAX_MSG && m && m.page) disk[k] = { page: sanitizePage(m.page), saved: m.saved || '' };
        }
        return;
      }
    } catch (_) { /* fall through to the sample disk */ }
    disk = sampleDisk();
    saveDisk();
  }
  function saveDisk() {
    try { localStorage.setItem(DISK_KEY, JSON.stringify(disk)); } catch (_) { /* storage unavailable */ }
    lampDisk();
  }
  const diskNums = () => Object.keys(disk).map(Number).sort((a, b) => a - b);

  // ---- Measurement and layout -------------------------------------------------
  const measure = document.createElement('canvas').getContext('2d');
  const widthCache = new Map();
  function charW(c) {
    const key = c.f + '|' + c.ch;
    let w = widthCache.get(key);
    if (w === undefined) {
      measure.font = fontCss(c.f);
      w = measure.measureText(c.ch).width;
      widthCache.set(key, w);
    }
    return w;
  }

  // Rows stack from the top of title safe. A row's dy pushes it and every row
  // below it down, so nudging row 1 moves the whole block.
  function layoutPage(page, crawl = false) {
    let y = SAFE.t;
    return page.rows.map((row) => {
      y += row.dy;
      let size = 0;
      for (const c of row.chars) size = Math.max(size, FONTS[c.f].size);
      if (!size) size = FONTS[row.f].size;
      const h = Math.round(size * 1.2);
      const xs = [];
      let x = 0;
      for (const c of row.chars) { xs.push(x); x += charW(c); }
      xs.push(x);
      let x0;
      if (crawl) x0 = row.dx;
      else if (row.just === 'L') x0 = SAFE.l + row.dx;
      else if (row.just === 'R') x0 = SAFE.r - x + row.dx;
      else x0 = (W - x) / 2 + row.dx;
      const r = { row, y, h, base: y + Math.round(size * 0.92), size, x0, xs, width: x };
      y += h;
      return r;
    });
  }

  // ---- Rendering --------------------------------------------------------------
  function drawEdge(ctx, c, x, y) {
    const size = FONTS[c.f].size;
    const off = Math.max(2, Math.round(size * 0.06));
    const bw = Math.max(3, size * 0.1);
    ctx.fillStyle = ctx.strokeStyle = color(c.ec);
    switch (c.e) {
      case 1: ctx.fillText(c.ch, x + off, y + off); break;
      case 2: ctx.lineWidth = bw; ctx.strokeText(c.ch, x, y); break;
      case 3:
        ctx.lineWidth = bw;
        ctx.strokeText(c.ch, x + off, y + off);
        ctx.fillText(c.ch, x + off, y + off);
        ctx.strokeText(c.ch, x, y);
        break;
      case 4:
        ctx.save();
        ctx.shadowColor = color(c.ec);
        ctx.shadowBlur = size * 0.35 * SCALE;
        ctx.fillText(c.ch, x, y);
        ctx.fillText(c.ch, x, y);
        ctx.restore();
        break;
    }
  }

  function drawPage(ctx, L, tx, ty, alpha, crawl) {
    ctx.save();
    ctx.translate(tx, ty);
    ctx.lineJoin = 'round';
    ctx.textBaseline = 'alphabetic';
    // Boxes sit under everything.
    for (const r of L) {
      const b = r.row.box;
      if (!b) continue;
      ctx.globalAlpha = alpha * 0.9;
      ctx.fillStyle = color(b.c);
      if (b.full && crawl) ctx.fillRect(-tx, r.y, W, r.h);
      else if (b.full) ctx.fillRect(SAFE.l - 18, r.y, SAFE.r - SAFE.l + 36, r.h);
      else if (r.width) ctx.fillRect(r.x0 - 16, r.y, r.width + 32, r.h);
    }
    ctx.globalAlpha = alpha;
    // Edges for the whole page first, so a border never covers a neighbour's face.
    for (const pass of [0, 1]) {
      for (const r of L) {
        if (r.y + ty > H || r.y + r.h + ty < 0) continue;
        r.row.chars.forEach((c, i) => {
          if (c.ch === ' ') return;
          const x = r.x0 + r.xs[i];
          if (x + tx > W + 80 || x + tx < -120) return;
          ctx.font = fontCss(c.f);
          if (pass === 0) { if (c.e) drawEdge(ctx, c, x, r.base); }
          else { ctx.fillStyle = color(c.c); ctx.fillText(c.ch, x, r.base); }
        });
      }
    }
    ctx.restore();
  }

  // Backgrounds are painted once into offscreen canvases.
  const bgCache = {};
  let bgImage = null;
  let bkg = 'ICE';
  const painters = {
    BLACK(x) { x.fillStyle = '#000'; x.fillRect(0, 0, W, H); },
    MATTE(x) {
      const g = x.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, '#0a1838'); g.addColorStop(1, '#23386b');
      x.fillStyle = g; x.fillRect(0, 0, W, H);
    },
    BARS(x) {
      const bw = W / 7;
      const top = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
      const mid = ['#0000c0', '#131313', '#c000c0', '#131313', '#00c0c0', '#131313', '#c0c0c0'];
      const y1 = Math.round(H * 0.67), y2 = Math.round(H * 0.75);
      top.forEach((c, i) => { x.fillStyle = c; x.fillRect(i * bw, 0, bw + 1, y1); });
      mid.forEach((c, i) => { x.fillStyle = c; x.fillRect(i * bw, y1, bw + 1, y2 - y1); });
      const bottom = [
        ['#00214c', bw * 1.25], ['#ffffff', bw * 1.25], ['#32006a', bw * 1.25], ['#131313', bw * 1.25],
        ['#090909', bw / 3], ['#131313', bw / 3], ['#1d1d1d', bw / 3], ['#131313', bw],
      ];
      let bx = 0;
      for (const [c, w] of bottom) { x.fillStyle = c; x.fillRect(bx, y2, w + 1, H - y2); bx += w; }
    },
    ICE(x) {
      const g = x.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#dfe9f0'); g.addColorStop(1, '#c3d3df');
      x.fillStyle = g; x.fillRect(0, 0, W, H);
      // Skate scratches, from a fixed seed so every repaint matches.
      let s = 4100;
      const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      x.strokeStyle = 'rgba(255,255,255,0.55)'; x.lineWidth = 1;
      for (let i = 0; i < 140; i++) {
        const sx = rnd() * W, sy = rnd() * H, a = (rnd() - 0.5) * 0.8, l = 30 + rnd() * 160;
        x.beginPath(); x.moveTo(sx, sy); x.lineTo(sx + Math.cos(a) * l, sy + Math.sin(a) * l); x.stroke();
      }
      x.fillStyle = 'rgba(29,78,216,0.8)';
      x.fillRect(W * 0.22 - 7, 0, 14, H); x.fillRect(W * 0.78 - 7, 0, 14, H);
      x.fillStyle = 'rgba(200,16,46,0.85)'; x.fillRect(W / 2 - 6, 0, 12, H);
      x.strokeStyle = 'rgba(29,78,216,0.8)'; x.lineWidth = 3;
      x.beginPath(); x.arc(W / 2, H / 2, 105, 0, Math.PI * 2); x.stroke();
      x.fillStyle = 'rgba(29,78,216,0.9)';
      x.beginPath(); x.arc(W / 2, H / 2, 7, 0, Math.PI * 2); x.fill();
      x.strokeStyle = 'rgba(200,16,46,0.7)';
      for (const fx of [W * 0.08, W * 0.92]) for (const fy of [H * 0.22, H * 0.78]) {
        x.beginPath(); x.arc(fx, fy, 70, 0, Math.PI * 2); x.stroke();
      }
      const v = x.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, W * 0.7);
      v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(10,20,40,0.35)');
      x.fillStyle = v; x.fillRect(0, 0, W, H);
    },
  };
  function drawBackground(ctx) {
    if (bkg === 'IMAGE' && bgImage) {
      const s = Math.max(W / bgImage.width, H / bgImage.height);
      const w = bgImage.width * s, h = bgImage.height * s;
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      ctx.drawImage(bgImage, (W - w) / 2, (H - h) / 2, w, h);
      return;
    }
    const name = painters[bkg] ? bkg : 'BLACK';
    if (!bgCache[name]) {
      const c = document.createElement('canvas');
      c.width = W * SCALE; c.height = H * SCALE;
      const x = c.getContext('2d');
      x.scale(SCALE, SCALE);
      painters[name](x);
      bgCache[name] = c;
    }
    ctx.drawImage(bgCache[name], 0, 0, W, H);
  }

  // ---- Editor state -----------------------------------------------------------
  const ed = {
    page: newPage(), row: 0, col: 0, anchor: null,
    attr: defAttr(), scope: 'row', scroll: 0, modified: false, safe: true,
  };
  let curMsg = 1001;
  let promptState = null;
  let flashMsg = '', flashUntil = 0;
  let blinkT0 = 0;
  let pvwDirty = true, pgmDirty = true;
  const dirty = () => { pvwDirty = true; };
  const touched = () => { ed.modified = true; pvwDirty = true; };
  const curRow = () => ed.page.rows[ed.row];

  function flash(msg) { flashMsg = msg; flashUntil = performance.now() + 3200; updateStatus(); }

  function clampCursor() {
    ed.row = clamp(ed.row, 0, ed.page.rows.length - 1);
    ed.col = clamp(ed.col, 0, curRow().chars.length);
  }

  // ---- Undo -------------------------------------------------------------------
  const undoStack = [];
  let lastUndoKind = null, lastUndoTime = 0;
  function pushUndo(kind = 'edit') {
    const now = Date.now();
    const coalesce = (kind === 'type' || kind === 'pos') && lastUndoKind === kind && now - lastUndoTime < 1500;
    lastUndoKind = kind; lastUndoTime = now;
    if (coalesce) return;
    undoStack.push({ page: clone(ed.page), row: ed.row, col: ed.col, msg: curMsg, modified: ed.modified });
    if (undoStack.length > 100) undoStack.shift();
  }
  function undo() {
    const s = undoStack.pop();
    if (!s) return flash('NOTHING TO UNDO');
    ed.page = s.page; ed.row = s.row; ed.col = s.col; ed.anchor = null;
    curMsg = s.msg;
    lastUndoKind = null;
    clampCursor(); pickAttr(); dirty();
    ed.modified = s.modified;
    flash('UNDO');
  }

  // ---- Text editing -----------------------------------------------------------
  function selRange() {
    if (ed.anchor === null || ed.anchor === ed.col) return null;
    return [Math.min(ed.anchor, ed.col), Math.max(ed.anchor, ed.col)];
  }
  function deleteSelection() {
    const r = selRange();
    ed.anchor = null;
    if (!r) return false;
    curRow().chars.splice(r[0], r[1] - r[0]);
    ed.col = r[0];
    return true;
  }
  function insertText(s) {
    const chars = [...s].filter((ch) => ch >= ' ' && ch !== '\u007f');
    if (!chars.length) return;
    pushUndo('type');
    deleteSelection();
    const row = curRow();
    if (!row.chars.length) row.f = ed.attr.f;
    for (const ch of chars) row.chars.splice(ed.col++, 0, { ch, ...ed.attr });
    blinkT0 = performance.now();
    touched();
  }
  function splitRow() {
    pushUndo();
    deleteSelection();
    const row = curRow();
    const rest = row.chars.splice(ed.col);
    const nr = newRow(ed.attr.f, row.just);
    nr.chars = rest;
    nr.box = row.box ? { ...row.box } : null;
    ed.page.rows.splice(ed.row + 1, 0, nr);
    ed.row++; ed.col = 0;
    touched();
  }
  function backspace() {
    pushUndo();
    if (deleteSelection()) return touched();
    const row = curRow();
    if (ed.col > 0) { row.chars.splice(--ed.col, 1); return touched(); }
    if (ed.row === 0) return;
    const prev = ed.page.rows[ed.row - 1];
    ed.col = prev.chars.length;
    prev.chars.push(...row.chars);
    ed.page.rows.splice(ed.row, 1);
    ed.row--;
    touched();
  }
  function deleteForward() {
    pushUndo();
    if (deleteSelection()) return touched();
    const row = curRow();
    if (ed.col < row.chars.length) { row.chars.splice(ed.col, 1); return touched(); }
    if (ed.row >= ed.page.rows.length - 1) return;
    row.chars.push(...ed.page.rows[ed.row + 1].chars);
    ed.page.rows.splice(ed.row + 1, 1);
    touched();
  }
  // Like the hardware, the cursor picks up the attributes of the character
  // behind it, so typing continues in the same font and colour.
  function pickAttr() {
    const row = curRow();
    const c = row.chars[ed.col - 1] || row.chars[ed.col];
    if (c) ed.attr = { f: c.f, c: c.c, e: c.e, ec: c.ec };
    else ed.attr.f = row.f;
  }
  function move(dRow, dCol, select) {
    if (select && dCol) { if (ed.anchor === null) ed.anchor = ed.col; }
    else ed.anchor = null;
    if (dRow) ed.row += dRow;
    ed.row = clamp(ed.row, 0, ed.page.rows.length - 1);
    if (dCol) ed.col += dCol;
    ed.col = clamp(ed.col, 0, curRow().chars.length);
    if (!select) pickAttr();
    blinkT0 = performance.now();
    dirty(); updateStatus();
  }

  // ---- Attributes -------------------------------------------------------------
  const scopeRows = () => (ed.scope === 'page' ? ed.page.rows : [curRow()]);

  function applyAttr(patch, label) {
    pushUndo();
    Object.assign(ed.attr, patch);
    const sel = selRange();
    const row = curRow();
    let targets = [];
    if (sel) targets = row.chars.slice(sel[0], sel[1]);
    else if (ed.scope === 'cursor') { if ('f' in patch && !row.chars.length) row.f = patch.f; }
    else for (const r of scopeRows()) { targets.push(...r.chars); if ('f' in patch) r.f = patch.f; }
    for (const c of targets) Object.assign(c, patch);
    touched(); flash(label);
  }
  function setJust(j) {
    pushUndo();
    const rows = scopeRows();
    const next = j || JUSTS[(JUSTS.indexOf(curRow().just) + 1) % 3];
    for (const r of rows) r.just = next;
    touched(); flash('JUSTIFY ' + { L: 'LEFT', C: 'CENTER', R: 'RIGHT' }[next]);
  }
  function setBox(box) {
    pushUndo();
    for (const r of scopeRows()) r.box = box ? { ...box } : null;
    touched();
    flash(box ? `BOX ${pad(box.c, 2)} ${PALETTE[box.c][0]} ${box.full ? 'FULL' : 'FIT'}` : 'BOX OFF');
  }
  function setMode(mode, speed) {
    pushUndo();
    if (mode) ed.page.mode = mode;
    if (speed) ed.page.speed = speed;
    touched(); flash(`MODE ${MODE_NAMES[ed.page.mode]} SPEED ${ed.page.speed}`);
  }
  function nudge(dx, dy) {
    pushUndo('pos');
    if (ed.scope === 'page') {
      ed.page.rows[0].dy += dy;
      for (const r of ed.page.rows) r.dx += dx;
    } else {
      curRow().dx += dx;
      curRow().dy += dy;
    }
    touched();
    const r = curRow();
    flash(`POSITION ROW ${pad(ed.row + 1, 2)}  X ${r.dx >= 0 ? '+' : ''}${r.dx}  Y ${r.dy >= 0 ? '+' : ''}${r.dy}`);
  }

  // ---- Status-line prompts (the 4100's "enter a number" dialogue) ---------------
  function ask(label, opts, onEnter) {
    promptState = { label, buf: opts.init || '', fresh: !!opts.init, accept: opts.accept || /^[0-9]$/, max: opts.max || 4, auto: !!opts.auto, onEnter };
    updateStatus();
  }
  function promptKey(e) {
    const p = promptState;
    if (e.key === 'Escape') { promptState = null; flash('CANCELLED'); return; }
    if (e.key === 'Enter') { promptState = null; p.onEnter(p.buf.trim()); updateStatus(); return; }
    if (e.key === 'Backspace') { p.buf = p.fresh ? '' : p.buf.slice(0, -1); p.fresh = false; updateStatus(); return; }
    if (e.key.length === 1 && p.accept.test(e.key)) {
      if (p.fresh) { p.buf = ''; p.fresh = false; }
      if (p.buf.length >= p.max) return;
      p.buf += e.key.toUpperCase();
      if (p.auto && p.buf.length >= p.max) { promptState = null; p.onEnter(p.buf); }
      updateStatus();
    }
  }

  // ---- Disk operations ----------------------------------------------------------
  function readMsg(n, quiet) {
    if (!disk[n]) { flash(`MSG ${pad(n)} NOT ON DISK`); return false; }
    pushUndo();
    ed.page = clone(disk[n].page);
    ed.row = 0; ed.col = 0; ed.anchor = null; ed.scroll = 0;
    ed.modified = false;
    curMsg = n;
    pickAttr();
    dirty();
    if (!quiet) flash(`READ ${pad(n)}`);
    return true;
  }
  function recordMsg(n) {
    disk[n] = { page: clone(ed.page), saved: new Date().toISOString() };
    saveDisk();
    curMsg = n; ed.modified = false;
    flash(`RECORDED ${pad(n)}`);
    if (dir.open) renderDir();
  }
  function stepMsg(dirn) {
    const nums = diskNums();
    if (!nums.length) return flash('DISK EMPTY');
    const next = dirn > 0 ? nums.find((n) => n > curMsg) : [...nums].reverse().find((n) => n < curMsg);
    if (next === undefined) return flash(dirn > 0 ? 'LAST MSG ON DISK' : 'FIRST MSG ON DISK');
    readMsg(next);
  }
  const parseMsg = (v) => {
    const n = parseInt(v, 10);
    return n >= 1 && n <= MAX_MSG ? n : null;
  };

  // ---- Program channel ------------------------------------------------------------
  const pgm = { cur: null, prev: null, t: 1, trans: 'CUT', hold: false };
  const makeLayer = (page, msg, modified) => ({
    page, msg, modified, off: 0, done: false, L: layoutPage(page, page.mode === 'crawl'),
  });

  function layerXY(ly) {
    const { page, L, off } = ly;
    if (page.mode === 'roll') return [0, H - (L.length ? L[0].y : 0) - off];
    if (page.mode === 'crawl') return [W - off, 0];
    return [0, 0];
  }
  function take() {
    const was = pgm.cur;
    const mix = pgm.trans === 'MIX';
    pgm.prev = mix && was && !was.done ? was : null;
    pgm.cur = makeLayer(clone(ed.page), curMsg, ed.modified);
    pgm.t = mix ? 0 : 1;
    pgm.hold = false;
    pgmDirty = true;
    flash(`TAKE ${pad(curMsg)} ${pgm.trans}`);
    lampTally();
  }
  function clearPgm() {
    if (!pgm.cur) return flash('PROGRAM ALREADY CLEAR');
    pgm.prev = pgm.trans === 'MIX' && !pgm.cur.done ? pgm.cur : null;
    pgm.cur = null;
    pgm.t = pgm.prev ? 0 : 1;
    pgmDirty = true;
    flash('PROGRAM CLEAR');
    lampTally();
  }
  function advance(ly, dt) {
    if (!ly || ly.done || ly.page.mode === 'static' || pgm.hold) return false;
    ly.off += ly.page.speed * 36 * dt;
    const [tx, ty] = layerXY(ly);
    if (ly.page.mode === 'roll') {
      const last = ly.L[ly.L.length - 1];
      if (ty + last.y + last.h < 0) ly.done = true;
    } else {
      const right = Math.max(...ly.L.map((r) => r.x0 + r.width));
      if (tx + right < 0) ly.done = true;
    }
    if (ly.done && ly === pgm.cur) { flash(`${MODE_NAMES[ly.page.mode]} COMPLETE`); lampTally(); }
    return true;
  }

  // ---- Canvases -------------------------------------------------------------------
  const pvw = $('#pvw'), pgmC = $('#pgm');
  for (const c of [pvw, pgmC]) { c.width = W * SCALE; c.height = H * SCALE; }
  const pctx = pvw.getContext('2d'), gctx = pgmC.getContext('2d');
  let pvwLayout = [];

  function renderPreview(now) {
    const ctx = pctx;
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    drawBackground(ctx);
    const L = pvwLayout = layoutPage(ed.page);
    const cr = L[ed.row];
    if (cr.y + cr.h - ed.scroll > H - 8) ed.scroll = cr.y + cr.h - H + 8;
    if (cr.y - ed.scroll < 8) ed.scroll = Math.max(0, cr.y - 8);
    const ty = -ed.scroll;
    drawPage(ctx, L, 0, ty, 1, false);

    if (ed.safe) {
      ctx.save();
      ctx.setLineDash([6, 6]); ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,214,90,0.55)';
      ctx.strokeRect(SAFE.l + 0.5, SAFE.t + 0.5, SAFE.r - SAFE.l, SAFE.b - SAFE.t);
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.strokeRect(ACTION.l + 0.5, ACTION.t + 0.5, ACTION.r - ACTION.l, ACTION.b - ACTION.t);
      ctx.restore();
    }

    // Selection, row marker and block cursor.
    const sel = selRange();
    if (sel) {
      ctx.fillStyle = 'rgba(90,160,255,0.45)';
      ctx.fillRect(cr.x0 + cr.xs[sel[0]], cr.y + ty, cr.xs[sel[1]] - cr.xs[sel[0]], cr.h);
    }
    ctx.fillStyle = '#ffd65a';
    ctx.beginPath();
    ctx.moveTo(6, cr.y + ty + cr.h / 2 - 7); ctx.lineTo(16, cr.y + ty + cr.h / 2); ctx.lineTo(6, cr.y + ty + cr.h / 2 + 7);
    ctx.fill();
    if (((now - blinkT0) % 1000) < 560) {
      const x = cr.x0 + cr.xs[ed.col];
      const c = curRow().chars[ed.col];
      const w = c && c.ch !== ' ' ? Math.max(4, charW(c)) : Math.max(10, FONTS[ed.attr.f].size * 0.45);
      ctx.save();
      ctx.globalCompositeOperation = 'difference';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x, cr.y + ty, w, cr.h);
      ctx.restore();
    }
    pvwDirty = false;
  }

  function renderProgram() {
    const ctx = gctx;
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    drawBackground(ctx);
    for (const [ly, a] of [[pgm.prev, 1 - pgm.t], [pgm.cur, pgm.t]]) {
      if (!ly || ly.done || a <= 0) continue;
      const [tx, ty] = layerXY(ly);
      drawPage(ctx, ly.L, tx, ty, a, ly.page.mode === 'crawl');
    }
    pgmDirty = false;
  }

  let lastFrame = performance.now(), lastBlink = -1;
  function frame(now) {
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    if (pgm.t < 1) {
      pgm.t = Math.min(1, pgm.t + dt / MIX_SECONDS);
      if (pgm.t >= 1) pgm.prev = null;
      pgmDirty = true;
    }
    if (advance(pgm.cur, dt)) pgmDirty = true;
    const blink = Math.floor((now - blinkT0) / 500) % 2;
    if (blink !== lastBlink) { lastBlink = blink; pvwDirty = true; }
    if (flashMsg && now > flashUntil) { flashMsg = ''; updateStatus(); }
    if (pvwDirty) { renderPreview(now); updateStatus(); }
    if (pgmDirty) renderProgram();
    requestAnimationFrame(frame);
  }

  // ---- Status lines and panel state --------------------------------------------------
  const st1 = $('#st1'), st2 = $('#st2'), pst1 = $('#pst1'), pst2 = $('#pst2');
  function updateStatus() {
    const a = ed.attr, r = curRow();
    st1.textContent =
      `MSG ${pad(curMsg)}${ed.modified ? '*' : ' '}  R${pad(ed.row + 1, 2)} C${pad(ed.col + 1, 2)}  ` +
      `F${a.f + 1} ${FONTS[a.f].name}  CLR ${pad(a.c, 2)}  EDGE ${EDGES[a.e]}/${pad(a.ec, 2)}  ` +
      `${r.just}  ${MODE_NAMES[ed.page.mode]} ${ed.page.speed}  SCOPE ${ed.scope.toUpperCase()}`;
    if (promptState) {
      st2.innerHTML = '';
      const lab = document.createElement('span');
      lab.className = 'crt-prompt';
      lab.textContent = `${promptState.label} ? ${promptState.buf}`;
      const cur = document.createElement('span');
      cur.className = 'crt-cursor';
      cur.textContent = '█';
      st2.append(lab, cur);
    } else {
      st2.textContent = flashMsg || `READY  DISK A  ${diskNums().length} MSGS`;
    }
    const ly = pgm.cur && !pgm.cur.done ? pgm.cur : null;
    pst1.textContent = ly
      ? `ON AIR  MSG ${pad(ly.msg)}${ly.modified ? '*' : ''}  ${MODE_NAMES[ly.page.mode]}${pgm.hold ? '  HOLD' : ''}`
      : 'PROGRAM CLEAR';
    pst2.textContent = `TRANS ${pgm.trans}  BKG ${bkg}`;
    syncPanel();
  }

  function syncPanel() {
    const a = ed.attr, r = curRow();
    const on = (sel, test) => document.querySelectorAll(sel).forEach((el) => el.classList.toggle('on', test(el)));
    on('[data-font]', (el) => +el.dataset.font === a.f);
    on('[data-edge]', (el) => +el.dataset.edge === a.e);
    on('[data-scope]', (el) => el.dataset.scope === ed.scope);
    on('[data-just]', (el) => el.dataset.just === r.just);
    on('[data-mode]', (el) => el.dataset.mode === ed.page.mode);
    on('[data-target]', (el) => el.dataset.target === swatchTarget);
    on('[data-boxmode]', (el) => el.dataset.boxmode === (r.box ? (r.box.full ? 'full' : 'fit') : 'off'));
    const active = swatchTarget === 'face' ? a.c : swatchTarget === 'edge' ? a.ec : (r.box ? r.box.c : -1);
    on('[data-color]', (el) => +el.dataset.color === active);
    const sp = $('#speed');
    if (+sp.value !== ed.page.speed) sp.value = ed.page.speed;
    $('#speedOut').textContent = ed.page.speed;
    on('[data-cmd="trans"]', () => pgm.trans === 'MIX');
    on('[data-cmd="hold"]', () => pgm.hold);
    on('[data-cmd="safe"]', () => ed.safe);
  }

  function lampTally() {
    $('#tally').classList.toggle('lit', !!(pgm.cur && !pgm.cur.done));
    updateStatus();
  }
  let diskLampTimer = 0;
  function lampDisk() {
    const l = $('#diskLamp');
    if (!l) return;
    l.classList.add('lit');
    clearTimeout(diskLampTimer);
    diskLampTimer = setTimeout(() => l.classList.remove('lit'), 400);
  }

  // ---- Directory ------------------------------------------------------------------
  const dir = { open: false, sel: 0 };
  const dirEl = $('#dir'), dirList = $('#dirList');
  const rowText = (r) => r.chars.map((c) => c.ch).join('').trim();
  function renderDir() {
    const nums = diskNums();
    dir.sel = clamp(dir.sel, 0, Math.max(0, nums.length - 1));
    $('#dirCount').textContent = `${nums.length} MSGS`;
    dirList.innerHTML = '';
    if (!nums.length) {
      const li = document.createElement('li');
      li.className = 'dir-empty';
      li.textContent = 'DISK EMPTY. COMPOSE A PAGE AND PRESS RECORD.';
      dirList.append(li);
      return;
    }
    nums.forEach((n, i) => {
      const p = disk[n].page;
      const text = p.rows.map(rowText).filter(Boolean).join(' / ') || '(BLANK)';
      const li = document.createElement('li');
      li.className = i === dir.sel ? 'sel' : '';
      li.dataset.num = n;
      const num = document.createElement('span'); num.className = 'dir-num'; num.textContent = pad(n);
      const tx = document.createElement('span'); tx.className = 'dir-text'; tx.textContent = text;
      const md = document.createElement('span'); md.className = 'dir-mode'; md.textContent = MODE_NAMES[p.mode];
      li.append(num, tx, md);
      li.addEventListener('click', () => { dir.sel = i; readMsg(n); closeDir(); });
      dirList.append(li);
    });
    const sel = dirList.children[dir.sel];
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }
  function openDir() {
    dir.open = true;
    const nums = diskNums();
    const i = nums.indexOf(curMsg);
    dir.sel = i >= 0 ? i : 0;
    dirEl.hidden = false;
    renderDir();
  }
  function closeDir() { dir.open = false; dirEl.hidden = true; }
  function dirKey(e) {
    const nums = diskNums();
    const n = nums[dir.sel];
    switch (e.key) {
      case 'Escape': closeDir(); break;
      case 'ArrowUp': dir.sel--; renderDir(); break;
      case 'ArrowDown': dir.sel++; renderDir(); break;
      case 'Enter': if (n) { readMsg(n); closeDir(); } break;
      case 't': case 'T': if (n) { readMsg(n); closeDir(); take(); } break;
      case 'Delete': case 'Backspace':
        if (n) ask(`ERASE ${pad(n)} FROM DISK (Y/N)`, { accept: /^[yYnN]$/, max: 1, auto: true }, (v) => {
          if (v === 'Y') { delete disk[n]; saveDisk(); flash(`ERASED ${pad(n)} FROM DISK`); } else flash('KEPT');
          renderDir();
        });
        break;
      default: return false;
    }
    return true;
  }

  // ---- Commands -----------------------------------------------------------------------
  let swatchTarget = 'face';
  const commands = {
    read: () => ask('READ MSG #', {}, (v) => { const n = v ? parseMsg(v) : curMsg; n ? readMsg(n) : flash('MSG # 0001-9999'); }),
    record: () => ask('RECORD MSG #', { init: String(curMsg) }, (v) => { const n = parseMsg(v); n ? recordMsg(n) : flash('MSG # 0001-9999'); }),
    erase: () => {
      pushUndo();
      ed.page = newPage(); ed.page.rows[0].f = ed.attr.f;
      ed.row = 0; ed.col = 0; ed.anchor = null; ed.scroll = 0;
      touched(); flash('PAGE ERASED. CTRL+Z RESTORES');
    },
    dir: () => (dir.open ? closeDir() : openDir()),
    prev: () => stepMsg(-1),
    next: () => stepMsg(1),
    font: () => ask('FONT 1-8', { accept: /^[1-8]$/, max: 1, auto: true }, (v) => {
      const f = +v - 1;
      if (f >= 0) applyAttr({ f }, `FONT ${v} ${FONTS[f].name} ${FONTS[f].size}`);
    }),
    color: () => ask('FACE COLOR 00-15', { max: 2 }, (v) => {
      const c = parseInt(v, 10);
      c >= 0 && c <= 15 ? applyAttr({ c }, `COLOR ${pad(c, 2)} ${PALETTE[c][0]}`) : flash('COLOR 00-15');
    }),
    edge: () => ask('EDGE 0 NONE 1 SHD 2 BDR 3 B+S 4 GLOW', { accept: /^[0-4]$/, max: 1, auto: true }, (v) => {
      const e = +v;
      applyAttr({ e }, `EDGE ${EDGES[e]}`);
      if (e) ask('EDGE COLOR 00-15', { max: 2, init: String(ed.attr.ec) }, (w) => {
        const ec = parseInt(w, 10);
        if (ec >= 0 && ec <= 15) applyAttr({ ec }, `EDGE ${EDGES[e]} ${pad(ec, 2)} ${PALETTE[ec][0]}`);
      });
    }),
    box: () => ask('BOX COLOR 00-15 +F FULL, BLANK OFF', { accept: /^[0-9fF]$/, max: 3 }, (v) => {
      if (!v) return setBox(null);
      const c = parseInt(v, 10);
      if (!(c >= 0 && c <= 15)) return flash('BOX 00-15, ADD F FOR FULL WIDTH');
      setBox({ c, full: /F/.test(v) });
    }),
    just: () => setJust(),
    mode: () => ask('MODE S/R/C + SPEED 1-9', { accept: /^[sSrRcC1-9]$/, max: 2 }, (v) => {
      const m = { S: 'static', R: 'roll', C: 'crawl' }[(v.match(/[SRC]/) || [])[0]];
      const s = (v.match(/[1-9]/) || [])[0];
      if (!m && !s) return flash('EXAMPLE: R4 = ROLL AT SPEED 4');
      setMode(m, s ? +s : 0);
    }),
    take,
    clear: clearPgm,
    trans: () => { pgm.trans = pgm.trans === 'CUT' ? 'MIX' : 'CUT'; flash(`TRANSITION ${pgm.trans}`); },
    hold: () => {
      if (!pgm.cur || pgm.cur.page.mode === 'static') return flash('HOLD WORKS ON ROLL AND CRAWL');
      pgm.hold = !pgm.hold; flash(pgm.hold ? 'HOLD' : 'RESUME');
    },
    bkg: () => {
      const list = BKGS.filter((b) => b !== 'IMAGE' || bgImage);
      bkg = list[(list.indexOf(bkg) + 1) % list.length];
      pvwDirty = pgmDirty = true; flash(`BACKGROUND ${bkg}`);
    },
    image: () => $('#bgFile').click(),
    fonts: () => $('#fontFile').click(),
    safe: () => { ed.safe = !ed.safe; dirty(); flash(ed.safe ? 'SAFE AREA ON' : 'SAFE AREA OFF'); },
    undo,
    scope: () => {
      ed.scope = SCOPES[(SCOPES.indexOf(ed.scope) + 1) % 3];
      flash(`SCOPE ${ed.scope.toUpperCase()}`);
    },
    io: openIO,
  };
  function run(cmd) {
    if (!commands[cmd]) return;
    promptState = null;
    if (dir.open && !['dir', 'take', 'clear', 'trans', 'hold', 'bkg', 'safe'].includes(cmd)) closeDir();
    commands[cmd]();
    updateStatus();
  }

  // ---- Keyboard -----------------------------------------------------------------------
  const FKEYS = {
    F1: 'read', F2: 'record', F3: 'erase', F4: 'dir', F5: 'font', F6: 'color',
    F7: 'edge', F8: 'box', F9: 'just', F10: 'mode', PageUp: 'prev', PageDown: 'next',
  };
  const CTRL = { Enter: 'take', Delete: 'clear', m: 'trans', ' ': 'hold', b: 'bkg', g: 'safe', z: 'undo', e: 'scope', o: 'io' };
  const trap = $('#trap');
  const io = $('#io');

  function onKey(e) {
    if (io.open) return;
    const t = e.target;
    if (t !== trap && t.matches && t.matches('input, textarea, select')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;

    if (!ctrl && !e.altKey && FKEYS[k]) { e.preventDefault(); run(FKEYS[k]); return; }
    if (ctrl && !e.altKey) {
      const ck = k.length === 1 ? k.toLowerCase() : k;
      if (CTRL[ck]) { e.preventDefault(); run(CTRL[ck]); return; }
      const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (arrows[k]) {
        e.preventDefault();
        promptState = null;
        const step = e.shiftKey ? 10 : 2;
        nudge(arrows[k][0] * step, arrows[k][1] * step);
        return;
      }
      return; // leave other browser shortcuts alone
    }
    if (promptState) { e.preventDefault(); promptKey(e); return; }
    if (dir.open) { if (dirKey(e) !== false) e.preventDefault(); return; }

    switch (k) {
      case 'ArrowLeft': move(0, -1, e.shiftKey); break;
      case 'ArrowRight': move(0, 1, e.shiftKey); break;
      case 'ArrowUp': move(-1, 0, false); break;
      case 'ArrowDown': move(1, 0, false); break;
      case 'Home': move(0, -ed.col, e.shiftKey); break;
      case 'End': move(0, curRow().chars.length - ed.col, e.shiftKey); break;
      case 'Tab':
        ed.anchor = null;
        ed.row = e.shiftKey ? Math.max(0, ed.row - 1) : Math.min(ed.page.rows.length - 1, ed.row + 1);
        ed.col = 0; pickAttr(); dirty(); break;
      case 'Enter': splitRow(); break;
      case 'Backspace': backspace(); break;
      case 'Delete': deleteForward(); break;
      case 'Escape': ed.anchor = null; dirty(); break;
      default:
        if (k.length === 1 && !e.altKey) insertText(k);
        else return; // not ours (e.g. mobile "Unidentified"): let the input event handle it
    }
    e.preventDefault();
    updateStatus();
  }
  window.addEventListener('keydown', onKey);

  // Soft keyboards deliver text through input events rather than keydown.
  trap.addEventListener('input', (e) => {
    if (e.inputType === 'deleteContentBackward') backspace();
    else if (e.inputType === 'insertLineBreak') splitRow();
    else if (trap.value) {
      if (promptState) {
        for (const ch of trap.value) promptKey({ key: ch });
      } else insertText(trap.value);
    }
    trap.value = '';
    updateStatus();
  });

  // Clicking the preview places the cursor.
  pvw.addEventListener('pointerdown', (e) => {
    const rect = pvw.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    const y = ((e.clientY - rect.top) / rect.height) * H + ed.scroll;
    if (!pvwLayout.length) return;
    let ri = pvwLayout.findIndex((r) => y >= r.y && y < r.y + r.h);
    if (ri < 0) ri = y < pvwLayout[0].y ? 0 : pvwLayout.length - 1;
    const r = pvwLayout[ri];
    let ci = 0, best = Infinity;
    r.xs.forEach((cx, i) => { const d = Math.abs(r.x0 + cx - x); if (d < best) { best = d; ci = i; } });
    ed.row = ri; ed.col = ci; ed.anchor = null;
    pickAttr();
    blinkT0 = performance.now();
    promptState = null;
    trap.focus({ preventScroll: true });
    dirty(); updateStatus();
  });

  // ---- Panel wiring ---------------------------------------------------------------------
  function buildPanel() {
    const fonts = $('#fontList');
    FONTS.forEach((F, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.font = i;
      b.className = 'font-btn';
      const n = document.createElement('span'); n.className = 'font-n'; n.textContent = i + 1;
      const s = document.createElement('span'); s.className = 'font-sample';
      s.style.fontFamily = `"${F.family}", ${F.fallback || 'Arial, sans-serif'}`;
      s.style.fontWeight = F.weight;
      s.textContent = F.name;
      const z = document.createElement('span'); z.className = 'font-size'; z.textContent = F.size;
      b.append(n, s, z);
      b.addEventListener('click', () => applyAttr({ f: i }, `FONT ${i + 1} ${F.name} ${F.size}`));
      fonts.append(b);
    });
    const sw = $('#swatches');
    PALETTE.forEach(([name, hex], i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.color = i;
      b.className = 'swatch';
      b.style.setProperty('--sw', hex);
      b.title = `${pad(i, 2)} ${name}`;
      b.setAttribute('aria-label', `Color ${pad(i, 2)} ${name}`);
      b.textContent = pad(i, 2);
      b.addEventListener('click', () => {
        if (swatchTarget === 'face') applyAttr({ c: i }, `COLOR ${pad(i, 2)} ${name}`);
        else if (swatchTarget === 'edge') applyAttr({ ec: i }, `EDGE COLOR ${pad(i, 2)} ${name}`);
        else setBox({ c: i, full: curRow().box ? curRow().box.full : true });
      });
      sw.append(b);
    });
    document.querySelectorAll('[data-target]').forEach((b) => b.addEventListener('click', () => { swatchTarget = b.dataset.target; syncPanel(); }));
    document.querySelectorAll('[data-edge]').forEach((b) => b.addEventListener('click', () => applyAttr({ e: +b.dataset.edge }, `EDGE ${EDGES[+b.dataset.edge]}`)));
    document.querySelectorAll('[data-scope]').forEach((b) => b.addEventListener('click', () => { ed.scope = b.dataset.scope; flash(`SCOPE ${ed.scope.toUpperCase()}`); }));
    document.querySelectorAll('[data-just]').forEach((b) => b.addEventListener('click', () => setJust(b.dataset.just)));
    document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode, 0)));
    document.querySelectorAll('[data-boxmode]').forEach((b) => b.addEventListener('click', () => {
      const m = b.dataset.boxmode;
      const c = curRow().box ? curRow().box.c : 11;
      setBox(m === 'off' ? null : { c, full: m === 'full' });
    }));
    $('#speed').addEventListener('input', (e) => setMode(null, +e.target.value));
    document.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () => run(b.dataset.cmd)));
    // Keep typing going to the emulator after any mouse click on the panel.
    document.querySelectorAll('.console button').forEach((b) => b.addEventListener('pointerup', () => b.blur()));
  }

  $('#bgFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => { bgImage = img; bkg = 'IMAGE'; pvwDirty = pgmDirty = true; flash('BACKGROUND IMAGE LOADED'); };
    img.onerror = () => flash('COULD NOT READ THAT IMAGE');
    img.src = URL.createObjectURL(file);
    e.target.value = '';
  });

  // ---- Korinna font files ------------------------------------------------------------------
  // Files loaded here are registered as "CG Korinna" and kept in this browser's
  // IndexedDB, so they only need loading once.
  const FONT_DB = 'cg4100-fonts';
  function fontStore(mode, fn) {
    return new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(FONT_DB, 1); } catch (err) { reject(err); return; }
      req.onupgradeneeded = () => req.result.createObjectStore('faces');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction('faces', mode);
        const out = fn(tx.objectStore('faces'));
        tx.oncomplete = () => resolve(out && out.result);
        tx.onerror = () => reject(tx.error);
      };
    });
  }
  async function addKorinna(buffer, weight) {
    const face = new FontFace(KORINNA, buffer, { weight: String(weight) });
    await face.load();
    document.fonts.add(face);
  }
  async function restoreFonts() {
    try {
      const faces = await fontStore('readonly', (st) => st.getAll());
      for (const f of faces || []) await addKorinna(f.buffer, f.weight).catch(() => null);
    } catch (_) { /* IndexedDB unavailable: fall back to installed or local files */ }
  }
  // Canvas text silently substitutes a missing face, so compare widths against
  // the fallback to tell whether real Korinna is present.
  function korinnaPresent(weight) {
    const probe = 'Korinna 4100 WMQ gxy';
    measure.font = `${weight} 40px monospace`;
    const a = measure.measureText(probe).width;
    measure.font = `${weight} 40px "${KORINNA}", monospace`;
    return Math.abs(measure.measureText(probe).width - a) > 0.5;
  }
  function markSubstitutes() {
    const have = { 400: korinnaPresent(400), 700: korinnaPresent(700) };
    document.querySelectorAll('[data-font]').forEach((b) => {
      const F = FONTS[+b.dataset.font];
      const sub = F.family === KORINNA && !have[F.weight];
      b.classList.toggle('sub', sub);
      b.title = sub ? 'ITC Korinna not loaded: showing a substitute. Use Load Fonts.' : '';
    });
    return have[400] && have[700];
  }
  $('#fontFile').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    const loaded = [];
    for (const file of files) {
      const weight = /bold|black|heavy|demi/i.test(file.name) ? 700 : 400;
      try {
        const buffer = await file.arrayBuffer();
        await addKorinna(buffer, weight);
        loaded.push(weight === 700 ? 'BOLD' : 'REGULAR');
        await fontStore('readwrite', (st) => st.put({ buffer, weight, name: file.name }, weight)).catch(() => null);
      } catch (_) {
        flash(`COULD NOT READ ${file.name.toUpperCase()}`);
      }
    }
    if (loaded.length) { relayout(); markSubstitutes(); flash(`KORINNA ${[...new Set(loaded)].join(' + ')} LOADED`); }
  });

  // ---- Disk import / export ----------------------------------------------------------------
  const ioText = $('#ioText'), ioNote = $('#ioNote');
  function openIO() {
    ioText.value = JSON.stringify({ format: 'cg4100-disk', version: 1, messages: disk }, null, 1);
    ioNote.textContent = `${diskNums().length} messages on disk A. Copy or download to keep a backup, or paste a disk here and import it.`;
    io.showModal();
  }
  $('#ioClose').addEventListener('click', () => io.close());
  $('#ioCopy').addEventListener('click', () => {
    const done = () => { ioNote.textContent = 'Disk copied to the clipboard.'; };
    try {
      navigator.clipboard.writeText(ioText.value).then(done, () => { ioText.select(); ioNote.textContent = 'Select-all is on. Press Ctrl+C to copy.'; });
    } catch (_) { ioText.select(); }
  });
  $('#ioDownload').addEventListener('click', () => {
    const blob = new Blob([ioText.value], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `cg4100-disk-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#ioFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) ioText.value = await f.text();
    e.target.value = '';
    ioNote.textContent = 'File loaded into the box. Press Import to merge it onto disk A.';
  });
  $('#ioImport').addEventListener('click', () => {
    let data;
    try { data = JSON.parse(ioText.value); } catch (_) {
      ioNote.textContent = 'That text is not valid JSON. Paste a disk exported from this emulator.';
      return;
    }
    const msgs = data && data.messages ? data.messages : data;
    let count = 0;
    for (const [n, m] of Object.entries(msgs || {})) {
      const k = parseInt(n, 10);
      if (k >= 1 && k <= MAX_MSG && m && m.page) {
        disk[k] = { page: sanitizePage(m.page), saved: m.saved || new Date().toISOString() };
        count++;
      }
    }
    if (!count) { ioNote.textContent = 'No messages found. Each entry needs a number from 1 to 9999 and a page.'; return; }
    saveDisk();
    ioNote.textContent = `Imported ${count} message${count === 1 ? '' : 's'} onto disk A.`;
    flash(`IMPORTED ${count} MSGS`);
  });
  $('#ioReset').addEventListener('click', () => {
    Object.assign(disk, sampleDisk());
    saveDisk();
    ioText.value = JSON.stringify({ format: 'cg4100-disk', version: 1, messages: disk }, null, 1);
    ioNote.textContent = 'Sample messages 1001 to 1006 restored. Your other messages are unchanged.';
  });

  // ---- Boot ----------------------------------------------------------------------------
  function relayout() {
    widthCache.clear();
    for (const ly of [pgm.cur, pgm.prev]) if (ly) ly.L = layoutPage(ly.page, ly.page.mode === 'crawl');
    pvwDirty = pgmDirty = true;
  }

  loadDisk();
  buildPanel();
  // Open in a working state: a lower third on air, the title card in preview.
  if (disk[1002]) { readMsg(1002, true); take(); }
  if (!readMsg(1001, true)) readMsg(diskNums()[0] || 1001, true);
  flash('READY. TYPE TO EDIT PREVIEW, F2 RECORDS, CTRL+ENTER TAKES');
  if (document.fonts) {
    restoreFonts()
      .then(() => Promise.all(FONTS.map((_, i) => document.fonts.load(fontCss(i)).catch(() => null))))
      .then(() => {
        relayout();
        if (!markSubstitutes()) flash('KORINNA NOT LOADED. PRESS LOAD FONTS');
      });
    document.fonts.addEventListener && document.fonts.addEventListener('loadingdone', () => { relayout(); markSubstitutes(); });
  }
  requestAnimationFrame(frame);
})();
