import { createOverlay, type Overlay } from '../ui/overlay';
import { createStrings, type StringKey } from '../ui/strings';
import { acquire, release } from './AssetLoader';
import { type CapabilityReport, detectCapabilities } from './capabilities';
import { shareOrDownload } from './capture';
import { PassthroughSceneManager } from './engines/PassthroughSceneManager';
import { WebXRSceneManager } from './engines/WebXRSceneManager';
import { ARError, normalizeError, userMessage } from './errors';
import { Emitter } from './events';
import type { BuiltFrame } from './FrameBuilder';
import { buildKit } from './KitBuilder';
import { loadThree, provideThree, type ThreeNS } from './loadThree';
import { resolveContent, resolveOptions, type ViewerContent, validateContent } from './options';
import type { SceneManager, SceneMountContext } from './SceneManager';
import type {
  AREventMap,
  ARHint,
  ARStatus,
  KitData,
  ProductData,
  ResolvedOptions,
  SceneKind,
  ViewerOptions,
} from './types';

/** Anisotropia pedida; o three já clampa pelo máximo do hardware. */
const ANISOTROPY = 8;

export interface ViewerConfig {
  container: HTMLElement;
  /** Um quadro. Mutuamente exclusivo com `kit`. */
  product?: ProductData;
  /** Um conjunto posicionado como bloco único. Mutuamente exclusivo com `product`. */
  kit?: KitData;
  options?: ViewerOptions;
}

export class ARController {
  static create(config: ViewerConfig): ARController {
    return new ARController(config);
  }

  private readonly emitter = new Emitter<AREventMap>();
  private readonly options: ResolvedOptions;
  private readonly t: (key: StringKey) => string;
  private readonly abort = new AbortController();

  private content: ViewerContent;
  private container: HTMLElement;
  private overlay: Overlay | null = null;
  private manager: SceneManager | null = null;
  private three: ThreeNS | null = null;
  private frame: BuiltFrame | null = null;
  private caps: CapabilityReport | null = null;
  /** Uma URL por peça, na ordem das peças. Pode repetir: o refcount aguenta. */
  private loadedUrls: string[] = [];
  private pendingCapture: Promise<Blob | null> | null = null;

  private state: ARStatus = 'idle';
  private starting = false;
  private panelMode: 'error' | 'no-wall' = 'error';

  private constructor(config: ViewerConfig) {
    this.container = config.container;
    this.content = resolveContent(config);
    this.options = resolveOptions(config.options);
    this.t = createStrings(this.options.locale, config.options?.strings);

    if (config.options?.threeUrl) {
      const url = config.options.threeUrl;
      // Os magic comments calam o "Critical dependency" do webpack e o aviso
      // equivalente do Vite: a URL é intencionalmente não-analisável.
      provideThree(
        () => import(/* webpackIgnore: true */ /* @vite-ignore */ url) as Promise<ThreeNS>,
      );
    }

    const wire = <K extends keyof AREventMap>(type: K, fn?: (payload: AREventMap[K]) => void) => {
      if (fn) this.emitter.on(type, fn);
    };
    wire('error', config.options?.onError);
    wire('placed', config.options?.onPlace);
    wire('close', config.options?.onClose ? () => config.options?.onClose?.() : undefined);
    wire('status', (status) => {
      if (status === 'ready') config.options?.onReady?.();
    });

    this.mountOverlay();

    if (this.options.autoStart) {
      // O double-invoke do StrictMode é síncrono dentro do mesmo commit; um
      // macrotask de 0 ms cai depois dele.
      setTimeout(() => void this.start(), 0);
    }
  }

  get status(): ARStatus {
    return this.state;
  }

  get engine(): SceneKind | null {
    return this.manager?.kind ?? null;
  }

  on<K extends keyof AREventMap>(type: K, fn: (payload: AREventMap[K]) => void): () => void {
    return this.emitter.on(type, fn);
  }

  off<K extends keyof AREventMap>(type: K, fn: (payload: AREventMap[K]) => void): void {
    this.emitter.off(type, fn);
  }

  once<K extends keyof AREventMap>(type: K, fn: (payload: AREventMap[K]) => void): () => void {
    return this.emitter.once(type, fn);
  }

  /**
   * Nunca rejeita. A API pública é escrita como `viewer.start()` sem await, e uma
   * unhandled rejection no navegador de um comprador não é aceitável — toda
   * falha vira evento `error` + `onError` + `status: 'error'`.
   */
  async start(): Promise<void> {
    if (this.starting || this.state === 'destroyed') return;
    this.starting = true;
    try {
      await this.startInternal();
    } catch (err) {
      this.fail(err instanceof ARError ? err : normalizeError(err, 'runtime'));
    } finally {
      this.starting = false;
    }
  }

  pause(): void {
    this.manager?.pause();
    if (this.state !== 'destroyed') this.setState('paused');
  }

  async resume(): Promise<void> {
    if (this.state === 'destroyed') return;
    try {
      await this.manager?.resume();
      this.setState('ready');
    } catch (err) {
      this.fail(normalizeError(err, 'camera', { locale: this.options.locale }));
    }
  }

  place(): void {
    this.manager?.place();
  }

  reset(): void {
    this.manager?.reset();
  }

  async capture(): Promise<Blob | null> {
    if (!this.manager?.capabilities.canCapture) return null;
    return this.manager.capture();
  }

  async setProduct(product: ProductData): Promise<void> {
    await this.setContent({ product });
  }

  /** Troca o conjunto exibido. Mesmo contrato de `setProduct`. */
  async setKit(kit: KitData): Promise<void> {
    await this.setContent({ kit });
  }

  private async setContent(source: { product?: ProductData; kit?: KitData }): Promise<void> {
    this.content = resolveContent(source);
    if (!this.manager || !this.three) return;
    await this.loadContent(this.three);
  }

  async destroy(): Promise<void> {
    if (this.state === 'destroyed') return;
    this.setState('destroyed');
    this.abort.abort();

    try {
      await this.manager?.destroy();
    } catch {
      // destroy() nunca rejeita.
    }
    this.manager = null;

    this.frame?.dispose();
    this.frame = null;
    for (const url of this.loadedUrls) release(url);
    this.loadedUrls = [];

    this.overlay?.destroy();
    this.overlay = null;
    this.emitter.clear();
  }

  // --- interno ------------------------------------------------------------

  private mountOverlay(): void {
    if (typeof document === 'undefined') return;
    this.overlay = createOverlay(this.container, this.t, {
      onStart: () => void this.start(),
      onClose: () => {
        this.emitter.emit('close', undefined);
        void this.destroy();
      },
      onPhotoPrepare: () => {
        this.pendingCapture = this.capture();
      },
      onPhoto: () => void this.finishCapture(),
      onPrimaryAction: () => this.onPrimaryAction(),
      onSecondaryAction: () => this.dismissPanel(),
    });
    this.overlay.setTitle(this.content.title);
    this.overlay.setState('idle');
  }

  private setState(state: ARStatus): void {
    this.state = state;
    this.emitter.emit('status', state);
    if (!this.overlay) return;
    const visual =
      state === 'destroyed' || state === 'paused'
        ? 'idle'
        : (state as 'idle' | 'loading' | 'ready' | 'placing' | 'placed' | 'error');
    this.overlay.setState(visual);
  }

  private fail(error: ARError): void {
    this.panelMode = 'error';
    this.state = 'error';
    this.emitter.emit('status', 'error');
    this.emitter.emit('error', error);
    this.overlay?.setState('error');
    this.overlay?.showPanel(
      '',
      error.userMessage,
      error.recoverable ? [{ label: this.t('retry'), kind: 'primary' }] : [],
    );
  }

  private async startInternal(): Promise<void> {
    this.setState('loading');

    this.caps = await detectCapabilities();
    if (this.abort.signal.aborted) return;

    const invalid = validateContent(this.content);
    if (invalid) throw new ARError('INVALID_PRODUCT', invalid, { locale: this.options.locale });

    if (this.caps.inAppBrowser) {
      throw new ARError('IN_APP_BROWSER', undefined, { locale: this.options.locale });
    }
    const kind = this.options.engine ?? this.caps.recommended;
    if (!kind) {
      throw new ARError(this.caps.reason ?? 'NO_AR_SUPPORT', undefined, {
        locale: this.options.locale,
      });
    }

    try {
      this.three = await loadThree();
    } catch (err) {
      throw normalizeError(err, 'engine', { locale: this.options.locale });
    }
    if (this.abort.signal.aborted) return;

    await this.startEngine(kind, this.three);
  }

  private async startEngine(kind: SceneKind, three: ThreeNS): Promise<void> {
    const manager: SceneManager =
      kind === 'webxr' ? new WebXRSceneManager() : new PassthroughSceneManager();

    const ctx: SceneMountContext = {
      container: this.overlay?.root ?? this.container,
      overlay: this.overlay?.root ?? this.container,
      three,
      signal: this.abort.signal,
      options: this.options,
      emit: (type, payload) => this.onSceneEvent(type, payload),
    };

    await manager.mount(ctx);
    if (this.abort.signal.aborted) {
      await manager.destroy();
      return;
    }

    this.manager = manager;
    this.overlay?.setEngine(kind);
    this.overlay?.setCanCapture(manager.capabilities.canCapture);
    this.emitter.emit('engine', kind);

    await this.loadContent(three);
    if (this.abort.signal.aborted) return;

    try {
      await manager.start();
    } catch (err) {
      const error = err instanceof ARError ? err : normalizeError(err, 'xr');
      // Falha de sessão XR cai silenciosamente no passthrough. Só o pedido de
      // gesto do usuário volta como estado 'idle' com o botão de iniciar.
      if (kind === 'webxr' && error.code === 'XR_SESSION_FAILED' && this.caps?.getUserMedia) {
        await manager.destroy();
        this.manager = null;
        await this.startEngine('passthrough', three);
        return;
      }
      if (error.code === 'XR_GESTURE_REQUIRED') {
        await manager.destroy();
        this.manager = null;
        this.setState('idle');
        return;
      }
      throw error;
    }

    if (this.abort.signal.aborted) return;
    this.setState(this.options.autoPlaceOnPlane ? 'placing' : 'ready');
  }

  private async loadContent(three: ThreeNS): Promise<void> {
    const previousUrls = this.loadedUrls;
    const previousFrame = this.frame;

    const { items } = this.content;
    const urls = items.map((item) => item.imageUrl);

    // `acquire` incrementa o refcount de forma SÍNCRONA, então as URLs já estão
    // retidas antes do primeiro await — é o que faz o `release` do caminho de
    // aborto parear certo. Uma peça que falha derruba o conjunto: um kit com um
    // buraco no meio mente sobre o produto.
    const pending = items.map((item) =>
      acquire(three, item.imageUrl, ANISOTROPY).then((art) => ({ item, art })),
    );
    // `Promise.all` rejeita na primeira falha e as irmãs virariam unhandled
    // rejections no navegador de um comprador. Anexar o handler agora não
    // interfere no `all`, que continua observando as promises originais.
    for (const p of pending) p.catch(() => undefined);

    let parts: Awaited<(typeof pending)[number]>[];
    try {
      parts = await Promise.all(pending);
    } catch (err) {
      // Soltar tudo: quem carregou com sucesso ficou retido pelo acquire síncrono.
      for (const url of urls) release(url);
      throw normalizeError(err, 'asset', { locale: this.options.locale });
    }
    if (this.abort.signal.aborted) {
      for (const url of urls) release(url);
      return;
    }

    this.loadedUrls = urls;
    // Sempre `buildKit`, inclusive para um produto solto: um caminho de código
    // só vale mais do que o `Group` a mais que o caso de uma peça carrega. As
    // métricas de um kit de um são as do próprio quadro, sem diferença nenhuma.
    this.frame = buildKit(three, parts, this.options.frame);
    this.manager?.setContent(this.frame);
    this.overlay?.setTitle(this.content.title);

    // Só depois de o novo conteúdo estar montado — inverter faria a troca piscar.
    previousFrame?.dispose();
    for (const url of previousUrls) release(url);
  }

  private onSceneEvent(type: string, payload: unknown): void {
    switch (type) {
      case 'hint':
        this.onHint(payload as ARHint);
        break;
      case 'placed':
        this.setState('placed');
        this.emitter.emit('placed', payload as AREventMap['placed']);
        break;
      case 'unplaced':
        this.setState('placing');
        this.emitter.emit('unplaced', undefined);
        break;
      case 'sessionend':
        if ((payload as { reason: string }).reason === 'user') {
          this.emitter.emit('close', undefined);
          void this.destroy();
        } else {
          this.fail(new ARError('SESSION_LOST', undefined, { locale: this.options.locale }));
        }
        break;
      case 'error':
        this.fail(payload as ARError);
        break;
      default:
        break;
    }
  }

  private onHint(hint: ARHint): void {
    this.overlay?.setHint(this.t(`hint.${hint}` as StringKey));
    if (hint !== 'no-wall-found') return;

    // Parede branca e lisa não gera plano. A saída manual é caminho principal
    // alternativo, não um extra.
    this.panelMode = 'no-wall';
    this.overlay?.setState('error');
    this.overlay?.showPanel('', this.t('hint.no-wall-found'), [
      { label: this.t('manual'), kind: 'primary' },
      { label: this.t('keepTrying'), kind: 'secondary' },
    ]);
  }

  private onPrimaryAction(): void {
    if (this.panelMode === 'no-wall') {
      this.manager?.enableManualPlacement?.();
      this.dismissPanel();
      return;
    }
    void this.start();
  }

  private dismissPanel(): void {
    this.setState(this.manager ? 'placing' : 'idle');
  }

  private async finishCapture(): Promise<void> {
    const pending = this.pendingCapture ?? this.capture();
    this.pendingCapture = null;
    const blob = await pending;
    if (!blob) return;
    const prefix = this.content.isKit ? 'kit' : 'quadro';
    await shareOrDownload(blob, `${prefix}-${this.content.id || 'ar'}.jpg`);
  }
}

export const FrameViewer = {
  create: (config: ViewerConfig): ARController => ARController.create(config),
  /** Permite à página de produto esconder o botão sem construir um controller. */
  isSupported: (): Promise<CapabilityReport> => detectCapabilities(),
  provideThree,
  userMessage,
};
