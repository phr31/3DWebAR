export interface GestureHandlers {
  onPan?: (dxPx: number, dyPx: number) => void;
  /** `factor` > 1 significa afastar os dedos. */
  onPinch?: (factor: number) => void;
  onRotate?: (deltaRad: number) => void;
  onTap?: (x: number, y: number) => void;
}

interface Pointer {
  x: number;
  y: number;
}

const TAP_MAX_MOVE_PX = 12;
const TAP_MAX_MS = 400;

/**
 * Gestos de toque para o engine de passthrough. Um ponteiro arrasta; dois
 * ponteiros pinçam e giram. Usa Pointer Events, então cobre mouse e toque com o
 * mesmo código.
 */
export class GestureController {
  private readonly pointers = new Map<number, Pointer>();
  private lastDistance = 0;
  private lastAngle = 0;
  private downAt = 0;
  private downPos: Pointer = { x: 0, y: 0 };
  private moved = 0;
  private attached = false;

  constructor(
    private readonly element: HTMLElement,
    private readonly handlers: GestureHandlers,
    private readonly enabled: { move: boolean; scale: boolean; rotate: boolean },
  ) {}

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.element.addEventListener('pointerdown', this.onDown);
    this.element.addEventListener('pointermove', this.onMove);
    this.element.addEventListener('pointerup', this.onUp);
    this.element.addEventListener('pointercancel', this.onUp);
    this.element.addEventListener('pointerleave', this.onUp);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.element.removeEventListener('pointerdown', this.onDown);
    this.element.removeEventListener('pointermove', this.onMove);
    this.element.removeEventListener('pointerup', this.onUp);
    this.element.removeEventListener('pointercancel', this.onUp);
    this.element.removeEventListener('pointerleave', this.onUp);
    this.pointers.clear();
  }

  private pair(): [Pointer, Pointer] | null {
    const [a, b] = [...this.pointers.values()];
    return a && b ? [a, b] : null;
  }

  private onDown = (ev: PointerEvent): void => {
    this.element.setPointerCapture?.(ev.pointerId);
    this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

    if (this.pointers.size === 1) {
      this.downAt = performance.now();
      this.downPos = { x: ev.clientX, y: ev.clientY };
      this.moved = 0;
    }

    const pair = this.pair();
    if (pair) {
      this.lastDistance = Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y);
      this.lastAngle = Math.atan2(pair[1].y - pair[0].y, pair[1].x - pair[0].x);
    }
  };

  private onMove = (ev: PointerEvent): void => {
    const prev = this.pointers.get(ev.pointerId);
    if (!prev) return;
    const dx = ev.clientX - prev.x;
    const dy = ev.clientY - prev.y;
    prev.x = ev.clientX;
    prev.y = ev.clientY;
    this.moved += Math.hypot(dx, dy);

    if (this.pointers.size === 1) {
      if (this.enabled.move) this.handlers.onPan?.(dx, dy);
      return;
    }

    const pair = this.pair();
    if (!pair) return;

    const distance = Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y);
    if (this.enabled.scale && this.lastDistance > 0 && distance > 0) {
      this.handlers.onPinch?.(distance / this.lastDistance);
    }
    this.lastDistance = distance;

    const angle = Math.atan2(pair[1].y - pair[0].y, pair[1].x - pair[0].x);
    if (this.enabled.rotate) {
      let delta = angle - this.lastAngle;
      if (delta > Math.PI) delta -= 2 * Math.PI;
      if (delta < -Math.PI) delta += 2 * Math.PI;
      this.handlers.onRotate?.(delta);
    }
    this.lastAngle = angle;
  };

  private onUp = (ev: PointerEvent): void => {
    if (!this.pointers.has(ev.pointerId)) return;
    this.pointers.delete(ev.pointerId);
    this.element.releasePointerCapture?.(ev.pointerId);

    const isTap =
      this.pointers.size === 0 &&
      this.moved < TAP_MAX_MOVE_PX &&
      performance.now() - this.downAt < TAP_MAX_MS;
    if (isTap) this.handlers.onTap?.(this.downPos.x, this.downPos.y);

    this.lastDistance = 0;
  };
}
