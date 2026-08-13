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
  /** Aplicado ao grupo do quadro dentro do `useFrame`. */
  apply(group: THREE.Object3D, placed: boolean): void;
  place(): void;
  /**
   * Destrava mantendo onde está. Diferente de `reset()`, que devolve o quadro ao
   * ponto inicial — quem toca em "Reposicionar" quer continuar de onde parou.
   */
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
  const placedRef = useRef(false);

  const latest = useRef({ options, onPlace, camera, size });
  latest.current = { options, onPlace, camera, size };

  const api = useMemo<PassthroughPlacementResult>(
    () => ({
      apply(group, placed) {
        placedRef.current = placed;
        group.position.copy(position);

        if (!placed) {
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
        latest.current.onPlace({
          distanceMeters: distanceRef.current,
          source: 'manual',
          position: { x: position.x, y: position.y, z: position.z },
        });
      },
      unplace() {
        placedRef.current = false;
      },
      reset() {
        placedRef.current = false;
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
        // Fixado é fixado: enquanto travado nenhum gesto move a peça. Sem isto o
        // "lock" seria só cosmético — arrastar continuaria deslocando o quadro.
        onPan(dxPx, dyPx) {
          if (placedRef.current) return;
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
          if (placedRef.current) return;
          const previous = distanceRef.current;
          distanceRef.current = clamp(previous / factor, MIN_DISTANCE_M, MAX_DISTANCE_M);
          const ratio = distanceRef.current / previous;
          position.multiplyScalar(ratio);
        },
        onRotate(delta) {
          if (placedRef.current) return;
          rollRef.current += delta;
        },
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
