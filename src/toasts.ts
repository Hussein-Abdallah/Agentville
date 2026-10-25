// Toasts: small cards in the corner of the map for things worth a glance (a robot needs you, a test
// failed…). Click one to go there; each fades out by itself, and a newer one with the same key replaces it.

export interface Toast {
  /** one toast per key (a robot's needs-you toast is replaced, not stacked) */
  key: string;
  /** colour of the edge: needs you, failed, finished, came or went */
  tone: 'wait' | 'bad' | 'done' | 'info';
  /** the robot's colour */
  dot?: string;
  /** already escaped HTML */
  title: string;
  body?: string;
  onClick?: () => void;
  /** seconds on screen */
  seconds?: number;
}

const MAX = 4;

export class Toasts {
  private items = new Map<string, { el: HTMLElement; timer: number }>();

  constructor(private el: HTMLElement) {}

  show(t: Toast) {
    this.dismiss(t.key, false);
    while (this.items.size >= MAX) this.dismiss(this.items.keys().next().value!, false);
    const el = document.createElement('div');
    el.className = `toast ${t.tone}`;
    el.innerHTML = `${t.dot ? `<span class="dot" style="background:${t.dot}"></span>` : ''}<div class="mid"><div class="tt">${t.title}</div>${t.body ? `<div class="tb">${t.body}</div>` : ''}</div><button class="x" title="Dismiss">✕</button>`;
    el.onclick = (e) => {
      this.dismiss(t.key);
      if (!(e.target as HTMLElement).closest('.x')) t.onClick?.();
    };
    this.el.prepend(el);
    const timer = window.setTimeout(() => this.dismiss(t.key), (t.seconds ?? 8) * 1000);
    this.items.set(t.key, { el, timer });
  }

  /** Takes a toast away (the robot no longer needs you…), fading unless `fade` is false. */
  dismiss(key: string, fade = true) {
    const it = this.items.get(key);
    if (!it) return;
    this.items.delete(key);
    clearTimeout(it.timer);
    if (!fade) return it.el.remove();
    it.el.classList.add('out');
    setTimeout(() => it.el.remove(), 250);
  }
}
