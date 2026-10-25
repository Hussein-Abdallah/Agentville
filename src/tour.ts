// The first-run tour: a few steps that light up one part of the page at a time (the rest dims) with a
// short card beside it. Next / Back / Skip, arrow keys and Esc. Shown once on the first visit; Settings
// can run it again.

export interface TourStep {
  /** the element to light up (the card goes in the middle when it isn't on screen) */
  target: string;
  title: string;
  text: string;
  /** run before showing the step (open the world map…) */
  before?: () => void;
}

export class Tour {
  private el: HTMLElement;
  private spot: HTMLElement;
  private card: HTMLElement;
  private i = 0;
  private steps: TourStep[] = [];
  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this.end();
    else if (e.key === 'ArrowRight' || e.key === 'Enter') this.go(this.i + 1);
    else if (e.key === 'ArrowLeft') this.go(this.i - 1);
    else return;
    e.preventDefault(); e.stopPropagation();
  };
  private onResize = () => this.place();

  constructor(private onEnd?: () => void) {
    this.el = document.createElement('div');
    this.el.id = 'tour';
    this.el.hidden = true;
    this.el.innerHTML = '<div class="tr-spot"></div><div class="tr-card" role="dialog" aria-live="polite"></div>';
    document.body.append(this.el);
    this.spot = this.el.querySelector('.tr-spot')!;
    this.card = this.el.querySelector('.tr-card')!;
    this.card.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('[data-tr]')?.dataset.tr;
      if (a === 'next') this.go(this.i + 1);
      else if (a === 'back') this.go(this.i - 1);
      else if (a === 'skip') this.end();
    });
  }

  get running() { return !this.el.hidden; }

  start(steps: TourStep[]) {
    this.steps = steps;
    this.el.hidden = false;
    addEventListener('keydown', this.onKey, true);
    addEventListener('resize', this.onResize);
    this.go(0);
  }

  end() {
    if (this.el.hidden) return;
    this.el.hidden = true;
    removeEventListener('keydown', this.onKey, true);
    removeEventListener('resize', this.onResize);
    this.onEnd?.();
  }

  private go(i: number) {
    if (i >= this.steps.length) return this.end();
    this.i = Math.max(0, i);
    const s = this.steps[this.i];
    s.before?.();
    const last = this.i === this.steps.length - 1;
    this.card.innerHTML = `<div class="tr-n">${this.i + 1} of ${this.steps.length}</div><h3>${s.title}</h3><p>${s.text}</p>
      <div class="tr-btns"><button data-tr="skip" class="tr-skip">${last ? 'Close' : 'Skip tour'}</button>
      ${this.i ? '<button data-tr="back">Back</button>' : ''}<button data-tr="next" class="tr-next">${last ? 'Done' : 'Next'}</button></div>`;
    // the step may have opened something: place it once the page has drawn it
    requestAnimationFrame(() => requestAnimationFrame(() => this.place()));
    this.place();
  }

  /** Light up the target and put the card next to it (below, above, beside, or centred). */
  private place() {
    const s = this.steps[this.i];
    const t = s && document.querySelector<HTMLElement>(s.target);
    const r = t?.getBoundingClientRect();
    const seen = r && r.width > 2 && r.height > 2;
    const pad = 6, W = innerWidth, H = innerHeight;
    if (seen) Object.assign(this.spot.style, { display: '', left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    else Object.assign(this.spot.style, { display: '', left: `${W / 2}px`, top: `${H / 2}px`, width: '0px', height: '0px' });
    const cw = this.card.offsetWidth, ch = this.card.offsetHeight, gap = 14;
    let x = W / 2 - cw / 2, y = H / 2 - ch / 2;
    if (seen) {
      if (r.bottom + gap + ch < H) { y = r.bottom + gap; x = r.left + r.width / 2 - cw / 2; }
      else if (r.top - gap - ch > 0) { y = r.top - gap - ch; x = r.left + r.width / 2 - cw / 2; }
      else if (r.left - gap - cw > 0) { x = r.left - gap - cw; y = r.top + r.height / 2 - ch / 2; }
      else if (r.right + gap + cw < W) { x = r.right + gap; y = r.top + r.height / 2 - ch / 2; }
      // a big target (the whole town): the card sits inside it, near the bottom
      else { x = r.left + r.width / 2 - cw / 2; y = Math.min(r.bottom - ch - 24, H - ch - 16); }
    }
    this.card.style.left = `${Math.max(12, Math.min(W - cw - 12, x))}px`;
    this.card.style.top = `${Math.max(12, Math.min(H - ch - 12, y))}px`;
  }
}
