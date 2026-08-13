import type * as THREE from 'three';
import { normalizeError } from '../errors';
import type { BuiltFrame } from '../FrameBuilder';
import type { ThreeNS } from '../loadThree';
import {
  createRenderer,
  type SceneCapabilities,
  type SceneManager,
  type SceneMountContext,
} from '../SceneManager';
import {
  ambientFromLightEstimate,
  HitTestTracker,
  manualCandidate,
  progressHint,
  RETICLE_STABLE,
  RETICLE_UNSTABLE,
} from '../xr/hitTest';

interface XRSessionInit_ {
  requiredFeatures?: string[];
  optionalFeatures?: string[];
  domOverlay?: { root: Element };
}

// `light-estimation` ainda não está em @types/webxr. Só o mínimo que usamos.
interface LightProbe {
  readonly probeSpace: XRSpace;
}
interface LightEstimate {
  readonly primaryLightIntensity?: DOMPointReadOnly;
}
type SessionWithProbe = XRSession & { requestLightProbe?: () => Promise<LightProbe> };
type FrameWithEstimate = XRFrame & {
  getLightEstimate?: (probe: LightProbe) => LightEstimate | null;
};

/**
 * Engine premium: sessão `immersive-ar` com hit-test em parede. Chrome/Android
 * via ARCore. Escala física real e tracking 6-DoF.
 */
export class WebXRSceneManager implements SceneManager {
  readonly kind = 'webxr' as const;
  readonly capabilities: SceneCapabilities = {
    worldTracked: true,
    hitTest: true,
    // Dentro de uma XRSession o render vai para o framebuffer do compositor, e a
    // imagem da câmera nunca esteve no nosso framebuffer. Não há o que capturar.
    canCapture: false,
    usesDomOverlay: true,
    gestures: { move: false, distance: false, roll: false },
  };

  private ctx!: SceneMountContext;
  private three!: ThreeNS;
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private canvas!: HTMLCanvasElement;
  /** Onde o `beforexrselect` é bloqueado. Ver o comentário em `mount`. */
  private selectGuard!: HTMLElement;

  private session: XRSession | null = null;
  private viewerSpace: XRReferenceSpace | null = null;
  private hitTestSource: XRHitTestSource | null = null;
  private lightProbe: LightProbe | null = null;
  private anchor: XRAnchor | null = null;

  private frame: BuiltFrame | null = null;
  private reticle: THREE.Group | null = null;
  private reticleLine: THREE.LineBasicMaterial | null = null;
  private reticleDisposables: Array<THREE.BufferGeometry | THREE.Material> = [];

  private startedAt = 0;
  private hasCandidate = false;
  private placed = false;
  private manualMode = false;
  private noWallNotified = false;
  private endingIntentionally = false;
  private destroyed = false;

  /** Filtro de parede + histerese. Dono do candidato (posição e orientação). */
  private tracker!: HitTestTracker;

  async mount(ctx: SceneMountContext): Promise<void> {
    this.ctx = ctx;
    this.three = ctx.three;
    this.canvas = ctx.container.querySelector('.fv-canvas') as HTMLCanvasElement;

    this.renderer = createRenderer(this.three, this.canvas);
    this.renderer.xr.enabled = true;
    // Conhecer o chão permite o snap de altura de museu (1,45 m).
    this.renderer.xr.setReferenceSpaceType('local-floor');

    this.scene = new this.three.Scene();
    this.camera = new this.three.PerspectiveCamera(60, 1, 0.05, 100);
    this.tracker = new HitTestTracker(this.three);

    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    // Sem isto, tocar num botão do overlay também dispara `select` na sessão e o
    // quadro se reposiciona junto com o clique em "Foto".
    //
    // O alvo é `.fv-ui`, não a raiz: a raiz É o `domOverlay` e cobre a tela
    // inteira, então cancelar ali engoliria o `select` de QUALQUER toque — e o
    // "toque para fixar" nunca dispararia. `.fv-ui` é `pointer-events: none` e só
    // os controles são `auto`, então o evento só sobe por ela em toque de botão.
    this.selectGuard = ctx.overlay.querySelector<HTMLElement>('.fv-ui') ?? ctx.overlay;
    this.selectGuard.addEventListener('beforexrselect', this.onBeforeSelect);
  }

  setContent(frame: BuiltFrame): void {
    if (this.frame) this.scene.remove(this.frame.group);
    this.frame = frame;
    frame.group.visible = false;
    this.scene.add(frame.group);
    this.buildReticle(frame.metrics.outer.w, frame.metrics.outer.h);
  }

  async start(): Promise<void> {
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
    if (!xr) throw normalizeError(new Error('navigator.xr indisponível'), 'xr');

    const init: XRSessionInit_ = {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['local-floor', 'dom-overlay', 'anchors', 'light-estimation'],
      domOverlay: { root: this.ctx.overlay },
    };

    let session: XRSession;
    try {
      session = await xr.requestSession('immersive-ar', init as XRSessionInit);
    } catch (err) {
      throw normalizeError(err, 'xr', { locale: this.ctx.options.locale });
    }
    if (this.destroyed) {
      await session.end().catch(() => undefined);
      return;
    }

    this.session = session;
    session.addEventListener('end', this.onSessionEnd);
    session.addEventListener('select', this.onSelect);

    await this.renderer.xr.setSession(session);
    this.viewerSpace = await session.requestReferenceSpace('viewer');

    try {
      // `entityTypes` evita hits em feature points soltos, cuja orientação é
      // lixo — mas o suporte do Chrome é irregular, daí o fallback.
      this.hitTestSource =
        (await session.requestHitTestSource?.({
          space: this.viewerSpace,
          entityTypes: ['plane'],
        } as XRHitTestOptionsInit)) ?? null;
    } catch {
      this.hitTestSource =
        (await session.requestHitTestSource?.({ space: this.viewerSpace })) ?? null;
    }

    try {
      this.lightProbe = (await (session as SessionWithProbe).requestLightProbe?.()) ?? null;
    } catch {
      this.lightProbe = null;
    }

    this.startedAt = performance.now();
    this.renderer.setAnimationLoop(this.tick);
    this.ctx.emit('hint', 'scan');
  }

  pause(): void {
    this.renderer.setAnimationLoop(null);
  }

  async resume(): Promise<void> {
    if (this.destroyed) return;
    if (this.session) this.renderer.setAnimationLoop(this.tick);
    else await this.start();
  }

  place(): void {
    if (!this.frame || !this.hasCandidate) return;
    this.placed = true;
    this.frame.setOpacity(1);
    if (this.reticle) this.reticle.visible = false;

    // Anchors reduzem materialmente o drift depois de 30 s parado — e o usuário
    // fica bastante tempo olhando para o quadro.
    void this.tryCreateAnchor();

    const camera = this.renderer.xr.getCamera();
    this.ctx.emit('placed', {
      distanceMeters: this.tracker.distanceTo(camera.position),
      source: this.manualMode ? 'manual' : 'hit-test',
      position: {
        x: this.tracker.position.x,
        y: this.tracker.position.y,
        z: this.tracker.position.z,
      },
    });
    this.ctx.emit('hint', 'placed');
  }

  reset(): void {
    this.placed = false;
    this.anchor = null;
    this.tracker.reset();
    this.hasCandidate = false;
    this.noWallNotified = false;
    this.startedAt = performance.now();
    if (this.reticleLine) this.reticleLine.color.setHex(RETICLE_UNSTABLE);
    this.frame?.setOpacity(this.ctx.options.autoPlaceOnPlane ? 0.85 : 1);
    if (this.frame) this.frame.group.visible = false;
    this.ctx.emit('unplaced', undefined);
    this.ctx.emit('hint', 'scan');
  }

  /**
   * Mesmo sem plano detectado o tracking 6-DoF continua funcionando: colocamos a
   * peça a uma distância fixa à frente, em prumo, e ao confirmar a transform
   * congela no mundo. O quadro ganha paralaxe correta ao andar — continua sendo
   * AR de verdade, só sem saber onde a parede está.
   */
  enableManualPlacement(): void {
    this.manualMode = true;
    this.ctx.emit('hint', 'tap-to-place');
  }

  async capture(): Promise<Blob | null> {
    return null;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.endingIntentionally = true;
    this.renderer.setAnimationLoop(null);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.selectGuard?.removeEventListener('beforexrselect', this.onBeforeSelect);

    this.hitTestSource?.cancel();
    this.hitTestSource = null;

    if (this.session) {
      this.session.removeEventListener('end', this.onSessionEnd);
      this.session.removeEventListener('select', this.onSelect);
      await this.session.end().catch(() => undefined);
      this.session = null;
    }

    this.disposeReticle();
    if (this.frame) {
      this.scene.remove(this.frame.group);
      this.frame = null;
    }
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  // --- interno ------------------------------------------------------------

  /**
   * O reticle é o CONTORNO REAL do produto, não o anel do sample oficial. O
   * usuário vê na hora se 50×70 cabe entre a porta e a estante — é a melhor
   * decisão de UX do fluxo e sai praticamente de graça.
   */
  private buildReticle(w: number, h: number): void {
    this.disposeReticle();
    const group = new this.three.Group();

    const fillGeo = new this.three.PlaneGeometry(w, h);
    const fillMat = new this.three.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.12,
      depthTest: false,
    });
    const fill = new this.three.Mesh(fillGeo, fillMat);
    fill.renderOrder = 999;

    const points = [
      new this.three.Vector3(-w / 2, -h / 2, 0),
      new this.three.Vector3(w / 2, -h / 2, 0),
      new this.three.Vector3(w / 2, h / 2, 0),
      new this.three.Vector3(-w / 2, h / 2, 0),
    ];
    const lineGeo = new this.three.BufferGeometry().setFromPoints(points);
    const lineMat = new this.three.LineBasicMaterial({
      color: RETICLE_UNSTABLE,
      depthTest: false,
    });
    const line = new this.three.LineLoop(lineGeo, lineMat);
    line.renderOrder = 1000;

    group.add(fill, line);
    group.visible = false;
    this.scene.add(group);

    this.reticle = group;
    this.reticleLine = lineMat;
    this.reticleDisposables = [fillGeo, fillMat, lineGeo, lineMat];
  }

  private disposeReticle(): void {
    if (this.reticle) this.scene.remove(this.reticle);
    for (const item of this.reticleDisposables) item.dispose();
    this.reticleDisposables = [];
    this.reticle = null;
    this.reticleLine = null;
  }

  private async tryCreateAnchor(): Promise<void> {
    const session = this.session;
    if (!session) return;
    try {
      const space = this.renderer.xr.getReferenceSpace();
      const create = (
        session as XRSession & {
          // Só existe quando a feature 'anchors' foi concedida.
          requestAnimationFrame: XRSession['requestAnimationFrame'];
        }
      ).requestAnimationFrame;
      if (!create || !space) return;
      session.requestAnimationFrame((_time, xrFrame) => {
        const rigid = new XRRigidTransform(
          {
            x: this.tracker.position.x,
            y: this.tracker.position.y,
            z: this.tracker.position.z,
          },
          {
            x: this.tracker.quaternion.x,
            y: this.tracker.quaternion.y,
            z: this.tracker.quaternion.z,
            w: this.tracker.quaternion.w,
          },
        );
        (
          xrFrame as XRFrame & {
            createAnchor?: (t: XRRigidTransform, s: XRSpace) => Promise<XRAnchor>;
          }
        )
          .createAnchor?.(rigid, space)
          ?.then((anchor) => {
            if (!this.destroyed) this.anchor = anchor;
          })
          .catch(() => undefined);
      });
    } catch {
      // Feature não concedida. Segue sem anchor.
    }
  }

  private applyLightEstimate(xrFrame: XRFrame): void {
    if (!this.lightProbe || !this.frame) return;
    const estimate = (xrFrame as FrameWithEstimate).getLightEstimate?.(this.lightProbe);
    const intensity = estimate?.primaryLightIntensity;
    if (!intensity) return;
    this.frame.setAmbient(ambientFromLightEstimate(intensity.x, intensity.y, intensity.z));
  }

  private updateFromAnchor(xrFrame: XRFrame, space: XRReferenceSpace): boolean {
    if (!this.anchor || !this.frame) return false;
    const pose = xrFrame.getPose(this.anchor.anchorSpace, space);
    if (!pose) return false;
    const { position, orientation } = pose.transform;
    this.frame.group.position.set(position.x, position.y, position.z);
    this.frame.group.quaternion.set(orientation.x, orientation.y, orientation.z, orientation.w);
    return true;
  }

  private updateManual(): void {
    if (!this.frame) return;
    const camera = this.renderer.xr.getCamera();
    manualCandidate(
      this.three,
      camera,
      this.ctx.options.assumedWallDistanceM,
      this.tracker.position,
      this.tracker.quaternion,
    );

    this.hasCandidate = true;
    this.frame.group.visible = true;
    this.frame.group.position.copy(this.tracker.position);
    this.frame.group.quaternion.copy(this.tracker.quaternion);
    if (this.reticle) this.reticle.visible = false;
  }

  private updateFromHitTest(xrFrame: XRFrame, space: XRReferenceSpace, now: number): void {
    if (!this.hitTestSource || !this.frame) return;

    const results = xrFrame.getHitTestResults(this.hitTestSource);
    const camera = this.renderer.xr.getCamera();

    const matrices: Float32Array[] = [];
    for (const hit of results) {
      const pose = hit.getPose(space);
      if (pose) matrices.push(pose.transform.matrix);
    }

    const outcome = this.tracker.evaluate(
      matrices,
      results.length,
      camera.position,
      this.ctx.options.wallToleranceDeg,
      now,
    );

    // A escalada de dicas roda em TODO frame sem hit aceito, inclusive durante a
    // carência — só a limpeza visual espera a carência expirar.
    if (outcome.kind === 'lost' || outcome.kind === 'grace') {
      if (outcome.kind === 'lost') {
        this.hasCandidate = false;
        if (this.reticle) this.reticle.visible = false;
        if (!this.ctx.options.autoPlaceOnPlane) this.frame.group.visible = false;
        if (outcome.sawHits) this.ctx.emit('hint', 'aim-wall');
      }

      const hint = progressHint(
        now - this.startedAt,
        this.ctx.options.noHitTimeoutMs,
        this.noWallNotified,
        this.manualMode,
      );
      if (hint === 'no-wall-found') this.noWallNotified = true;
      if (hint) this.ctx.emit('hint', hint);
      return;
    }

    if (outcome.kind === 'settling') return;

    this.hasCandidate = true;
    if (this.reticleLine) this.reticleLine.color.setHex(RETICLE_STABLE);

    if (this.ctx.options.autoPlaceOnPlane) {
      if (this.reticle) this.reticle.visible = false;
      this.frame.group.visible = true;
      this.frame.group.position.copy(this.tracker.position);
      this.frame.group.quaternion.copy(this.tracker.quaternion);
    } else if (this.reticle) {
      this.reticle.visible = true;
      this.reticle.position.copy(this.tracker.position);
      this.reticle.quaternion.copy(this.tracker.quaternion);
    }
    this.ctx.emit('hint', 'tap-to-place');
  }

  private tick = (_time: number, xrFrame?: XRFrame): void => {
    if (this.destroyed || !this.frame) return;
    const space = this.renderer.xr.getReferenceSpace();

    if (xrFrame && space) {
      this.applyLightEstimate(xrFrame);

      if (this.placed) {
        this.updateFromAnchor(xrFrame, space);
      } else if (this.manualMode) {
        this.updateManual();
      } else {
        this.updateFromHitTest(xrFrame, space, performance.now());
      }
    }

    this.renderer.render(this.scene, this.camera);
  };

  private onSelect = (): void => {
    if (this.placed) this.reset();
    else if (this.hasCandidate) this.place();
  };

  private onBeforeSelect = (ev: Event): void => {
    ev.preventDefault();
  };

  private onSessionEnd = (): void => {
    this.session = null;
    this.hitTestSource = null;
    this.renderer.setAnimationLoop(null);
    this.ctx.emit('sessionend', { reason: this.endingIntentionally ? 'user' : 'lost' });
  };

  private onContextLost = (ev: Event): void => {
    ev.preventDefault();
    this.ctx.emit('error', normalizeError(ev, 'runtime', { locale: this.ctx.options.locale }));
  };
}
