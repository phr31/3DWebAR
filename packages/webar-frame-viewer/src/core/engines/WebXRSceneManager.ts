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
import { isWallNormal, readHitPose, wallBasis } from '../TransformUtils';

/** Frames válidos consecutivos antes de aceitar um alvo. Sem isso o reticle pisca. */
const STABLE_FRAMES = 5;
/** Milissegundos sem hit antes de esconder o reticle. */
const HIT_GRACE_MS = 200;
/** Além de ~5 m o ARCore está chutando. */
const MIN_HIT_M = 0.4;
const MAX_HIT_M = 6;
/** Folga da parede, evita a peça entrar nela quando a estimativa do plano erra. */
const WALL_GAP = 0.005;

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

  private session: XRSession | null = null;
  private viewerSpace: XRReferenceSpace | null = null;
  private hitTestSource: XRHitTestSource | null = null;
  private lightProbe: LightProbe | null = null;
  private anchor: XRAnchor | null = null;

  private frame: BuiltFrame | null = null;
  private reticle: THREE.Group | null = null;
  private reticleLine: THREE.LineBasicMaterial | null = null;
  private reticleDisposables: Array<THREE.BufferGeometry | THREE.Material> = [];

  private stableCount = 0;
  private lastHitAt = 0;
  private startedAt = 0;
  private hasCandidate = false;
  private placed = false;
  private manualMode = false;
  private noWallNotified = false;
  private endingIntentionally = false;
  private destroyed = false;

  private candidatePosition!: THREE.Vector3;
  private candidateQuaternion!: THREE.Quaternion;

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
    this.candidatePosition = new this.three.Vector3();
    this.candidateQuaternion = new this.three.Quaternion();

    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    // Sem isto, tocar num botão do overlay também dispara `select` na sessão e o
    // quadro se reposiciona junto com o clique em "Foto".
    ctx.overlay.addEventListener('beforexrselect', this.onBeforeSelect);
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
      distanceMeters: this.candidatePosition.distanceTo(camera.position),
      source: this.manualMode ? 'manual' : 'hit-test',
      position: {
        x: this.candidatePosition.x,
        y: this.candidatePosition.y,
        z: this.candidatePosition.z,
      },
    });
    this.ctx.emit('hint', 'placed');
  }

  reset(): void {
    this.placed = false;
    this.anchor = null;
    this.stableCount = 0;
    this.hasCandidate = false;
    this.noWallNotified = false;
    this.startedAt = performance.now();
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
    this.ctx.overlay.removeEventListener('beforexrselect', this.onBeforeSelect);

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
    const lineMat = new this.three.LineBasicMaterial({ color: 0xf59e0b, depthTest: false });
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
            x: this.candidatePosition.x,
            y: this.candidatePosition.y,
            z: this.candidatePosition.z,
          },
          {
            x: this.candidateQuaternion.x,
            y: this.candidateQuaternion.y,
            z: this.candidateQuaternion.z,
            w: this.candidateQuaternion.w,
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
    const luminance = 0.2126 * intensity.x + 0.7152 * intensity.y + 0.0722 * intensity.z;
    this.frame.setAmbient(0.55 + Math.min(1, luminance / 3) * 0.45);
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
    const forward = new this.three.Vector3();
    camera.getWorldDirection(forward);

    // Normal apontando de volta para o usuário, forçada em prumo (só yaw).
    const quaternion = wallBasis(this.three, -forward.x, 0, -forward.z);
    if (quaternion) this.candidateQuaternion.copy(quaternion);

    this.candidatePosition
      .copy(camera.position)
      .addScaledVector(forward, this.ctx.options.assumedWallDistanceM);
    this.candidatePosition.y = camera.position.y;

    this.hasCandidate = true;
    this.frame.group.visible = true;
    this.frame.group.position.copy(this.candidatePosition);
    this.frame.group.quaternion.copy(this.candidateQuaternion);
    if (this.reticle) this.reticle.visible = false;
  }

  private updateFromHitTest(xrFrame: XRFrame, space: XRReferenceSpace, now: number): void {
    if (!this.hitTestSource || !this.frame) return;

    const results = xrFrame.getHitTestResults(this.hitTestSource);
    const camera = this.renderer.xr.getCamera();
    let accepted = false;

    for (const hit of results) {
      const pose = hit.getPose(space);
      if (!pose) continue;

      const { normal, position } = readHitPose(pose.transform.matrix);
      if (!isWallNormal(normal[1], this.ctx.options.wallToleranceDeg)) continue;

      const point = new this.three.Vector3(position[0], position[1], position[2]);
      const distance = point.distanceTo(camera.position);
      if (distance < MIN_HIT_M || distance > MAX_HIT_M) continue;

      const quaternion = wallBasis(this.three, normal[0], normal[1], normal[2]);
      if (!quaternion) continue;

      point.addScaledVector(
        new this.three.Vector3(normal[0], normal[1], normal[2]).normalize(),
        WALL_GAP,
      );

      if (this.stableCount === 0) {
        this.candidatePosition.copy(point);
        this.candidateQuaternion.copy(quaternion);
      } else {
        // Poses de hit-test tremem. A maior fonte de instabilidade percebida é a
        // rotação — a wallBasis já a elimina; o lerp cuida do resto.
        this.candidatePosition.lerp(point, 0.25);
        this.candidateQuaternion.slerp(quaternion, 0.25);
      }

      this.stableCount++;
      this.lastHitAt = now;
      accepted = true;
      break;
    }

    if (!accepted) {
      const stale = now - this.lastHitAt > HIT_GRACE_MS;
      if (stale) {
        this.stableCount = 0;
        this.hasCandidate = false;
        if (this.reticle) this.reticle.visible = false;
        if (!this.ctx.options.autoPlaceOnPlane) this.frame.group.visible = false;
        if (results.length > 0) this.ctx.emit('hint', 'aim-wall');
      }

      // Parede branca e lisa não gera feature points, logo não gera plano. Este
      // é o caso mais comum do produto, não um caso de borda.
      if (
        !this.noWallNotified &&
        !this.manualMode &&
        now - this.startedAt > this.ctx.options.noHitTimeoutMs
      ) {
        this.noWallNotified = true;
        this.ctx.emit('hint', 'no-wall-found');
      } else if (!this.noWallNotified && now - this.startedAt > 3000) {
        this.ctx.emit('hint', 'move-slower');
      }
      return;
    }

    if (this.stableCount < STABLE_FRAMES) return;

    this.hasCandidate = true;
    if (this.reticleLine) this.reticleLine.color.setHex(0x22c55e);

    if (this.ctx.options.autoPlaceOnPlane) {
      if (this.reticle) this.reticle.visible = false;
      this.frame.group.visible = true;
      this.frame.group.position.copy(this.candidatePosition);
      this.frame.group.quaternion.copy(this.candidateQuaternion);
    } else if (this.reticle) {
      this.reticle.visible = true;
      this.reticle.position.copy(this.candidatePosition);
      this.reticle.quaternion.copy(this.candidateQuaternion);
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
