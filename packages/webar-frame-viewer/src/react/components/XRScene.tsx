'use client';

import { useFrame, useThree } from '@react-three/fiber';
import { useXR, useXRAnchor } from '@react-three/xr';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import type { LoadedTexture } from '../../core/AssetLoader';
import type { FrameStyle, ProductData, ResolvedOptions } from '../../core/types';
import { ambientFromLightEstimate, manualCandidate } from '../../core/xr/hitTest';
import type { ARApi } from '../hooks/useAR';
import { useHitTest } from '../hooks/useHitTest';
import { type FrameMetrics, FrameModel } from './FrameModel';
import { Reticle } from './Reticle';

/**
 * Cena do caminho WebXR (Android/ARCore): hit-test em parede, âncora e
 * posicionamento manual como plano B.
 *
 * Roda dentro de `<XR>`. Toda a decisão de aceite mora em `core/xr/hitTest`,
 * compartilhada com o `WebXRSceneManager` do build UMD — aqui só há a ligação
 * com o loop do R3F e com o estado do React.
 */

// `light-estimation` ainda não está em @types/webxr. Só o mínimo que usamos.
interface LightProbe {
  readonly probeSpace: XRSpace;
}
interface LightEstimate {
  readonly primaryLightIntensity?: DOMPointReadOnly;
}
type SessionWithProbe = XRSession & { requestLightProbe?: () => Promise<LightProbe> };
type FrameWithEstimate = XRFrame & {
  getLightEstimate?: (probe: LightProbe) => LightEstimate | null;
};

export interface XRSceneProps {
  product: ProductData;
  art: LoadedTexture;
  style: Required<FrameStyle>;
  options: ResolvedOptions;
  api: ARApi;
}

export function XRScene({ product, art, style, options, api }: XRSceneProps): React.ReactElement {
  const session = useXR((state) => state.session);
  const camera = useThree((state) => state.camera);

  const groupRef = useRef<THREE.Group | null>(null);
  const reticleRef = useRef<THREE.Group | null>(null);
  const placedRef = useRef(false);
  const lightProbeRef = useRef<LightProbe | null>(null);

  const [metrics, setMetrics] = useState<FrameMetrics | null>(null);
  const [ambient, setAmbient] = useState(1);
  const [stable, setStable] = useState(false);
  // Par ref+state: a ref é lida no `useFrame`, o state é o que a interface vê.
  // Só com o state a opacidade sai de 0.85 e o botão "Reposicionar" aparece.
  const [placed, setPlaced] = useState(false);

  const [anchor, createAnchor] = useXRAnchor();

  const hitTest = useHitTest({
    wallToleranceDeg: options.wallToleranceDeg,
    noHitTimeoutMs: options.noHitTimeoutMs,
    enabled: !placed,
    manualMode: api.manualModeRef.current,
    onHint: api.setHint,
  });

  // A sessão XR está no ar: só agora o overlay pode sair de 'loading'.
  // `canCapture: false` — dentro de uma XRSession o render vai para o
  // framebuffer do compositor e a imagem da câmera nunca esteve no nosso.
  useEffect(() => {
    if (session) api.reportEngineReady('webxr', false);
  }, [session, api]);

  // O WebXR não usa o giroscópio da página: o rastreamento é 6-DoF do runtime.
  useEffect(() => {
    if (!options.debug) return;
    api.setDebug({ engine: 'webxr', hasOrientation: session != null, angles: null, yaw: 'ok' });
    return () => api.setDebug(null);
  }, [api, options.debug, session]);

  // Light probe: opcional, pode não ter sido concedida.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    void (session as SessionWithProbe)
      .requestLightProbe?.()
      .then((probe) => {
        if (!cancelled) lightProbeRef.current = probe;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      lightProbeRef.current = null;
    };
  }, [session]);

  const place = useCallback(() => {
    const group = groupRef.current;
    if (!group || !hitTest.hasCandidateRef.current) return;

    placedRef.current = true;
    setPlaced(true);

    // Anchors reduzem materialmente o drift depois de 30 s parado — e o usuário
    // fica bastante tempo olhando para o quadro. Falha é aceitável: a feature
    // pode não ter sido concedida.
    void createAnchor({
      relativeTo: 'world',
      worldPosition: hitTest.tracker.position.clone(),
      worldQuaternion: hitTest.tracker.quaternion.clone(),
    }).catch(() => undefined);

    const cameraPosition = new THREE.Vector3();
    camera.getWorldPosition(cameraPosition);

    api.reportPlaced({
      distanceMeters: hitTest.tracker.distanceTo(cameraPosition),
      source: api.manualModeRef.current ? 'manual' : 'hit-test',
      position: {
        x: hitTest.tracker.position.x,
        y: hitTest.tracker.position.y,
        z: hitTest.tracker.position.z,
      },
    });
  }, [api, camera, createAnchor, hitTest]);

  const reset = useCallback(() => {
    placedRef.current = false;
    setPlaced(false);
    setStable(false);
    hitTest.restart();
    api.reportUnplaced();
  }, [api, hitTest]);

  // Toque na tela: SÓ fixa. Destravar é pelo botão "Reposicionar" — antes, um
  // toque acidental depois de fixar devolvia o quadro a seguir a câmera, que é
  // exatamente a sensação de "o quadro não trava".
  useEffect(() => {
    if (!session) return;
    const onSelect = (): void => {
      if (placedRef.current) return;
      if (hitTest.hasCandidateRef.current) place();
    };
    session.addEventListener('select', onSelect);
    return () => session.removeEventListener('select', onSelect);
  }, [session, place, hitTest]);

  useEffect(() => {
    api.registerReposition(reset);
    return () => api.registerReposition(null);
  }, [api, reset]);

  useFrame((_state, _delta, xrFrame) => {
    const group = groupRef.current;
    if (!group) return;

    // --- luz ambiente -----------------------------------------------------
    const probe = lightProbeRef.current;
    if (xrFrame && probe) {
      const intensity = (xrFrame as FrameWithEstimate).getLightEstimate?.(
        probe,
      )?.primaryLightIntensity;
      if (intensity) {
        const next = ambientFromLightEstimate(intensity.x, intensity.y, intensity.z);
        // Só re-renderiza em mudança perceptível; o probe atualiza a cada frame.
        if (Math.abs(next - ambient) > 0.01) setAmbient(next);
      }
    }

    // --- já fixado: a âncora manda ----------------------------------------
    if (placedRef.current) {
      if (anchor && xrFrame) {
        const referenceSpace = (
          _state.gl.xr as THREE.WebXRManager & {
            getReferenceSpace(): XRReferenceSpace | null;
          }
        ).getReferenceSpace();
        const pose = referenceSpace ? xrFrame.getPose(anchor.anchorSpace, referenceSpace) : null;
        if (pose) {
          const { position, orientation } = pose.transform;
          group.position.set(position.x, position.y, position.z);
          group.quaternion.set(orientation.x, orientation.y, orientation.z, orientation.w);
        }
      }
      // Sem âncora o quadro simplesmente fica onde foi deixado.
      return;
    }

    // --- posicionamento manual (parede lisa) ------------------------------
    if (api.manualModeRef.current) {
      manualCandidate(
        THREE,
        camera,
        options.assumedWallDistanceM,
        hitTest.tracker.position,
        hitTest.tracker.quaternion,
      );
      hitTest.hasCandidateRef.current = true;
      group.visible = true;
      group.position.copy(hitTest.tracker.position);
      group.quaternion.copy(hitTest.tracker.quaternion);
      if (reticleRef.current) reticleRef.current.visible = false;
      return;
    }

    // --- hit-test ---------------------------------------------------------
    const outcome = hitTest.outcomeRef.current;
    const isStable = outcome.kind === 'stable';
    if (isStable !== stable) setStable(isStable);

    if (!isStable) {
      if (outcome.kind === 'lost') {
        if (reticleRef.current) reticleRef.current.visible = false;
        if (!options.autoPlaceOnPlane) group.visible = false;
      }
      return;
    }

    if (options.autoPlaceOnPlane) {
      if (reticleRef.current) reticleRef.current.visible = false;
      group.visible = true;
      group.position.copy(hitTest.tracker.position);
      group.quaternion.copy(hitTest.tracker.quaternion);
    } else if (reticleRef.current) {
      reticleRef.current.visible = true;
      reticleRef.current.position.copy(hitTest.tracker.position);
      reticleRef.current.quaternion.copy(hitTest.tracker.quaternion);
    }
  });

  return (
    <>
      <FrameModel
        ref={groupRef}
        product={product}
        art={art}
        style={style}
        ambient={ambient}
        // 0.85 enquanto segue o plano deixa claro que ainda não está fixado.
        opacity={placed || !options.autoPlaceOnPlane ? 1 : 0.85}
        visible={false}
        onMetrics={setMetrics}
      />
      {metrics && !options.autoPlaceOnPlane && (
        <Reticle
          ref={reticleRef}
          width={metrics.outer.w}
          height={metrics.outer.h}
          stable={stable}
          visible={false}
        />
      )}
    </>
  );
}
