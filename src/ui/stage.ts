import { LifeGrid, RitualAudio } from './vendor/grid.js';
import { daysBetween, localDate } from '../core/primitives';
import type { Config } from '../core/types';
import type { freedom } from '../core/calculations';
type Freedom = ReturnType<typeof freedom>;
export class Stage {
  private grid: any;
  private audio: any;
  private observer: ResizeObserver;
  private themeObserver: MutationObserver;
  private disposed = false;
  private generation = 0;
  private finalData: object = {};
  private banner: HTMLElement;
  constructor(private host: HTMLElement, private config: Config, current: Freedom) {
    const canvas = host.ownerDocument.createElement('canvas'); canvas.setAttribute('aria-label', '每一格代表一天，蓝色表示起始资金，金色表示后续增加');
    host.append(canvas);
    this.banner = host.ownerDocument.createElement('div'); this.banner.className = 'll-celebration'; this.banner.hidden = true;
    this.banner.textContent = '按当前基线，已覆盖所选区间'; host.append(this.banner);
    this.audio = new RitualAudio(); this.audio.setMuted(!config.sound);
    this.grid = new LifeGrid(canvas, this.audio);
    this.updatePalette();
    this.themeObserver = new (host.ownerDocument.defaultView ?? window).MutationObserver(() => {
      if (!this.disposed && host.ownerDocument.body.classList.contains('theme-light') !== this.grid.lightTheme) this.updatePalette();
    });
    this.themeObserver.observe(host.ownerDocument.body, { attributes: true, attributeFilter: ['class'] });
    this.observer = new (host.ownerDocument.defaultView ?? window).ResizeObserver(() => { if (!this.disposed) { this.grid.resize(); if (!this.grid.rafId) this.grid.draw(); } });
    this.observer.observe(host); this.set(current);
  }
  private updatePalette() {
    const style = (this.host.ownerDocument.defaultView ?? window).getComputedStyle(this.host);
    const tokens: Record<string, string> = { surface: 'bg', past: 'past', tracked: 'tracked', unlit: 'unlit', asset: 'asset', gold: 'gold', goldBloom: 'bloom', goldWarm: 'warm', ash: 'ash' };
    const palette = Object.fromEntries(Object.entries(tokens).map(([key, token]) => [key, style.getPropertyValue(`--ll-grid-${token}`).trim()]).filter(([, value]) => value));
    this.grid.setPalette(palette, style.getPropertyValue('--ll-scheme').trim() === 'light');
  }
  set(f: Freedom) {
    const today = localDate(), future = Math.max(0, daysBetween(today, this.config.displayEnd));
    const past = this.config.showPast && this.config.birthDate && this.config.birthDate <= today ? daysBetween(this.config.birthDate, today) : 0;
    this.finalData = { total_cells: future + past, future_cells: future, past_cells: past, tracked_past_cells: Math.min(past, f.baseline.days), lit_count: Math.min(f.count ?? 0, future), asset_lit: Math.min(f.blue, future), income_lit: Math.min(f.gold, Math.max(0, future - f.blue)), overflow: Math.max(0, (f.count ?? 0) - future) };
    this.grid.setData(this.finalData); this.grid.resize(); this.grid.draw();
  }
  async play(before: Freedom, after: Freedom) {
    this.skip(); const generation = this.generation;
    this.set(after); const future = this.grid.futureCells;
    const start = Math.min(before.count ?? 0, future), end = Math.min(after.count ?? 0, future);
    if (before.count === null || after.count === null || start === end || this.config.animation === 'off' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (this.config.animation === 'short') {
      this.host.animate([{ opacity: 0.45 }, { opacity: 1 }], { duration: 450 });
      if (this.config.sound) end > start ? this.audio.ignite() : this.audio.extinguish();
    } else {
      this.grid.litCount = start; this.grid.assetLit = Math.min(before.blue, start); this.grid._syncLitSegments(); this.grid.loop();
      await (end > start ? this.grid.lightUp(start, end) : this.grid.extinguish(end, start));
      if (this.disposed || this.generation !== generation) return;
      this.grid.cancel(); this.set(after);
    }
    if (future > 0 && end >= future && start < future) {
      this.banner.hidden = false;
      if (this.config.sound) this.audio.celebrateChord();
    }
  }
  skip() { this.generation++; this.grid.cancel(); this.banner.hidden = true; this.grid.setData(this.finalData); this.grid.resize(); this.grid.draw(); }
  destroy() {
    this.disposed = true; this.generation++; this.observer.disconnect(); this.themeObserver.disconnect(); this.grid.cancel();
    this.host.getAnimations().forEach(a => a.cancel());
    if (this.audio.ctx) void this.audio.ctx.close().catch(() => undefined);
  }
}
