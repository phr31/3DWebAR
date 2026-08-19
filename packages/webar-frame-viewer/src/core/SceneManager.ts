import type * as THREE from 'three';
import type { ARError } from './errors';
import type { BuiltFrame } from './FrameBuilder';
import type { ThreeNS } from './loadThree';
import type { ARHint, PlacementInfo, ResolvedOptions, SceneKind } from './types';

export interface SceneCapabilities {
  /** 6DoF: o quadro fica na parede quando o usuário anda? */
  worldTracked: boolean;
  hitTest: boolean;
  /** `capture()` consegue devolver um Blob. Falso no WebXR — ver capture.ts. */
  canCapture: boolean;
  usesDomOverlay: boolean;
  gestures: { move: boolean; distance: boolean; roll: boolean };
}

export type SceneEventMap = {
  hint: ARHint;
  placed: PlacementInfo;
  unplaced: undefined;
  sessionend: { reason: 'user' | 'lost' | 'error' };
  error: ARError;
};

export interface SceneMountContext {
  container: HTMLElement;
  /** Overlay já montado no DOM pelo controller. Usado como `domOverlay` no WebXR. */
  overlay: HTMLElement;
  three: ThreeNS;
  /** Abortado por `destroy()`. Reverifique após cada `await`. */
  signal: AbortSignal;
  options: ResolvedOptions;
  emit: <K extends keyof SceneEventMap>(type: K, payload: SceneEventMap[K]) => void;
}

/**
 * O SceneManager é dono do próprio relógio. Não existe `render()`, `tick()` nem
 * `onFrame()` nesta interface, e o ARController nunca causa um frame — é isso
 * que impede a diferença entre `XRSession.requestAnimationFrame` e
 * `window.requestAnimationFrame` de vazar para fora do engine.
 *
 * Acidente feliz: `WebGLRenderer.setAnimationLoop` já despacha para a sessão XR
 * quando `xr.isPresenting` e para o window caso contrário, então os dois engines
 * usam exatamente a mesma chamada.
 */
export interface SceneManager {
  readonly kind: SceneKind;
  readonly capabilities: SceneCapabilities;

  /** Renderer, cena e câmera. Sem loop, sem câmera de vídeo, sem sessão. */
  mount(ctx: SceneMountContext): Promise<void>;
  /** Substitui o conteúdo. As texturas já chegam decodificadas. */
  setContent(frame: BuiltFrame): void;
  /** Adquire câmera ou sessão XR e liga o loop. */
  start(): Promise<void>;
  pause(): void;
  resume(): Promise<void>;
  /** Fixa a pose candidata atual. */
  place(): void;
  /** Volta ao estado de posicionamento. */
  reset(): void;
  capture(): Promise<Blob | null>;
  destroy(): Promise<void>;
  /**
   * Saída para quando a detecção de plano falha (parede branca e lisa é o caso
   * mais comum do produto, não um caso de borda). Só o engine WebXR implementa.
   */
  enableManualPlacement?(): void;
}

export function createRenderer(three: ThreeNS, canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  const renderer = new three.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: 'high-performance',
    // `preserveDrawingBuffer` custa 5–15% de GPU móvel para um recurso usado uma
    // vez por sessão. A captura lê o canvas dentro do mesmo rAF do render.
    preserveDrawingBuffer: false,
  });
  renderer.setClearColor(0x000000, 0);
  // ACESFilmic deslocaria as cores da impressão. Inaceitável para catálogo.
  renderer.toneMapping = three.NoToneMapping;
  renderer.outputColorSpace = three.SRGBColorSpace;
  return renderer;
}

/**
 * Aparelho com pouca folga para renderizar.
 *
 * Heurística grosseira de propósito: não existe sinal confiável de GPU no
 * navegador, e `deviceMemory`/`hardwareConcurrency` são o que há. Serve às três
 * decisões de qualidade do pacote — teto de pixel ratio, MSAA e escala do
 * framebuffer XR — e é uma só para que elas não divirjam.
 *
 * Toca `navigator`, portanto só pode ser chamada em runtime de navegador.
 */
export function isLowEndDevice(): boolean {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return (nav.deviceMemory ?? 8) <= 3 || (navigator.hardwareConcurrency ?? 8) <= 4;
}

/** Num aparelho com dpr 3, renderizar 5 quads a 3× é desperdício puro. */
export function pixelRatioCap(): number {
  return isLowEndDevice() ? 1.5 : 2;
}
