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

/** Conversão canônica de DeviceOrientationEvent para quaternion de câmera. */
export function orientationQuaternion(
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

/**
 * Pede a permissão de giroscópio do iOS 13+ e passa a escutar. Devolve a função
 * de limpeza, ou null se o giroscópio não estiver disponível/autorizado.
 *
 * `isCancelled` é consultado após o await da permissão: o usuário pode fechar o
 * visualizador enquanto o diálogo está aberto.
 */
export async function listenToOrientation(
  onAngles: (angles: DeviceAngles) => void,
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

  const handler = (ev: DeviceOrientationEvent): void => {
    if (ev.alpha == null || ev.beta == null || ev.gamma == null) return;
    onAngles({ alpha: ev.alpha, beta: ev.beta, gamma: ev.gamma });
  };
  window.addEventListener('deviceorientation', handler);
  return () => window.removeEventListener('deviceorientation', handler);
}
