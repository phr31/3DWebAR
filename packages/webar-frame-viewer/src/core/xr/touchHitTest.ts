import type * as THREE from 'three';
import type { ThreeNS } from '../loadThree';
import { isWallNormal, readHitPose, wallBasis } from '../TransformUtils';
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
  // Prumo virado para o usuário: a orientação de reserva, usada tanto sem hit
  // quanto com hit de normal inaproveitável.
  const plumb = wallBasis(three, -rayDirection.x, 0, -rayDirection.z);

  if (hitMatrix) {
    const { normal, position } = readHitPose(hitMatrix);
    outPosition.set(position[0], position[1], position[2]);
    const distance = outPosition.distanceTo(rayOrigin);

    if (distance >= MIN_HIT_M && distance <= MAX_HIT_M) {
      const wall = isWallNormal(normal[1], wallToleranceDeg)
        ? wallBasis(three, normal[0], normal[1], normal[2])
        : null;

      // A POSIÇÃO do hit vale mesmo quando a normal não presta — ela é a
      // profundidade medida, que é justamente o que dá fidedignidade ao que o
      // usuário vê. Só a orientação cai no prumo. É também o que torna
      // `entityTypes: ['plane','point']` seguro: de um feature point aproveitamos
      // o ponto e descartamos a orientação, que é lixo.
      if (wall) {
        outQuaternion.copy(wall);
        outPosition.addScaledVector(
          new three.Vector3(normal[0], normal[1], normal[2]).normalize(),
          WALL_GAP,
        );
        return 'plane';
      }

      if (plumb) outQuaternion.copy(plumb);
      outPosition.addScaledVector(rayDirection, -WALL_GAP);
      return 'estimated';
    }
  }

  // Sem hit aproveitável: projeta o quadro ao longo do raio do toque.
  //
  // Ao contrário de `manualCandidate`, a altura NÃO é forçada para a da câmera:
  // aqui o usuário apontou o ponto, e um toque no alto da parede tem que colocar
  // o quadro no alto da parede.
  if (plumb) outQuaternion.copy(plumb);
  outPosition.copy(rayOrigin).addScaledVector(rayDirection, assumedDistanceM);
  return 'estimated';
}
