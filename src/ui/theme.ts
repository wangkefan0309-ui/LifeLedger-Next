import type { Config } from '../core/types';

/** Scoped to this view; never changes Obsidian's global theme. */
export class ViewTheme {
  private preference: NonNullable<Config['theme']> = 'system';
  private system: MediaQueryList;
  private changed = () => this.apply();
  constructor(private root: HTMLElement) {
    this.system = (root.ownerDocument.defaultView ?? window).matchMedia('(prefers-color-scheme: dark)');
    this.system.addEventListener('change', this.changed);
  }
  set(preference: Config['theme']) { this.preference = preference ?? 'system'; this.apply(); }
  private apply() {
    this.root.dataset.theme = this.preference === 'system' ? (this.system.matches ? 'dark' : 'light') : this.preference;
  }
  destroy() { this.system.removeEventListener('change', this.changed); }
}
