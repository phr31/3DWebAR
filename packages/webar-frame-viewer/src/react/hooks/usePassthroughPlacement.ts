'use client';

import { useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { GestureController } from '../../core/GestureController';
import { clamp, wallBasis, worldPerPixel } from '../../core/TransformUtils';
import type { PlacementInfo, ResolvedOptions } from '../../core/types';

/**
 * Posicionamento por gestos no passthrough: arrastar move, pinça ajusta a
 * distância, dois dedos giram, toque fixa.
 *
 * Reaproveita o `GestureController` (Pointer Events, tap = <12 px e <400 ms) e a
 * matemática de `TransformUtils`, iguais ao build UMD.
 */

const MIN_DISTANCE_M = 0.6;
const MAX_DISTANCE_M = 6;

export interface PassthroughPlacementOptions {
  /** Elemento que captura os gestos — o `.fv-stage`. */
  target: HTMLElement | null;
  options: ResolvedOptions;
  onPlace(info: PlacementInfo): void;
}

export interface PassthroughPlacementResult {
  /**
   * Aplicado ao grupo do quadro dentro do `useFrame`. `anchored` é o estado do
   * TOQUE (parou de se virar para o usuário), não o do cadeado.
   */
  apply(group: THREE.Object3D, anchored: boolean): void;
  place(): void;
  /**
   * Trava/destrava os gestos mantendo a pose. Destravar não devolve o quadro ao
   * ponto inicial: quem ajusta quer continuar de onde parou. Para voltar ao
   * começo existe o `reset()`.
   */
  setLocked(locked: boolean): void;
  unplace(): void;
  reset(): void;
}

export function usePassthroughPlacement({
  target,
  options,
  onPlace,
}: PassthroughPlacementOptions): PassthroughPlacementResult {
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);

  // Zerado aqui e posicionado pelo `reset()` na montagem — o mesmo caminho que
  // o engine original usava (`setContent` chamava `reset`), então o estado
  // inicial e o de reposicionamento não podem divergir.
  const position = useMemo(() => new THREE.Vector3(), []);
  const baseQuaternion = useMemo(() => new THREE.Quaternion(), []);
  const distanceRef = useRef(options.assumedWallDistanceM);
  const rollRef = useRef(0);
  // Ancorado ≠ travado. `placedRef` diz se o toque já aconteceu (e portanto se um
  // novo toque deve ser ignorado); `lockedRef` é o cadeado, e só ele fecha os
  // gestos. Entre os dois estados fica o ajuste fino.
  const placedRef = useRef(false);
  const lockedRef = useRef(false);

  const latest = useRef({ options, onPlace, camera, size });
  latest.current = { options, onPlace, camera, size };

  const api = useMemo<PassthroughPlacementResult>(
    () => ({
      apply(group, anchored) {
        placedRef.current = anchored;
        group.position.copy(position);

        if (!anchored) {
          // Enquanto posiciona, o quadro fica de frente para o usuário, em prumo.
          const q = wallBasis(
            THREE,
            latest.current.camera.position.x - position.x,
            0,
            latest.current.camera.position.z - position.z,
          );
          if (q) baseQuaternion.copy(q);
        }
        // Recomposto a partir da base a cada frame, nunca incremental: um
        // `rotateZ(roll)` acumularia e faria a peça girar sozinha depois de fixada.
        group.quaternion.copy(baseQuaternion);
        if (rollRef.current !== 0) group.rotateZ(rollRef.current);
      },
      place() {
        placedRef.current = true;
        // Ancorar não trava: o cadeado começa aberto para o ajuste fino.
        lockedRef.current = false;
        latest.current.onPlace({
          distanceMeters: distanceRef.current,
          source: 'manual',
          position: { x: position.x, y: position.y, z: position.z },
        });
      },
      setLocked(locked) {
        lockedRef.current = locked;
      },
      unplace() {
        placedRef.current = false;
        lockedRef.current = false;
      },
      reset() {
        placedRef.current = false;
        lockedRef.current = false;
        rollRef.current = 0;
        distanceRef.current = latest.current.options.assumedWallDistanceM;
        position.set(0, 0, -distanceRef.current);
      },
    }),
    [baseQuaternion, position],
  );

  // Estado inicial idêntico ao de um reposicionamento.
  useEffect(() => {
    api.reset();
  }, [api]);

  // Gestos. Depende só do alvo e das permissões — os handlers leem tudo via
  // `latest`, então um re-render do pai não reanexa os listeners.
  // biome-ignore lint/correctness/useExhaustiveDependencies: ver acima
  useEffect(() => {
    if (!target) return;
    const { allowRotate, allowScale } = options;

    const gestures = new GestureController(
      target,
      {
        // Travado é travado: com o cadeado fechado nenhum gesto move a peça. Sem
        // isto o "lock" seria só cosmético — arrastar continuaria deslocando o
        // quadro. Note que o gate é o cadeado, e NÃO o toque: entre ancorar e
        // travar o arraste é justamente o que se quer.
        onPan(dxPx, dyPx) {
          if (lockedRef.current) return;
          const perPixel = worldPerPixel(
            distanceRef.current,
            (latest.current.camera as THREE.PerspectiveCamera).fov,
            latest.current.size.height || 1,
          );
          const matrix = latest.current.camera.matrixWorld;
          const right = new THREE.Vector3().setFromMatrixColumn(matrix, 0);
          const up = new THREE.Vector3().setFromMatrixColumn(matrix, 1);
          position.x += (right.x * dxPx - up.x * dyPx) * perPixel;
          position.y += (right.y * dxPx - up.y * dyPx) * perPixel;
          position.z += (right.z * dxPx - up.z * dyPx) * perPixel;
        },
        /**
         * A pinça altera a DISTÂNCIA assumida, nunca a escala do objeto. O
         * produto existe para responder "50×70 fica bom na minha parede?" — se a
         * pinça redimensiona o quadro, a pergunta perde o sentido e o
         * screenshot mente.
         */
        onPinch(factor) {
          if (lockedRef.current) return;
          const previous = distanceRef.current;
          distanceRef.current = clamp(previous / factor, MIN_DISTANCE_M, MAX_DISTANCE_M);
          const ratio = distanceRef.current / previous;
          position.multiplyScalar(ratio);
        },
        onRotate(delta) {
          if (lockedRef.current) return;
          rollRef.current += delta;
        },
        // O toque SÓ ancora. Depois de ancorado ele não faz mais nada — soltar é
        // decisão explícita no cadeado, senão um toque acidental devolveria o
        // quadro a seguir a câmera, que é a sensação de "o quadro não trava".
        onTap() {
          if (!placedRef.current) api.place();
        },
      },
      { move: true, scale: allowScale, rotate: allowRotate },
    );

    gestures.attach();
    return () => gestures.detach();
  }, [target, options.allowRotate, options.allowScale, api, position]);

  return api;
}
