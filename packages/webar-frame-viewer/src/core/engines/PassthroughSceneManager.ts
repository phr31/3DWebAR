import type * as THREE from 'three';
import { composeCapture } from '../capture';
import { normalizeError } from '../errors';
import type { BuiltFrame } from '../FrameBuilder';
import { GestureController } from '../GestureController';
import type { ThreeNS } from '../loadThree';
import {
  createRenderer,
  pixelRatioCap,
  type SceneCapabilities,
  type SceneManager,
  type SceneMountContext,
} from '../SceneManager';
import { clamp, degToRad, radToDeg, wallBasis, worldPerPixel } from '../TransformUtils';

const MIN_DISTANCE_M = 0.6;
const MAX_DISTANCE_M = 6;

async function openCamera(): Promise<MediaStream> {
  const constraints: MediaStreamConstraints = {
    // `ideal`, nunca `exact: 'environment'` — em alguns aparelhos `exact` falha de vez.
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
    audio: false,
  };

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    if (err instanceof Error && err.name === 'OverconstrainedError') {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    } else {
      throw err;
    }
  }

  // iOS 17+ pode entregar a ultra-wide com facingMode 'environment', o que
  // destrói a hipótese de FOV e deixa a peça ~2× menor. Os labels só ficam
  // disponíveis depois da permissão concedida.
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === 'videoinput' && d.label);
    const preferred = cams.find(
      (d) => /back|rear|traseira/i.test(d.label) && !/ultra|telephoto|tele/i.test(d.label),
    );
    const current = stream.getVideoTracks()[0]?.getSettings().deviceId;
    if (preferred?.deviceId && preferred.deviceId !== current) {
      for (const track of stream.getTracks()) track.stop();
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: preferred.deviceId },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
    }
  } catch {
    // Mantém o stream original — preferir a lente certa é otimização, não requisito.
  }

  return stream;
}

/** Conversão canônica de DeviceOrientationEvent para quaternion de câmera. */
function orientationQuaternion(
  three: ThreeNS,
  target: THREE.Quaternion,
  alpha: number,
  beta: number,
  gamma: number,
  screenAngle: number,
): void {
  const euler = new three.Euler(beta, alpha, -gamma, 'YXZ');
  target.setFromEuler(euler);
  // -PI/2 em torno de X: o dispositivo olha para -Z quando deitado.
  target.multiply(new three.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2));
  target.multiply(
    new three.Quaternion().setFromAxisAngle(new three.Vector3(0, 0, 1), -screenAngle),
  );
}

/**
 * Engine universal: feed da câmera como fundo, Three.js por cima, gestos para
 * posicionar. Roda em iPhone (que não tem WebXR) e em qualquer Android sem
 * ARCore. Tracking 3-DoF pelo giroscópio — sem paralaxe ao andar.
 */
export class PassthroughSceneManager implements SceneManager {
  readonly kind = 'passthrough' as const;
  readonly capabilities: SceneCapabilities = {
    worldTracked: false,
    hitTest: false,
    canCapture: true,
    usesDomOverlay: false,
    gestures: { move: true, distance: true, roll: true },
  };

  private ctx!: SceneMountContext;
  private three!: ThreeNS;
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private canvas!: HTMLCanvasElement;
  private video!: HTMLVideoElement;
  private stage!: HTMLElement;

  private stream: MediaStream | null = null;
  private frame: BuiltFrame | null = null;
  private gestures: GestureController | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private orientationHandler: ((ev: DeviceOrientationEvent) => void) | null = null;

  private readonly framePosition = { x: 0, y: 0, z: -2 };
  private distance = 2;
  private roll = 0;
  private placed = false;
  private destroyed = false;
  private lastAmbientSample = 0;
  private ambient = 1;
  private ambientCanvas: HTMLCanvasElement | null = null;
  private deviceQuaternion: THREE.Quaternion | null = null;
  /** Orientação sem o roll do gesto. Congela ao fixar a peça. */
  private baseQuaternion!: THREE.Quaternion;
  private pendingOrientation: { alpha: number; beta: number; gamma: number } | null = null;

  async mount(ctx: SceneMountContext): Promise<void> {
    this.ctx = ctx;
    this.three = ctx.three;
    this.distance = ctx.options.assumedWallDistanceM;

    this.stage = ctx.container.querySelector('.fv-stage') as HTMLElement;
    this.video = ctx.container.querySelector('.fv-video') as HTMLVideoElement;
    this.canvas = ctx.container.querySelector('.fv-canvas') as HTMLCanvasElement;

    this.renderer = createRenderer(this.three, this.canvas);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap()));

    this.scene = new this.three.Scene();
    this.camera = new this.three.PerspectiveCamera(50, 1, 0.05, 100);
    this.camera.matrixAutoUpdate = true;
    this.baseQuaternion = new this.three.Quaternion();

    this.canvas.addEventListener('webglcontextlost', this.onContextLost);

    this.resizeObserver = new ResizeObserver(() => this.scheduleResize());
    this.resizeObserver.observe(this.stage);
    window.addEventListener('orientationchange', this.scheduleResize);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  setContent(frame: BuiltFrame): void {
    if (this.frame) this.scene.remove(this.frame.group);
    this.frame = frame;
    this.scene.add(frame.group);
    this.reset();
  }

  async start(): Promise<void> {
    try {
      this.stream = await openCamera();
    } catch (err) {
      throw normalizeError(err, 'camera', {
        locale: this.ctx.options.locale,
      });
    }
    // O getUserMedia pode resolver depois do destroy(); sem esta checagem a luz
    // da câmera fica acesa.
    if (this.destroyed) {
      for (const track of this.stream.getTracks()) track.stop();
      return;
    }

    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    await this.video.play().catch(() => undefined);

    for (const track of this.stream.getVideoTracks()) {
      track.addEventListener('ended', this.onTrackEnded);
    }

    await this.requestOrientation();
    this.attachGestures();
    this.resize();
    this.renderer.setAnimationLoop(this.tick);
    this.ctx.emit('hint', this.ctx.options.autoPlaceOnPlane ? 'drag-to-move' : 'tap-to-place');
  }

  pause(): void {
    this.renderer.setAnimationLoop(null);
    this.video.pause();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
  }

  async resume(): Promise<void> {
    if (this.destroyed || this.stream) return;
    await this.start();
  }

  place(): void {
    if (!this.frame) return;
    this.placed = true;
    this.frame.setOpacity(1);
    this.ctx.emit('placed', {
      distanceMeters: this.distance,
      source: 'manual',
      position: { ...this.framePosition },
    });
  }

  reset(): void {
    this.placed = false;
    this.roll = 0;
    this.distance = this.ctx.options.assumedWallDistanceM;
    this.framePosition.x = 0;
    this.framePosition.y = 0;
    this.framePosition.z = -this.distance;
    this.frame?.setOpacity(this.ctx.options.autoPlaceOnPlane ? 0.85 : 1);
    this.ctx.emit('unplaced', undefined);
  }

  async capture(): Promise<Blob | null> {
    if (!this.stream) return null;
    return new Promise<Blob | null>((resolve) => {
      requestAnimationFrame(() => {
        this.renderer.render(this.scene, this.camera);
        composeCapture(this.video, this.renderer).then(resolve, () => resolve(null));
      });
    });
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.renderer.setAnimationLoop(null);
    this.gestures?.detach();
    this.resizeObserver?.disconnect();
    window.removeEventListener('orientationchange', this.scheduleResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.orientationHandler) {
      window.removeEventListener('deviceorientation', this.orientationHandler);
      this.orientationHandler = null;
    }
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);

    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.video.srcObject = null;

    if (this.frame) {
      this.scene.remove(this.frame.group);
      this.frame = null;
    }
    this.renderer.dispose();
    // Não é opcional no iOS: o Safari não libera contextos WebGL de forma
    // agressiva e uma SPA acumula "Too many active WebGL contexts".
    this.renderer.forceContextLoss();
  }

  // --- interno ------------------------------------------------------------

  private attachGestures(): void {
    const { allowRotate, allowScale } = this.ctx.options;
    this.gestures = new GestureController(
      this.stage,
      {
        onPan: (dx, dy) => this.pan(dx, dy),
        onPinch: (factor) => this.pinch(factor),
        onRotate: (delta) => {
          this.roll += delta;
        },
        onTap: () => {
          if (!this.placed) this.place();
        },
      },
      { move: true, scale: allowScale, rotate: allowRotate },
    );
    this.gestures.attach();
  }

  private pan(dxPx: number, dyPx: number): void {
    const perPixel = worldPerPixel(this.distance, this.camera.fov, this.canvas.clientHeight || 1);
    const right = new this.three.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new this.three.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    this.framePosition.x += (right.x * dxPx - up.x * dyPx) * perPixel;
    this.framePosition.y += (right.y * dxPx - up.y * dyPx) * perPixel;
    this.framePosition.z += (right.z * dxPx - up.z * dyPx) * perPixel;
  }

  /**
   * A pinça altera a DISTÂNCIA assumida, nunca a escala do objeto. O produto
   * existe para responder "50×70 fica bom na minha parede?" — se a pinça
   * redimensiona o quadro, a pergunta perde o sentido e o screenshot mente.
   */
  private pinch(factor: number): void {
    const previous = this.distance;
    this.distance = clamp(this.distance / factor, MIN_DISTANCE_M, MAX_DISTANCE_M);
    const ratio = this.distance / previous;
    this.framePosition.x *= ratio;
    this.framePosition.y *= ratio;
    this.framePosition.z *= ratio;
  }

  private async requestOrientation(): Promise<void> {
    const ctor = window.DeviceOrientationEvent as
      | (typeof DeviceOrientationEvent & { requestPermission?: () => Promise<PermissionState> })
      | undefined;
    if (!ctor) return;

    if (typeof ctor.requestPermission === 'function') {
      try {
        const state = await ctor.requestPermission();
        if (state !== 'granted') return;
      } catch {
        return;
      }
    }
    if (this.destroyed) return;

    this.deviceQuaternion = new this.three.Quaternion();
    this.orientationHandler = (ev) => {
      if (ev.alpha == null || ev.beta == null || ev.gamma == null) return;
      this.pendingOrientation = { alpha: ev.alpha, beta: ev.beta, gamma: ev.gamma };
    };
    window.addEventListener('deviceorientation', this.orientationHandler);
  }

  private scheduleResize = (): void => {
    // O iOS reporta video.videoWidth desatualizado logo após a rotação.
    window.setTimeout(() => this.resize(), 300);
  };

  private resize(): void {
    if (this.destroyed) return;
    const w = this.stage.clientWidth || 1;
    const h = this.stage.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.updateFrustum(w, h);
  }

  /**
   * O frustum WebGL precisa corresponder exatamente à porção VISÍVEL do vídeo.
   * Sem isso o objeto virtual "nada" em relação ao fundo quando o telefone gira
   * — é o erro mais comum de implementações de passthrough.
   */
  private updateFrustum(canvasW: number, canvasH: number): void {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (vw > 0 && vh > 0) {
      const scale = Math.max(canvasW / vw, canvasH / vh); // object-fit: cover
      const visibleH = canvasH / scale;
      // Não existe campo padronizado de FOV em getSettings()/getCapabilities().
      // 68° ≈ lente principal de 26 mm equivalente. Calibrável via opções.
      const tanHalfH = Math.tan(degToRad(this.ctx.options.assumedCameraFovH) / 2);
      this.camera.fov = 2 * radToDeg(Math.atan(tanHalfH * (visibleH / vw)));
    }
    this.camera.aspect = canvasW / canvasH;
    this.camera.updateProjectionMatrix();
  }

  private sampleAmbient(now: number): void {
    if (now - this.lastAmbientSample < 1000 || this.video.videoWidth === 0) return;
    this.lastAmbientSample = now;

    this.ambientCanvas ??= Object.assign(document.createElement('canvas'), {
      width: 8,
      height: 8,
    });
    const ctx = this.ambientCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    try {
      ctx.drawImage(this.video, 0, 0, 8, 8);
      const { data } = ctx.getImageData(0, 0, 8, 8);
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) {
        sum +=
          0.2126 * (data[i] as number) +
          0.7152 * (data[i + 1] as number) +
          0.0722 * (data[i + 2] as number);
      }
      const luminance = sum / (data.length / 4) / 255;
      this.ambient += (luminance * 0.6 + 0.5 - this.ambient) * 0.1;
      this.frame?.setAmbient(this.ambient);
    } catch {
      // getImageData pode falhar em contextos exóticos; a luz fica no default.
    }
  }

  private tick = (time: number): void => {
    if (this.destroyed || !this.frame) return;

    if (this.pendingOrientation && this.deviceQuaternion) {
      const { alpha, beta, gamma } = this.pendingOrientation;
      const screenAngle = degToRad(
        screen.orientation?.angle ?? (window as Window & { orientation?: number }).orientation ?? 0,
      );
      orientationQuaternion(
        this.three,
        this.deviceQuaternion,
        degToRad(alpha),
        degToRad(beta),
        degToRad(gamma),
        screenAngle,
      );
      this.camera.quaternion.copy(this.deviceQuaternion);
    }
    this.camera.updateMatrixWorld();

    const group = this.frame.group;
    group.position.set(this.framePosition.x, this.framePosition.y, this.framePosition.z);

    if (!this.placed) {
      // Enquanto posiciona, o quadro fica de frente para o usuário, sempre em prumo.
      const nx = this.camera.position.x - this.framePosition.x;
      const nz = this.camera.position.z - this.framePosition.z;
      const q = wallBasis(this.three, nx, 0, nz);
      if (q) this.baseQuaternion.copy(q);
    }
    // Recomposto a partir da base a cada frame, nunca incremental: um
    // `rotateZ(roll)` acumularia e faria a peça girar sozinha depois de fixada.
    group.quaternion.copy(this.baseQuaternion);
    if (this.roll !== 0) group.rotateZ(this.roll);

    this.sampleAmbient(time);
    this.renderer.render(this.scene, this.camera);
  };

  private onVisibility = (): void => {
    if (document.hidden) this.renderer.setAnimationLoop(null);
    else if (this.stream) this.renderer.setAnimationLoop(this.tick);
  };

  private onTrackEnded = (): void => {
    this.ctx.emit('sessionend', { reason: 'lost' });
  };

  private onContextLost = (ev: Event): void => {
    ev.preventDefault();
    this.ctx.emit('error', normalizeError(ev, 'runtime', { locale: this.ctx.options.locale }));
  };
}
