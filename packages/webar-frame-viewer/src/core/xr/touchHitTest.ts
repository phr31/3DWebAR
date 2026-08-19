import type * as THREE from 'three';
import type { ThreeNS } from '../loadThree';
import { isWallNormal, readHitPoseInto, wallBasisInto } from '../TransformUtils';
import { MAX_HIT_M, MIN_HIT_M, WALL_GAP } from './hitTest';

/**
 * Resolve a pose do quadro para o ponto que o usuário TOCOU, e não para o centro
 * da tela.
 *
 * A diferença de intenção em relação a `hitTest.ts` é o ponto do desenho: lá o
 * hit-test escolhe o lugar e o filtro de parede tem poder de veto — sem plano
 * vertical promovido pelo ARCore (parede branca e lisa é a regra, não a exceção)
 * não sobra candidato e o fluxo trava. Aqui quem escolhe o lugar é o dedo; a
 * detecção só qualifica esse lugar. Por isso nada aqui pode devolver "não dá":
 * o pior caso é uma estimativa, nunca uma recusa.
 */

/** `plane` = superfície de parede realmente detectada. `estimated` = profundidade assumida. */
export type TouchQuality = 'plane' | 'estimated';

/**
 * @param hitMatrix  Matriz de pose (column-major) do hit sob o dedo, ou null.
 * @param rayOrigin  Origem do raio do toque, em coordenadas de mundo.
 * @param rayDirection  Direção normalizada do raio do toque.
 */
/**
 * Normal do hit do frame corrente. Escracho de módulo: esta função roda a cada
 * frame enquanto o dedo está na tela, e é sempre consumida antes de retornar.
 */
let hitNormal: THREE.Vector3 | null = null;

export function resolveTouchCandidate(
  three: ThreeNS,
  hitMatrix: ArrayLike<number> | null,
  rayOrigin: THREE.Vector3,
  rayDirection: THREE.Vector3,
  assumedDistanceM: number,
  wallToleranceDeg: number,
  outPosition: THREE.Vector3,
  outQuaternion: THREE.Quaternion,
): TouchQuality {
  /**
   * O prumo virado para o usuário é a orientação de reserva, e é montado SOB
   * DEMANDA. Antes ele era calculado no topo da função, inclusive no caso bom —
   * em que a parede foi detectada e ele é jogado fora. A linha aparece duas
   * vezes abaixo em vez de virar uma closure: uma closure por chamada seria uma
   * alocação por frame, que é justamente o que se está eliminando aqui.
   *
   * Escrever direto em `outQuaternion` é seguro porque todo caminho que a
   * alcança é terminal, e `wallBasisInto` não toca a saída quando não há guinada
   * válida — o mesmo que o `if (plumb)` da versão anterior fazia.
   */
  if (hitMatrix) {
    hitNormal ??= new three.Vector3();
    const normal = hitNormal;
    readHitPoseInto(hitMatrix, normal, outPosition);
    const distance = outPosition.distanceTo(rayOrigin);

    if (distance >= MIN_HIT_M && distance <= MAX_HIT_M) {
      // A POSIÇÃO do hit vale mesmo quando a normal não presta — ela é a
      // profundidade medida, que é justamente o que dá fidedignidade ao que o
      // usuário vê. Só a orientação cai no prumo. É também o que torna
      // `entityTypes: ['plane','point']` seguro: de um feature point aproveitamos
      // o ponto e descartamos a orientação, que é lixo.
      if (
        isWallNormal(normal.y, wallToleranceDeg) &&
        wallBasisInto(three, normal.x, normal.y, normal.z, outQuaternion)
      ) {
        outPosition.addScaledVector(normal.normalize(), WALL_GAP);
        return 'plane';
      }

      wallBasisInto(three, -rayDirection.x, 0, -rayDirection.z, outQuaternion);
      outPosition.addScaledVector(rayDirection, -WALL_GAP);
      return 'estimated';
    }
  }

  // Sem hit aproveitável: projeta o quadro ao longo do raio do toque.
  //
  // Ao contrário de `manualCandidate`, a altura NÃO é forçada para a da câmera:
  // aqui o usuário apontou o ponto, e um toque no alto da parede tem que colocar
  // o quadro no alto da parede.
  wallBasisInto(three, -rayDirection.x, 0, -rayDirection.z, outQuaternion);
  outPosition.copy(rayOrigin).addScaledVector(rayDirection, assumedDistanceM);
  return 'estimated';
}
