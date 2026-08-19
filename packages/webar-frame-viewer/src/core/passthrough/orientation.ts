import type * as THREE from 'three';
import type { ThreeNS } from '../loadThree';
import { degToRad } from '../TransformUtils';

/**
 * Tracking 3-DoF pelo giroscópio, para aparelhos sem WebXR.
 *
 * Extraído de `engines/PassthroughSceneManager` para ser compartilhado com o
 * hook `usePassthrough`. A conversão é canônica e sensível a detalhe — qualquer
 * troca de ordem de Euler ou sinal faz a cena girar para o lado errado.
 */

export interface DeviceAngles {
  alpha: number;
  beta: number;
  gamma: number;
}

/**
 * Saúde da guinada (yaw).
 *
 * - `unknown`: ainda coletando amostras.
 * - `ok`: `alpha` responde ao giro horizontal.
 * - `dead`: o aparelho inclina (beta/gamma variam) mas `alpha` fica parado. Sem
 *   giroscópio/bússola utilizáveis não existe rastreamento horizontal, e o quadro
 *   fica colado ao visor por mais correta que a matemática esteja. Quem consome
 *   precisa saber para avisar o usuário em vez de fingir AR.
 */
export type YawStatus = 'unknown' | 'ok' | 'dead';

/**
 * Escrachos da conversão de sensor. Preguiçosos porque o `three` chega por
 * parâmetro — é o que mantém este arquivo sem `import * as THREE`. Isto roda uma
 * vez por frame durante toda a sessão de passthrough; a versão anterior alocava
 * um Euler, dois Quaternion e um Vector3 em cada uma delas.
 */
interface OrientationScratch {
  euler: THREE.Euler;
  /** Constante: −90° em torno de X. Montado uma vez e só lido. */
  deviceToCamera: THREE.Quaternion;
  screen: THREE.Quaternion;
  screenAxis: THREE.Vector3;
}
let orientationScratch: OrientationScratch | null = null;

function getOrientationScratch(three: ThreeNS): OrientationScratch {
  orientationScratch ??= {
    euler: new three.Euler(0, 0, 0, 'YXZ'),
    // -PI/2 em torno de X: o dispositivo olha para -Z quando deitado.
    deviceToCamera: new three.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2),
    screen: new three.Quaternion(),
    screenAxis: new three.Vector3(0, 0, 1),
  };
  return orientationScratch;
}

/** Conversão canônica de DeviceOrientationEvent para quaternion de câmera. */
export function orientationQuaternion(
  three: ThreeNS,
  target: THREE.Quaternion,
  alpha: number,
  beta: number,
  gamma: number,
  screenAngle: number,
): void {
  const s = getOrientationScratch(three);
  target.setFromEuler(s.euler.set(beta, alpha, -gamma, 'YXZ'));
  target.multiply(s.deviceToCamera);
  target.multiply(s.screen.setFromAxisAngle(s.screenAxis, -screenAngle));
}

/** Aplica os ângulos em graus do DeviceOrientationEvent direto no quaternion. */
export function applyDeviceAngles(
  three: ThreeNS,
  target: THREE.Quaternion,
  angles: DeviceAngles,
): void {
  orientationQuaternion(
    three,
    target,
    degToRad(angles.alpha),
    degToRad(angles.beta),
    degToRad(angles.gamma),
    currentScreenAngle(),
  );
}

/** Rotação da tela em radianos, com o fallback do `window.orientation` legado. */
export function currentScreenAngle(): number {
  return degToRad(
    screen.orientation?.angle ?? (window as Window & { orientation?: number }).orientation ?? 0,
  );
}

/** Silêncio da fonte absoluta que a faz perder a preferência. */
const ABSOLUTE_TTL_MS = 1000;
/** Janela de observação do detector de yaw. */
const YAW_WINDOW_MS = 4000;
/** Abaixo disto, no acumulado da janela, `alpha` está parado. */
const YAW_MIN_TRAVEL_DEG = 1;
/** O veredito só vale se o aparelho realmente se moveu na janela. */
const TILT_MIN_TRAVEL_DEG = 5;

/** Menor diferença com sinal entre dois ângulos em graus, tratando a volta em 360. */
function angleDelta(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

/**
 * Decide se a guinada do aparelho é utilizável, observando quanto `alpha` andou
 * enquanto `beta`/`gamma` andavam.
 *
 * Puro e sem I/O de propósito: a decisão é o que interessa testar, e ela também
 * roda no engine imperativo do build UMD.
 */
export class YawWatcher {
  private status: YawStatus = 'unknown';
  private windowStart = 0;
  private alphaTravel = 0;
  private tiltTravel = 0;
  private previous: DeviceAngles | null = null;

  get current(): YawStatus {
    return this.status;
  }

  reset(): void {
    this.status = 'unknown';
    this.previous = null;
    this.windowStart = 0;
    this.alphaTravel = 0;
    this.tiltTravel = 0;
  }

  sample(angles: DeviceAngles, now: number): YawStatus {
    const previous = this.previous;
    this.previous = angles;

    if (!previous) {
      this.windowStart = now;
      return this.status;
    }

    this.alphaTravel += Math.abs(angleDelta(previous.alpha, angles.alpha));
    this.tiltTravel +=
      Math.abs(angleDelta(previous.beta, angles.beta)) +
      Math.abs(angleDelta(previous.gamma, angles.gamma));

    // `ok` é definitivo: um sensor que já respondeu não passa a não existir. O
    // contrário não vale — o veredito `dead` continua sendo revisto a cada janela.
    if (this.alphaTravel >= YAW_MIN_TRAVEL_DEG) {
      this.status = 'ok';
      this.startWindow(now);
      return this.status;
    }

    if (now - this.windowStart < YAW_WINDOW_MS) return this.status;

    if (this.tiltTravel >= TILT_MIN_TRAVEL_DEG) this.status = 'dead';
    this.startWindow(now);
    return this.status;
  }

  private startWindow(now: number): void {
    this.windowStart = now;
    this.alphaTravel = 0;
    this.tiltTravel = 0;
  }
}

/** Extração dos ângulos de um evento, já resolvendo a bússola do Safari. */
function readEvent(ev: DeviceOrientationEvent): { angles: DeviceAngles; absolute: boolean } | null {
  if (ev.beta == null || ev.gamma == null) return null;

  // `webkitCompassHeading` é o yaw ABSOLUTO do iOS, medido em sentido horário a
  // partir do norte — o inverso da convenção de `alpha`. É a única fonte de yaw
  // confiável no Safari, onde `alpha` é relativo ao início da sessão e deriva.
  const heading = (ev as DeviceOrientationEvent & { webkitCompassHeading?: number })
    .webkitCompassHeading;
  if (typeof heading === 'number' && Number.isFinite(heading)) {
    return { angles: { alpha: 360 - heading, beta: ev.beta, gamma: ev.gamma }, absolute: true };
  }

  if (ev.alpha == null) return null;
  return { angles: { alpha: ev.alpha, beta: ev.beta, gamma: ev.gamma }, absolute: ev.absolute };
}

/**
 * Pede a permissão de giroscópio do iOS 13+ e passa a escutar. Devolve a função
 * de limpeza, ou null se o giroscópio não estiver disponível/autorizado.
 *
 * Escuta os DOIS eventos: `deviceorientationabsolute` (Chrome/Android, orientação
 * referenciada ao norte) e `deviceorientation` (relativo). Enquanto a absoluta
 * estiver reportando, ela ganha — a relativa depende do sensor de orientação
 * relativa, que exige giroscópio e é justamente o que falta nos aparelhos onde o
 * quadro cola no visor. Se a absoluta calar por mais de `ABSOLUTE_TTL_MS`, a
 * relativa reassume: pior referência é melhor do que cena congelada.
 *
 * `isCancelled` é consultado após o await da permissão: o usuário pode fechar o
 * visualizador enquanto o diálogo está aberto.
 */
export async function listenToOrientation(
  onAngles: (angles: DeviceAngles, yaw: YawStatus) => void,
  isCancelled: () => boolean = () => false,
): Promise<(() => void) | null> {
  const ctor = window.DeviceOrientationEvent as
    | (typeof DeviceOrientationEvent & { requestPermission?: () => Promise<PermissionState> })
    | undefined;
  if (!ctor) return null;

  if (typeof ctor.requestPermission === 'function') {
    try {
      const state = await ctor.requestPermission();
      if (state !== 'granted') return null;
    } catch {
      return null;
    }
  }
  if (isCancelled()) return null;

  const watcher = new YawWatcher();
  let lastAbsoluteAt = 0;

  const handle = (ev: DeviceOrientationEvent, fromAbsoluteEvent: boolean): void => {
    const read = readEvent(ev);
    if (!read) return;

    const now = performance.now();
    const absolute = fromAbsoluteEvent || read.absolute;

    if (absolute) {
      // Trocar de fonte muda a referência de `alpha`: o histórico não vale mais.
      if (now - lastAbsoluteAt > ABSOLUTE_TTL_MS) watcher.reset();
      lastAbsoluteAt = now;
    } else if (now - lastAbsoluteAt <= ABSOLUTE_TTL_MS) {
      // A absoluta está viva e é melhor: ignora a relativa.
      return;
    } else if (lastAbsoluteAt !== 0) {
      // A absoluta calou (a bússola do iOS some quando descalibra). Voltar para a
      // relativa é melhor do que congelar a cena.
      lastAbsoluteAt = 0;
      watcher.reset();
    }

    onAngles(read.angles, watcher.sample(read.angles, now));
  };

  const onRelative = (ev: DeviceOrientationEvent): void => handle(ev, false);
  const onAbsolute = (ev: DeviceOrientationEvent): void => handle(ev, true);

  window.addEventListener('deviceorientation', onRelative);
  window.addEventListener('deviceorientationabsolute', onAbsolute as EventListener);
  return () => {
    window.removeEventListener('deviceorientation', onRelative);
    window.removeEventListener('deviceorientationabsolute', onAbsolute as EventListener);
  };
}
