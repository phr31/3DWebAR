'use client';

import { useThree } from '@react-three/fiber';
import { useXRHitTest } from '@react-three/xr';
import { type RefObject, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { ARHint } from '../../core/types';
import { type HitOutcome, HitTestTracker, progressHint } from '../../core/xr/hitTest';

/**
 * Hit-test com histerese, sobre o `useXRHitTest` do @react-three/xr.
 *
 * O hook da lib entrega os `XRHitTestResult` crus e uma `getWorldMatrix`. Usamos
 * a `getWorldMatrix` (e não `hit.getPose(space)`) de propósito: ela já converte
 * para o espaço de mundo do three levando em conta o `XROrigin`, que o R3F pode
 * ter deslocado. A normal sai da coluna Y da matriz — `Matrix4.elements` é
 * column-major igual à matriz de pose do WebXR, então `readHitPose` continua
 * valendo sem adaptação.
 *
 * Toda a lógica de aceite/suavização mora em `core/xr/hitTest`, compartilhada
 * com o `WebXRSceneManager` do build UMD.
 */

export interface HitTestOptions {
  wallToleranceDeg: number;
  noHitTimeoutMs: number;
  /** Desliga o filtro — a peça já foi fixada ou o modo manual assumiu. */
  enabled: boolean;
  manualMode: boolean;
  onHint(hint: ARHint): void;
}

export interface HitTestResult {
  tracker: HitTestTracker;
  /** Lidos dentro do `useFrame`; escrevê-los não dispara render. */
  outcomeRef: RefObject<HitOutcome>;
  hasCandidateRef: RefObject<boolean>;
  /** Reinicia histerese e escalada de dicas (equivalente ao `reset()`). */
  restart(): void;
}

export function useHitTest(options: HitTestOptions): HitTestResult {
  const camera = useThree((state) => state.camera);

  const tracker = useMemo(() => new HitTestTracker(THREE), []);
  const cameraPosition = useMemo(() => new THREE.Vector3(), []);
  /** Pool de matrizes: o callback roda a cada frame XR, alocar ali é lixo garantido. */
  const pool = useRef<THREE.Matrix4[]>([]);

  const outcomeRef = useRef<HitOutcome>({ kind: 'lost', sawHits: false });
  const hasCandidateRef = useRef(false);
  const startedAtRef = useRef(performance.now());
  const noWallNotifiedRef = useRef(false);

  // Numa ref para o callback não mudar de identidade a cada render — o
  // @react-three/xr derrubaria e refaria a hit-test source.
  const latest = useRef(options);
  latest.current = options;

  useXRHitTest(
    (results, getWorldMatrix) => {
      const opts = latest.current;
      if (!opts.enabled) return;

      while (pool.current.length < results.length) pool.current.push(new THREE.Matrix4());

      const matrices: Array<THREE.Matrix4['elements']> = [];
      for (let i = 0; i < results.length; i++) {
        const target = pool.current[i] as THREE.Matrix4;
        const result = results[i] as XRHitTestResult;
        if (getWorldMatrix(target, result)) matrices.push(target.elements);
      }

      camera.getWorldPosition(cameraPosition);

      const now = performance.now();
      const outcome = tracker.evaluate(
        matrices,
        results.length,
        cameraPosition,
        opts.wallToleranceDeg,
        now,
      );
      outcomeRef.current = outcome;

      if (outcome.kind === 'stable') {
        hasCandidateRef.current = true;
        opts.onHint('tap-to-place');
        return;
      }
      if (outcome.kind === 'settling') return;

      if (outcome.kind === 'lost') {
        hasCandidateRef.current = false;
        if (outcome.sawHits) opts.onHint('aim-wall');
      }

      // A escalada roda também durante a carência, como no engine original.
      const hint = progressHint(
        now - startedAtRef.current,
        opts.noHitTimeoutMs,
        noWallNotifiedRef.current,
        opts.manualMode,
      );
      if (hint === 'no-wall-found') noWallNotifiedRef.current = true;
      if (hint) opts.onHint(hint);
    },
    'viewer',
    // 'plane' evita hits em feature points soltos, cuja orientação é lixo.
    'plane',
  );

  return useMemo(
    () => ({
      tracker,
      outcomeRef,
      hasCandidateRef,
      restart() {
        tracker.reset();
        hasCandidateRef.current = false;
        noWallNotifiedRef.current = false;
        startedAtRef.current = performance.now();
        outcomeRef.current = { kind: 'lost', sawHits: false };
      },
    }),
    [tracker],
  );
}
