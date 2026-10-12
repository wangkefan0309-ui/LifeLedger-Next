/* ============================================
   人生方格 Canvas 引擎 + 仪式音
   [POS] frontend/grid.js — 渲染 / 持续追焦 / 钟磬·冥音合成
   [INPUT] DOM canvas#grid · state { total_cells, lit_count, overflow } · audio (optional)
   [OUTPUT] window.LifeGrid · window.Starfield · window.RitualAudio
   [PROTOCOL] 修改动画规格先改 设计方案.md §5.4
   ============================================ */

// Adapted from the user's read-only reference. See THIRD_PARTY_NOTICES.md.


  // ---------- 色板（与 CSS tokens 对齐） ----------
  const C = {
    surface:   '#06060c',
    bg:        '#0a0a12',
    past:      '#16161e',  // 已度过 · 纯过去（无记账覆盖）
    tracked:   '#2c2418',  // 已度过且已纳入记账 · 暖灰金
    unlit:     '#2a2a3a',
    unlitDim:  '#1f1f2c',
    asset:     '#9cc3ff',  // 起始资产带来的自由 · 月光银蓝
    assetSoft: '#c0d8ff',  // 资产 highlight
    gold:      '#ffd166',  // 净储蓄带来的自由 · 金色
    goldWarm:  '#ff8b3d',
    goldBloom: '#fff4d6',
    ember:     '#ff5e3a',
    ash:       '#5a4030',
  };

  // ---------- 工具 ----------
  const easeOutQuart = t => 1 - Math.pow(1 - t, 4);
  const lerp = (a, b, t) => a + (b - a) * t;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hexToRgb = h => { const n = parseInt(h.slice(1), 16); return [(n>>16)&255,(n>>8)&255,n&255]; };
  const paletteRgb = colors => Object.fromEntries(['unlit', 'gold', 'goldBloom', 'ember', 'ash', 'goldWarm'].map(key => [key, hexToRgb(colors[key])]));
  // 颜色按数组返回 · 便于多次混合
  const mixArr = (a, b, t) => [
    Math.round(lerp(a[0], b[0], t)),
    Math.round(lerp(a[1], b[1], t)),
    Math.round(lerp(a[2], b[2], t)),
  ];
  const toRgb = a => `rgb(${a[0]},${a[1]},${a[2]})`;

  // ---------- 仪式节奏（再次放慢 · 克制 · 同步）----------
  const IGNITE_MS = 2000;        // 单格点亮完整时长
  const EXTINGUISH_MS = 2600;    // 单格熄灭完整时长
  const FOLLOW_RATE = 8.0;       // camera 追焦阻尼速率（1/秒）· 越大越紧 · 高速避免格子超过 camera
  const CAMERA_SETTLE_MS = 1100; // 收尾归位等待时长

  // 每格之间的触发间隔（鼓点感）
  const intervalFor = (delta) => {
    if (delta <= 3)   return 780;
    if (delta <= 8)   return 540;
    if (delta <= 20)  return 340;
    if (delta <= 60)  return 180;
    if (delta <= 200) return 78;
    if (delta <= 800) return 26;
    return 10;
  };

  // 单格音量（自适应 · 大 delta 时降低避免叠加爆音）
  const audioVolumePer = (delta) => {
    if (delta <= 3)   return 0.34;
    if (delta <= 10)  return 0.24;
    if (delta <= 30)  return 0.15;
    if (delta <= 100) return 0.085;
    if (delta <= 400) return 0.045;
    return 0.025;
  };

  // 缩放档位 · delta 越大用稍低 scale 留出周边视野
  const pickScale = (delta) => {
    if (delta >= 500) return 3.6;
    if (delta >= 100) return 5;
    if (delta >= 30)  return 7;
    if (delta >= 10)  return 8.5;
    return 10;
  };

  // ---------- 单格微动画 · 三轴共用同一 envelope · 同步绽放与收敛 ----------
  // envelope: attack 0.10 短脉冲 → release 0.90 慢回落 · color / halo / scale 同步
  const envelope = (t, attack, releaseExp) => {
    if (t >= 1) return 0;
    if (t < attack) return easeOutQuart(t / attack);
    return Math.pow(1 - (t - attack) / (1 - attack), releaseExp);
  };

  // ignite: 颜色单调 unlit→gold（不回退）· halo / scale 走 envelope 脉冲
  // 关键修复：颜色路径不再绑定 envelope，避免 release 期格子退回暗色造成"重复点亮"错觉
  const igniteFrame = (t, C, RGB) => {
    if (t >= 1) return { color: C.gold, halo: 0.08, scale: 1.0 };
    const env = envelope(t, 0.10, 1.4);
    // 颜色：22% 时间内单调 ramp 到 gold，之后稳态保持
    // ⚠ clamp 必须在 easing 输入端 · easeOutQuart 对 x>1 返回负值，会导致 RGB 跑黑
    const colorT = easeOutQuart(Math.min(1, t / 0.22));
    let c = mixArr(RGB.unlit, RGB.gold, colorT);
    // peak 时叠少量 bloom highlight（脉冲 · 不影响基色）
    c = mixArr(c, RGB.goldBloom, env * env * 0.45);
    return { color: toRgb(c), halo: env * 0.48, scale: 1 + env * 0.16 };
  };

  // extinguish: 金→暗金褐→灰烬→暗 · 全程暖色暗化 · 不引入红色警示
  // 调性：失去 = 平静的黯淡，不是报警
  const extinguishFrame = (t, C, RGB) => {
    if (t >= 1) return { color: C.unlit, halo: 0, scale: 1 };
    const env = envelope(t, 0.18, 1.4);
    // 颜色单调下降：65% 时间内从 gold linear 过渡到 ash，末段 ash→unlit
    let c;
    if (t < 0.65) {
      c = mixArr(RGB.gold, RGB.ash, t / 0.65); // linear · 避免快速跳变
    } else {
      c = mixArr(RGB.ash, RGB.unlit, easeOutQuart((t - 0.65) / 0.35));
    }
    return { color: toRgb(c), halo: env * 0.30, scale: 1 + env * 0.10 };
  };

  // ============================================
  // RitualAudio · Web Audio 合成
  //   ignite: inharmonic 钟磬般高频和谐衰减
  //   extinguish: 低频冥音 · 长 decay
  // ============================================
  class RitualAudio {
    constructor() {
      this.ctx = null;
      this.master = null;
      this.muted = false;
    }
    ensure() {
      if (!this.ctx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        this.ctx = new Ctx();
        this.master = this.ctx.createGain();
        this.master.gain.value = 1.0;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }
    setMuted(m) { this.muted = !!m; }

    /** 钟磬：基频 + 非整数比 partials · exponential decay */
    ignite(volume = 0.18) {
      if (this.muted) return;
      const ctx = this.ensure();
      if (!ctx) return;
      const now = ctx.currentTime;
      const base = 880 * (1 + (Math.random() - 0.5) * 0.04);
      const partials = [
        { r: 1.00, g: 1.00, d: 1.6 },
        { r: 2.76, g: 0.50, d: 1.0 },
        { r: 5.40, g: 0.22, d: 0.6 },
        { r: 8.93, g: 0.10, d: 0.32 },
      ];
      for (const p of partials) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = base * p.r;
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(volume * p.g, now + 0.006);
        gain.gain.exponentialRampToValueAtTime(0.00012, now + p.d);
        osc.connect(gain).connect(this.master);
        osc.start(now);
        osc.stop(now + p.d + 0.05);
      }
    }

    /** 彩蛋大和弦：C5 E5 G5 C6 同步起，每音叠加 inharmonic partials，4.5 秒长 sustain */
    celebrateChord(volume = 0.32) {
      if (this.muted) return;
      const ctx = this.ensure();
      if (!ctx) return;
      const now = ctx.currentTime;
      // 大三和弦：C5 + E5 + G5 + C6（C major）
      const notes = [523.25, 659.25, 783.99, 1046.5];
      const partials = [
        { r: 1.00, g: 0.40, d: 4.8 },
        { r: 2.00, g: 0.22, d: 3.2 },
        { r: 3.01, g: 0.12, d: 2.0 },
        { r: 5.40, g: 0.06, d: 1.2 },
      ];
      for (const base of notes) {
        for (const p of partials) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = base * p.r;
          gain.gain.setValueAtTime(0, now);
          gain.gain.linearRampToValueAtTime(volume * p.g, now + 0.10);
          gain.gain.exponentialRampToValueAtTime(0.00012, now + p.d);
          osc.connect(gain).connect(this.master);
          osc.start(now);
          osc.stop(now + p.d + 0.05);
        }
      }
      // 紧随而至的低频锚铃 · C3 给整体提供厚重的"地基"
      const bell = ctx.createOscillator();
      const bellGain = ctx.createGain();
      bell.type = 'triangle';
      bell.frequency.value = 130.81;
      bellGain.gain.setValueAtTime(0, now);
      bellGain.gain.linearRampToValueAtTime(volume * 0.55, now + 0.12);
      bellGain.gain.exponentialRampToValueAtTime(0.0001, now + 5.0);
      bell.connect(bellGain).connect(this.master);
      bell.start(now);
      bell.stop(now + 5.1);
    }

    /** 冥音：低频 + 八度低 + 不和谐 1.59 倍 · 厚重温和 */
    extinguish(volume = 0.20) {
      if (this.muted) return;
      const ctx = this.ensure();
      if (!ctx) return;
      const now = ctx.currentTime;
      const base = 220 * (1 + (Math.random() - 0.5) * 0.05);
      // 主基音用 triangle 增加质感，余 sine
      const partials = [
        { r: 1.00,  g: 1.00, d: 1.4, t: 'triangle' },
        { r: 0.50,  g: 0.55, d: 1.8, t: 'sine' },
        { r: 1.59,  g: 0.35, d: 0.9, t: 'sine' },
      ];
      for (const p of partials) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = p.t;
        osc.frequency.value = base * p.r;
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(volume * p.g, now + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.00012, now + p.d);
        osc.connect(gain).connect(this.master);
        osc.start(now);
        osc.stop(now + p.d + 0.05);
      }
    }
  }


  // ============================================
  // LifeGrid 主类
  // ============================================
  class LifeGrid {
    constructor(canvas, audio = null) {
      this.canvas = canvas;
      this.colors = { ...C };
      this.rgb = paletteRgb(this.colors);
      this.lightTheme = false;
      this.ctx = canvas.getContext('2d');
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.audio = audio;
      this.totalCells = 0;
      this.futureCells = 0;
      this.pastCells = 0;       // 已度过天数（show_past 关闭时为 0）
      this.trackedPastCells = 0;// past 段中"已纳入记账"的尾部
      this.litCount = 0;        // 未来格中已点亮总数 = assetLit + incomeLit
      this.assetLit = 0;        // 起始资产带来的自由格数（在 income 之前）
      this.incomeLit = 0;       // 净储蓄带来的自由格数
      this.overflow = 0;
      this.cols = 1;
      this.rows = 0;
      this.cellSize = 4;
      this.gap = 0;
      this.padding = 18;
      this.grid = { w: 0, h: 0, x: 0, y: 0 };
      this.camera       = { scale: 1, tx: 0, ty: 0 };
      this.cameraTarget = { scale: 1, tx: 0, ty: 0 };
      this.lastTick = performance.now();
      this.animations = new Map();
      this.rafId = null;
      this.needsRedraw = true;
      this.bound = false;
      this.generation = 0;
      this.waiters = new Map();
      this.paused = false;       // 彩蛋期间暂停渲染 · 释放主线程
    }

    setPalette(colors, lightTheme = false) {
      this.colors = { ...C, ...colors };
      this.rgb = paletteRgb(this.colors);
      this.lightTheme = lightTheme;
      this.needsRedraw = true;
      if (!this.rafId && this.cssW) this.draw();
    }

    pause()  { this.paused = true; }
    resume() { this.paused = false; this.needsRedraw = true; this.lastTick = performance.now(); }

    mount() {
      if (this.bound) return;
      this.bound = true;
      window.addEventListener('resize', () => this.resize());
      this.resize();
      this.loop();
    }

    setData({ total_cells, lit_count, overflow, past_cells, future_cells, asset_lit, income_lit, tracked_past_cells }) {
      this.totalCells = total_cells || 0;
      this.pastCells = past_cells || 0;
      this.trackedPastCells = Math.min(tracked_past_cells || 0, this.pastCells);
      this.futureCells = future_cells || this.totalCells;
      this.assetLit = Math.min(asset_lit || 0, this.futureCells);
      this.incomeLit = Math.min(income_lit || 0, Math.max(0, this.futureCells - this.assetLit));
      this.litCount = Math.min(lit_count || 0, this.futureCells);
      this.overflow = overflow || 0;
      this.relayout();
      this.needsRedraw = true;
    }

    resize() {
      const rect = this.canvas.parentElement.getBoundingClientRect();
      this.canvas.width  = Math.floor(rect.width  * this.dpr);
      this.canvas.height = Math.floor(rect.height * this.dpr);
      this.canvas.style.width  = rect.width  + 'px';
      this.canvas.style.height = rect.height + 'px';
      this.cssW = rect.width;
      this.cssH = rect.height;
      this.relayout();
      this.needsRedraw = true;
    }

    /** 填满式自适应：搜索能容纳全部格子的最大单格尺寸 */
    relayout() {
      if (!this.totalCells || !this.cssW) return;
      const padding = this.padding;
      const W = Math.max(40, this.cssW - padding * 2);
      const H = Math.max(40, this.cssH - padding * 2);
      const N = this.totalCells;
      const cols = Math.max(1, Math.ceil(Math.sqrt(N * W / H)));
      const rows = Math.ceil(N / cols);
      const step = Math.min(W / cols, H / rows);
      const gap = Math.min(1, step * 0.24);
      const best = { cell: Math.max(0.08, step - gap), cols, rows, gap };
      this.cellSize = best.cell;
      this.cols = best.cols;
      this.rows = best.rows;
      this.gap  = best.gap;
      const gridW = best.cols * best.cell + (best.cols - 1) * best.gap;
      const gridH = best.rows * best.cell + (best.rows - 1) * best.gap;
      this.grid = { w: gridW, h: gridH, x: (this.cssW - gridW) / 2, y: (this.cssH - gridH) / 2 };
    }

    cellRect(idx) {
      const col = idx % this.cols;
      const row = (idx / this.cols) | 0;
      const x = this.grid.x + col * (this.cellSize + this.gap);
      const y = this.grid.y + row * (this.cellSize + this.gap);
      return { x, y, w: this.cellSize, h: this.cellSize };
    }

    /** 根据 litCount 和 assetLit 上限，自洽 incomeLit · 用于动画推进时保持 drawGrid 分段正确 */
    _syncLitSegments() {
      if (this.litCount <= this.assetLit) {
        // litCount 已收缩到 asset 段内 · asset 缩短
        this.assetLit = this.litCount;
        this.incomeLit = 0;
      } else {
        this.incomeLit = this.litCount - this.assetLit;
      }
    }
    cellCenter(idx) {
      const r = this.cellRect(idx);
      return { cx: r.x + r.w / 2, cy: r.y + r.h / 2 };
    }

    // ---------- camera 追焦 ----------
    setCameraToCell(idx, scale) {
      const { cx, cy } = this.cellCenter(idx);
      const centerX = this.cssW / 2;
      const centerY = this.cssH / 2;
      this.cameraTarget = { scale, tx: scale * (centerX - cx), ty: scale * (centerY - cy) };
    }
    resetCamera() { this.cameraTarget = { scale: 1, tx: 0, ty: 0 }; }
    cameraConverged() {
      return Math.abs(this.camera.scale - this.cameraTarget.scale) < 0.003
          && Math.abs(this.camera.tx    - this.cameraTarget.tx)    < 0.4
          && Math.abs(this.camera.ty    - this.cameraTarget.ty)    < 0.4;
    }

    // ---------- 主循环 ----------
    loop() {
      const tick = (now) => {
        if (this.paused) { this.rafId = requestAnimationFrame(tick); return; }
        const dt = Math.min(0.05, (now - this.lastTick) / 1000);
        this.lastTick = now;
        const k = 1 - Math.exp(-FOLLOW_RATE * dt);
        this.camera.scale = lerp(this.camera.scale, this.cameraTarget.scale, k);
        this.camera.tx    = lerp(this.camera.tx,    this.cameraTarget.tx,    k);
        this.camera.ty    = lerp(this.camera.ty,    this.cameraTarget.ty,    k);

        const moving = !this.cameraConverged();
        // today 呼吸需要持续重绘
        const breathing = this.totalCells > 0 && this.pastCells < this.totalCells;
        if (this.animations.size > 0 || this.needsRedraw || moving || breathing) {
          this.draw();
          this.needsRedraw = false;
        }

        // 在动画 dur 完成的瞬间把状态注入 litCount + 同步两段（asset / income）
        const past = this.pastCells;
        for (const [idx, a] of this.animations) {
          if (now - a.t0 >= a.dur) {
            const rel = idx - past;
            if (a.type === 'ignite')          this.litCount = Math.max(this.litCount, rel + 1);
            else if (a.type === 'extinguish') this.litCount = Math.min(this.litCount, rel);
            this._syncLitSegments();
            this.animations.delete(idx);
          }
        }
        this.rafId = requestAnimationFrame(tick);
      };
      this.rafId = requestAnimationFrame(tick);
    }

    // ---------- 绘制 ----------
    draw() {
      const { ctx, dpr } = this;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = this.colors.surface;
      ctx.fillRect(0, 0, this.cssW, this.cssH);

      const { scale, tx, ty } = this.camera;
      const cx = this.cssW / 2;
      const cy = this.cssH / 2;
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (cx - cx * scale + tx), dpr * (cy - cy * scale + ty));

      this.drawGrid(ctx);
      this.drawAnimating(ctx);
      this.drawToday(ctx); // today 高亮恒在最上层
    }

    drawGrid(ctx) {
      const C = this.colors;
      const total = this.totalCells;
      if (!total) return;
      const cell = this.cellSize;
      const step = cell + this.gap;
      const past = this.pastCells;
      const tracked = this.trackedPastCells;
      const trackedStart = Math.max(0, past - tracked);
      const assetEnd = past + this.assetLit;
      const incomeEnd = assetEnd + this.incomeLit;
      const animating = this.animations;

      // ① 纯过去（无记账） · idx [0, trackedStart)
      if (trackedStart > 0) {
        this._fillRange(ctx, C.past, 0, trackedStart, step, cell, animating);
      }
      // ② 已记账的过去 · idx [trackedStart, past)
      if (tracked > 0) {
        this._fillRange(ctx, C.tracked, trackedStart, past, step, cell, animating);
      }
      // ③ 起始资产自由（月光银蓝） · idx [past, assetEnd)
      if (this.assetLit > 0) {
        this._fillRange(ctx, C.asset, past, assetEnd, step, cell, animating);
      }
      // ④ 净储蓄自由（金色） · idx [assetEnd, incomeEnd)
      if (this.incomeLit > 0) {
        this._fillRange(ctx, C.gold, assetEnd, incomeEnd, step, cell, animating);
      }
      // ⑤ 未点亮未来 · idx [incomeEnd, total)
      this._fillRange(ctx, C.unlit, incomeEnd, total, step, cell, animating);

      // 已点亮区域全局柔光（远景）
      const lit = this.litCount;
      if (lit > 0 && this.camera.scale < 2.0 && incomeEnd > past) {
        const last = this.cellRect(Math.min(incomeEnd - 1, total - 1));
        const first = this.cellRect(past);
        const g = ctx.createLinearGradient(0, first.y, 0, last.y + last.h);
        g.addColorStop(0, 'rgba(255, 209, 102, 0.04)');
        g.addColorStop(1, 'rgba(255, 209, 102, 0.0)');
        ctx.fillStyle = g;
        ctx.fillRect(first.x - 8, first.y - 8, this.grid.w + 16, (last.y + last.h) - first.y + 16);
      }
    }

    _fillRange(ctx, color, from, to, step, cell, animating) {
      if (to <= from) return;
      ctx.fillStyle = color;
      ctx.beginPath();
      for (let i = from; i < to; i++) {
        if (animating.has(i)) continue;
        const col = i % this.cols;
        const row = (i / this.cols) | 0;
        ctx.rect(this.grid.x + col * step, this.grid.y + row * step, cell, cell);
      }
      ctx.fill();
    }

    /** 今天的格子永久呼吸高亮 · 独立 overlay 层 · 始终在最上 */
    drawToday(ctx) {
      const C = this.colors, rgb = this.rgb;
      const idx = this.pastCells; // 第一个非过去格 = 今天
      if (!this.totalCells || idx >= this.totalCells) return;
      const r = this.cellRect(idx);
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      // 1.6s 呼吸周期
      const breath = 0.5 + 0.5 * Math.sin(performance.now() * 0.0040);
      const intensity = 0.55 + 0.45 * breath;

      // 外圈光晕（additive）
      const haloR = r.w * (3.0 + breath * 2.0);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, haloR);
      g.addColorStop(0,    `rgba(${rgb.goldBloom.join(',')}, ${0.55 * intensity})`);
      g.addColorStop(0.35, `rgba(${rgb.gold.join(',')}, ${0.28 * intensity})`);
      g.addColorStop(1,    `rgba(${rgb.goldWarm.join(',')}, 0)`);
      ctx.globalCompositeOperation = this.lightTheme ? 'source-over' : 'lighter';
      ctx.fillStyle = g;
      ctx.fillRect(cx - haloR, cy - haloR, haloR * 2, haloR * 2);
      ctx.globalCompositeOperation = 'source-over';

      // 中心格本体 · 用 goldBloom 强标识（无论 today 是 lit 还是 unlit 都覆盖为发光）
      const s = 1 + breath * 0.10;
      const w = r.w * s, h = r.h * s;
      ctx.fillStyle = C.goldBloom;
      ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
    }

    drawAnimating(ctx) {
      const rgb = this.rgb;
      const now = performance.now();
      const size = this.animations.size;
      // 大批量动画时降级 halo 渲染 · 避免 createRadialGradient 数百次/帧
      const haloStep = size > 100 ? Math.ceil(size / 40) : 1;
      let counter = 0;
      for (const [idx, a] of this.animations) {
        const t = Math.min(1, (now - a.t0) / a.dur);
        const frame = a.anim(t);
        const r = this.cellRect(idx);
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h / 2;
        const s = frame.scale;

        const drawHalo = frame.halo > 0.02 && (counter % haloStep === 0);
        if (drawHalo) {
          const haloR = r.w * (2.0 + frame.halo * 3.2);
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, haloR);
          g.addColorStop(0,    `rgba(${rgb.goldBloom.join(',')}, ${0.42 * frame.halo})`);
          g.addColorStop(0.40, `rgba(${rgb.gold.join(',')}, ${0.20 * frame.halo})`);
          g.addColorStop(1,    `rgba(${rgb.goldWarm.join(',')}, 0)`);
          ctx.globalCompositeOperation = this.lightTheme ? 'source-over' : 'lighter';
          ctx.fillStyle = g;
          ctx.fillRect(cx - haloR, cy - haloR, haloR * 2, haloR * 2);
          ctx.globalCompositeOperation = 'source-over';
        }

        ctx.fillStyle = frame.color;
        const w = r.w * s, h = r.h * s;
        ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
        counter++;
      }
    }

    pickScale(delta) { return pickScale(delta); }

    // ============================================
    // 仪式动画 · 持续追焦
    // ============================================
    /** from / to 是 future-relative 索引（freedom_days_bought 区间）· 内部偏移 pastCells 转真实 idx */
    wait(ms) {
      return new Promise(resolve => {
        const timer = setTimeout(() => { this.waiters.delete(timer); resolve(); }, ms);
        this.waiters.set(timer, resolve);
      });
    }
    cancel() {
      this.generation++;
      for (const [timer, resolve] of this.waiters) { clearTimeout(timer); resolve(); }
      this.waiters.clear();
      if (this.rafId !== null) cancelAnimationFrame(this.rafId);
      this.rafId = null;
      this.animations.clear();
      this.camera = { scale: 1, tx: 0, ty: 0 };
      this.resetCamera();
    }
    async lightUp(from, to) {
      const generation = this.generation;
      const delta = to - from;
      if (delta <= 0) return;
      if (prefersReducedMotion()) { this.litCount = to; this.needsRedraw = true; return; }

      const past = this.pastCells;
      const realFrom = from + past;
      const realTo = to + past;
      const scale = pickScale(delta);
      const vol = audioVolumePer(delta);
      this.setCameraToCell(realFrom, scale);
      await this.wait(600);
      if (generation !== this.generation) return;

      const interval = intervalFor(delta);
      for (let i = realFrom; i < realTo; i++) {
        this.animations.set(i, { type: 'ignite', t0: performance.now(), dur: IGNITE_MS, anim: t => igniteFrame(t, this.colors, this.rgb) });
        this.setCameraToCell(i, scale);
        if (this.audio) this.audio.ignite(vol);
        this.needsRedraw = true;
        if (i < realTo - 1) await this.wait(interval);
        if (generation !== this.generation) return;
      }
      await this.wait(IGNITE_MS);
      if (generation !== this.generation) return;
      this.litCount = Math.max(this.litCount, to);
      this._syncLitSegments();
      this.resetCamera();
      await this.wait(CAMERA_SETTLE_MS);
      if (generation !== this.generation) return;
    }

    async extinguish(from, to) {
      const generation = this.generation;
      const delta = to - from;
      if (delta <= 0) return;
      if (prefersReducedMotion()) { this.litCount = from; this.needsRedraw = true; return; }

      const past = this.pastCells;
      const realFrom = from + past;
      const realTo = to + past;
      const scale = pickScale(delta);
      const vol = audioVolumePer(delta);
      this.setCameraToCell(realTo - 1, scale);
      await this.wait(600);
      if (generation !== this.generation) return;

      const interval = Math.round(intervalFor(delta) * 1.4);
      for (let i = realTo - 1; i >= realFrom; i--) {
        this.animations.set(i, { type: 'extinguish', t0: performance.now(), dur: EXTINGUISH_MS, anim: t => extinguishFrame(t, this.colors, this.rgb) });
        this.setCameraToCell(i, scale);
        if (this.audio) this.audio.extinguish(vol);
        this.needsRedraw = true;
        if (i > realFrom) await this.wait(interval);
        if (generation !== this.generation) return;
      }
      await this.wait(EXTINGUISH_MS);
      if (generation !== this.generation) return;
      this.litCount = from;
      this._syncLitSegments();
      this.resetCamera();
      await this.wait(CAMERA_SETTLE_MS);
      if (generation !== this.generation) return;
    }
  }


  // ============================================
  // 星空背景
  // ============================================
  class Starfield {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.stars = [];
    }
    mount() {
      const resize = () => {
        const w = window.innerWidth, h = window.innerHeight;
        this.canvas.width = w * this.dpr;
        this.canvas.height = h * this.dpr;
        this.canvas.style.width = w + 'px';
        this.canvas.style.height = h + 'px';
        this.w = w; this.h = h;
        this.stars = this.makeStars(120);
      };
      window.addEventListener('resize', resize);
      resize();
      this.loop();
    }
    makeStars(n) {
      const out = [];
      for (let i = 0; i < n; i++) {
        out.push({ x: Math.random() * this.w, y: Math.random() * this.h, r: Math.random() * 1.1 + 0.2, phase: Math.random() * Math.PI * 2, speed: 0.0006 + Math.random() * 0.0012 });
      }
      return out;
    }
    loop() {
      const tick = (t) => {
        const { ctx, dpr } = this;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, this.w, this.h);
        for (const s of this.stars) {
          const a = 0.25 + 0.55 * (Math.sin(s.phase + t * s.speed) * 0.5 + 0.5);
          ctx.fillStyle = `rgba(255, 245, 220, ${a * 0.6})`;
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
          ctx.fill();
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  }


export { LifeGrid, RitualAudio };
