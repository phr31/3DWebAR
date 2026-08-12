'use client';

import { forwardRef, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { RETICLE_STABLE, RETICLE_UNSTABLE } from '../../core/xr/hitTest';

/**
 * O retículo é o CONTORNO REAL do produto, não o anel do sample oficial. O
 * usuário vê na hora se 50×70 cabe entre a porta e a estante — é a melhor
 * decisão de UX do fluxo e sai praticamente de graça.
 *
 * Âmbar enquanto o alvo está instável, verde quando estabiliza (5 quadros
 * válidos consecutivos, ver `core/xr/hitTest`).
 */

export interface ReticleProps {
  width: number;
  height: number;
  stable: boolean;
  visible?: boolean;
}

export const Reticle = forwardRef<THREE.Group, ReticleProps>(function Reticle(
  { width, height, stable, visible = true },
  ref,
) {
  const outline = useMemo(() => {
    const points = [
      new THREE.Vector3(-width / 2, -height / 2, 0),
      new THREE.Vector3(width / 2, -height / 2, 0),
      new THREE.Vector3(width / 2, height / 2, 0),
      new THREE.Vector3(-width / 2, height / 2, 0),
    ];
    return new THREE.BufferGeometry().setFromPoints(points);
  }, [width, height]);

  useEffect(() => () => outline.dispose(), [outline]);

  return (
    <group ref={ref} visible={visible}>
      {/* `depthTest: false` + renderOrder alto: o contorno tem que aparecer
          por cima da cena, mesmo colado na parede. */}
      <mesh renderOrder={999}>
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial color={0xffffff} transparent opacity={0.12} depthTest={false} />
      </mesh>
      <lineLoop geometry={outline} renderOrder={1000}>
        <lineBasicMaterial color={stable ? RETICLE_STABLE : RETICLE_UNSTABLE} depthTest={false} />
      </lineLoop>
    </group>
  );
});
