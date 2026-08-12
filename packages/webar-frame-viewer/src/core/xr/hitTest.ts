import type * as THREE from 'three';
import type { ThreeNS } from '../loadThree';
import { isWallNormal, readHitPose, wallBasis } from '../TransformUtils';

/**
 * Filtro de aceite e histerese do hit-test, sem dependência de XRFrame, de
 * renderer ou de React.
 *
 * Extraído de `engines/WebXRSceneManager.updateFromHitTest` para ser
 * compartilhado com o hook `useHitTest`. Quem chama só precisa entregar as
 * matrizes de pose já resolvidas no espaço de referência — o resto (parede vs
 * chão, faixa de distância, suavização, estabilidade) mora aqui.
 */

/** Frames válidos consecutivos antes de aceitar um alvo. Sem isso o reticle pisca. */
export const STABLE_FRAMES = 5;
/** Milissegundos sem hit antes de esconder o reticle. */
export const HIT_GRACE_MS = 200;
/** Além de ~5 m o ARCore está chutando. */
export const MIN_HIT_M = 0.4;
export const MAX_HIT_M = 6;
/** Folga da parede, evita a peça entrar nela quando a estimativa do plano erra. */
export const WALL_GAP = 0.005;
/** Suavização do candidato. Ver comentário em `HitTestTracker.evaluate`. */
export const SMOOTHING = 0.25;
/** Cores do reticle: âmbar enquanto instável, verde quando o alvo estabiliza. */
export const RETICLE_UNSTABLE = 0xf59e0b;
export const RETICLE_STABLE = 0x22c55e;

export type HitOutcome =
  /** Candidato aceito e estável: pode posicionar. */
  | { kind: 'stable' }
  /** Candidato aceito, ainda acumulando frames. */
  | { kind: 'settling' }
  /** Nenhum hit neste frame, mas ainda dentro da carência. */
  | { kind: 'grace' }
  /** Nenhum hit e a carência expirou. `sawHits` = havia hits, mas eram chão/teto. */
  | { kind: 'lost'; sawHits: boolean };

export class HitTestTracker {
  readonly position: THREE.Vector3;
  readonly quaternion: THREE.Quaternion;

  private stableCount = 0;
  private lastHitAt = 0;
  private readonly point: THREE.Vector3;
  private readonly normalVec: THREE.Vector3;

  constructor(private readonly three: ThreeNS) {
    this.position = new three.Vector3();
    this.quaternion = new three.Quaternion();
    this.point = new three.Vector3();
    this.normalVec = new three.Vector3();
  }

  /** True quando o alvo já acumulou `STABLE_FRAMES` quadros válidos seguidos. */
  get isStable(): boolean {
    return this.stableCount >= STABLE_FRAMES;
  }

  reset(): void {
    this.stableCount = 0;
    this.lastHitAt = 0;
  }

  /**
   * @param matrices  Matrizes de pose (column-major) já resolvidas no espaço de
   *                  referência, na ordem de proximidade que o runtime devolveu.
   * @param rawCount  Quantidade de hits antes de descartar poses nulas — é o que
   *                  distingue "não vi nada" de "vi o chão".
   */
  evaluate(
    matrices: readonly ArrayLike<number>[],
    rawCount: number,
    cameraPosition: THREE.Vector3,
    wallToleranceDeg: number,
    now: number,
  ): HitOutcome {
    for (const matrix of matrices) {
      const { normal, position } = readHitPose(matrix);
      if (!isWallNormal(normal[1], wallToleranceDeg)) continue;

      this.point.set(position[0], position[1], position[2]);
      const distance = this.point.distanceTo(cameraPosition);
      if (distance < MIN_HIT_M || distance > MAX_HIT_M) continue;

      const quaternion = wallBasis(this.three, normal[0], normal[1], normal[2]);
      if (!quaternion) continue;

      this.normalVec.set(normal[0], normal[1], normal[2]).normalize();
      this.point.addScaledVector(this.normalVec, WALL_GAP);

      if (this.stableCount === 0) {
        this.position.copy(this.point);
        this.quaternion.copy(quaternion);
      } else {
        // Poses de hit-test tremem. A maior fonte de instabilidade percebida é a
        // rotação — a wallBasis já a elimina; o lerp cuida do resto.
        this.position.lerp(this.point, SMOOTHING);
        this.quaternion.slerp(quaternion, SMOOTHING);
      }

      this.stableCount++;
      this.lastHitAt = now;
      return this.stableCount < STABLE_FRAMES ? { kind: 'settling' } : { kind: 'stable' };
    }

    if (now - this.lastHitAt > HIT_GRACE_MS) {
      this.stableCount = 0;
      return { kind: 'lost', sawHits: rawCount > 0 };
    }
    return { kind: 'grace' };
  }

  /** Distância do candidato até a câmera, para o `PlacementInfo`. */
  distanceTo(cameraPosition: THREE.Vector3): number {
    return this.position.distanceTo(cameraPosition);
  }
}

/**
 * Escalonamento de dicas enquanto nenhuma parede aparece. Parede branca e lisa
 * não gera feature points, logo não gera plano — este é o caso mais comum do
 * produto, não um caso de borda.
 *
 * Devolve a dica a emitir, ou null quando não há nada novo a dizer.
 */
export function progressHint(
  elapsedMs: number,
  noHitTimeoutMs: number,
  alreadyNotified: boolean,
  manualMode: boolean,
): 'no-wall-found' | 'move-slower' | null {
  if (alreadyNotified) return null;
  if (!manualMode && elapsedMs > noHitTimeoutMs) return 'no-wall-found';
  if (elapsedMs > 3000) return 'move-slower';
  return null;
}

/**
 * Posicionamento manual: projeta a peça a uma distância fixa à frente da câmera,
 * em prumo. O tracking 6-DoF continua valendo — é AR de verdade, só sem saber
 * onde a parede está.
 */
export function manualCandidate(
  three: ThreeNS,
  camera: THREE.Camera,
  distanceM: number,
  outPosition: THREE.Vector3,
  outQuaternion: THREE.Quaternion,
): void {
  const forward = new three.Vector3();
  camera.getWorldDirection(forward);

  // Normal apontando de volta para o usuário, forçada em prumo (só yaw).
  const quaternion = wallBasis(three, -forward.x, 0, -forward.z);
  if (quaternion) outQuaternion.copy(quaternion);

  outPosition.copy(camera.position).addScaledVector(forward, distanceM);
  outPosition.y = camera.position.y;
}

/** Luminância Rec.709 do `light-estimation`, mapeada para a escala de ambiente. */
export function ambientFromLightEstimate(x: number, y: number, z: number): number {
  const luminance = 0.2126 * x + 0.7152 * y + 0.0722 * z;
  return 0.55 + Math.min(1, luminance / 3) * 0.45;
}
