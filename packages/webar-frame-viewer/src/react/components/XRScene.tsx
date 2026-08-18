'use client';

import { useFrame, useThree } from '@react-three/fiber';
import { useXR, useXRAnchor } from '@react-three/xr';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import type { LoadedTexture } from '../../core/AssetLoader';
import { GestureController } from '../../core/GestureController';
import { worldPerPixel } from '../../core/TransformUtils';
import type { FrameStyle, ProductData, ResolvedOptions } from '../../core/types';
import { ambientFromLightEstimate } from '../../core/xr/hitTest';
import type { ARApi } from '../hooks/useAR';
import { useTouchHitTest } from '../hooks/useTouchHitTest';
import { type FrameMetrics, FrameModel } from './FrameModel';
import { Reticle } from './Reticle';

/**
 * Cena do caminho WebXR (Android/ARCore): o usuário toca onde quer o quadro, o
 * hit-test qualifica aquele ponto e o toque ancora.
 *
 * Roda dentro de `<XR>`. Nada é posicionado sozinho: enquanto não há dedo na
 * tela a cena fica vazia. A resolução da pose sob o dedo mora em
 * `core/xr/touchHitTest`; aqui só há a ligação com o loop do R3F e com o estado
 * do React.
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

/**
 * Metros de mundo por pixel de tela, na distância dada.
 *
 * Lê o fator direto da matriz de projeção (`m[1][1] = 1/tan(fovV/2)`) em vez de
 * `camera.fov`: dentro da sessão quem renderiza é a câmera do WebXR, cujo FOV
 * vem do aparelho e não do valor que o R3F guarda na propriedade. Usar o `.fov`
 * ali deixaria o arraste com ganho errado — o quadro correria mais (ou menos) do
 * que o dedo. `worldPerPixel` continua servindo de reserva para uma projeção
 * degenerada.
 */
function wallMetersPerPixel(camera: THREE.Camera, distanceM: number, canvasH: number): number {
  const focal = camera.projectionMatrix.elements[5] ?? 0;
  if (focal > 0) return (2 * distanceM) / (focal * canvasH);
  return worldPerPixel(distanceM, (camera as THREE.PerspectiveCamera).fov ?? 60, canvasH);
}

export interface XRSceneProps {
  product: ProductData;
  art: LoadedTexture;
  style: Required<FrameStyle>;
  options: ResolvedOptions;
  api: ARApi;
  /** Elemento que captura o arraste de ajuste. Null até o palco montar. */
  stage: HTMLElement | null;
}

export function XRScene({
  product,
  art,
  style,
  options,
  api,
  stage,
}: XRSceneProps): React.ReactElement {
  const session = useXR((state) => state.session);
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);

  const groupRef = useRef<THREE.Group | null>(null);
  const reticleRef = useRef<THREE.Group | null>(null);
  const placedRef = useRef(false);
  const lightProbeRef = useRef<LightProbe | null>(null);
  /**
   * Pose do quadro ancorado, antes do ajuste fino. É a âncora quem a atualiza a
   * cada frame (correção de drift do ARCore); sem âncora concedida ela fica
   * parada no ponto do toque.
   */
  const basePositionRef = useRef(new THREE.Vector3());
  const baseQuaternionRef = useRef(new THREE.Quaternion());
  /**
   * Deslocamento acumulado pelo ajuste fino, em metros, SOMADO à pose base a
   * cada frame. Guardado à parte (em vez de escrito direto no grupo) porque a
   * âncora reescreve a pose continuamente — somar no grupo seria acumular sem
   * fim, e escrever na base seria perder a correção de drift.
   */
  const dragOffsetRef = useRef(new THREE.Vector3());
  /**
   * O espaço em que o three renderiza, guardado no loop. O handler de `select`
   * roda fora do `useFrame` e precisa dele para ler o raio do toque.
   */
  const referenceSpaceRef = useRef<XRReferenceSpace | null>(null);

  const [metrics, setMetrics] = useState<FrameMetrics | null>(null);
  const [ambient, setAmbient] = useState(1);
  /** Superfície de parede realmente detectada sob o dedo — pinta o contorno de verde. */
  const [onSurface, setOnSurface] = useState(false);
  // Par ref+state: a ref é lida no `useFrame`, o state é o que a interface vê.
  // Só com o state a opacidade sai de 0.85 e o cadeado aparece.
  const [placed, setPlaced] = useState(false);
  const [locked, setLocked] = useState(false);

  const [anchor, createAnchor] = useXRAnchor();

  const touch = useTouchHitTest({
    assumedWallDistanceM: options.assumedWallDistanceM,
    wallToleranceDeg: options.wallToleranceDeg,
    enabled: !placed,
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
    if (!group || !touch.activeRef.current) return;

    placedRef.current = true;
    setPlaced(true);
    // Ancorar não trava: o cadeado começa aberto para o ajuste fino.
    setLocked(false);
    dragOffsetRef.current.set(0, 0, 0);
    basePositionRef.current.copy(touch.position);
    baseQuaternionRef.current.copy(touch.quaternion);

    // Anchors reduzem materialmente o drift depois de 30 s parado — e o usuário
    // fica bastante tempo olhando para o quadro. Falha é aceitável: a feature
    // pode não ter sido concedida.
    void createAnchor({
      relativeTo: 'world',
      worldPosition: touch.position.clone(),
      worldQuaternion: touch.quaternion.clone(),
    }).catch(() => undefined);

    const cameraPosition = new THREE.Vector3();
    camera.getWorldPosition(cameraPosition);

    api.reportPlaced({
      distanceMeters: touch.position.distanceTo(cameraPosition),
      // A profundidade só é medida quando havia superfície de parede sob o dedo;
      // caso contrário foi a distância assumida, que é o mesmo que 'manual'.
      source: touch.qualityRef.current === 'plane' ? 'hit-test' : 'manual',
      position: { x: touch.position.x, y: touch.position.y, z: touch.position.z },
    });
  }, [api, camera, createAnchor, touch]);

  const reset = useCallback(() => {
    placedRef.current = false;
    setPlaced(false);
    setLocked(false);
    setOnSurface(false);
    dragOffsetRef.current.set(0, 0, 0);
    touch.restart();
    api.reportUnplaced();
  }, [api, touch]);

  /**
   * Travar recria a âncora onde o quadro realmente está. Sem isso, a correção de
   * drift do ARCore continuaria puxando o quadro para o ponto do toque original
   * e o ajuste fino escorreria de volta ao longo dos minutos.
   */
  const applyLock = useCallback(
    (next: boolean) => {
      if (next) {
        // A base absorve o ajuste e o offset zera. Isso vale mesmo se a âncora
        // não for concedida: a pose final é a mesma, só sem correção de drift.
        basePositionRef.current.add(dragOffsetRef.current);
        dragOffsetRef.current.set(0, 0, 0);
        void createAnchor({
          relativeTo: 'world',
          worldPosition: basePositionRef.current.clone(),
          worldQuaternion: baseQuaternionRef.current.clone(),
        }).catch(() => undefined);
      }
      setLocked(next);
      api.setLocked(next);
    },
    [api, createAnchor],
  );

  /**
   * O dedo encostado mira; soltar ancora.
   *
   * `selectstart` reinicia a suavização — sem isso o quadro escorregaria desde o
   * ponto do toque anterior até o novo. Depois de ancorado o toque não faz mais
   * nada: antes, um toque acidental devolvia o quadro a seguir a câmera, que é
   * exatamente a sensação de "o quadro não trava". Ajustar é arrastando,
   * congelar é no cadeado.
   */
  useEffect(() => {
    if (!session) return;
    const onSelectStart = (): void => {
      if (placedRef.current) return;
      touch.begin();
      api.setHint('hold-to-aim');
    };
    const onSelect = (event: XRInputSourceEvent): void => {
      if (placedRef.current) return;
      const referenceSpace = referenceSpaceRef.current;
      if (!touch.activeRef.current && referenceSpace) {
        touch.resolveFromEvent(event, referenceSpace);
      }
      if (touch.activeRef.current) place();
      else api.setHint('tap-to-place');
    };
    session.addEventListener('selectstart', onSelectStart);
    session.addEventListener('select', onSelect);
    return () => {
      session.removeEventListener('selectstart', onSelectStart);
      session.removeEventListener('select', onSelect);
    };
  }, [session, place, touch, api]);

  useEffect(() => {
    api.registerReposition(reset);
    return () => api.registerReposition(null);
  }, [api, reset]);

  useEffect(() => {
    api.registerLock(applyLock);
    return () => api.registerLock(null);
  }, [api, applyLock]);

  /**
   * Ajuste fino: arrastar o dedo desliza o quadro NO PLANO DA PAREDE.
   *
   * Os eixos vêm do quaternion do próprio grupo (X e Y locais são o plano da
   * parede, +Z é a normal), e não da câmera como no passthrough: assim uma
   * diagonal escorrega pela parede em vez de descolar o quadro dela.
   *
   * Só existe entre ancorar e travar — fora dessa janela o controlador nem é
   * anexado, então nenhum toque perdido move nada.
   */
  const latest = useRef({ camera, size });
  latest.current = { camera, size };

  useEffect(() => {
    if (!stage || !placed || locked) return;

    const gestures = new GestureController(
      stage,
      {
        onPan(dxPx, dyPx) {
          const group = groupRef.current;
          if (!group) return;

          const cameraPosition = new THREE.Vector3();
          latest.current.camera.getWorldPosition(cameraPosition);
          const worldPosition = new THREE.Vector3();
          group.getWorldPosition(worldPosition);

          const perPixel = wallMetersPerPixel(
            latest.current.camera,
            cameraPosition.distanceTo(worldPosition),
            latest.current.size.height || 1,
          );

          const right = new THREE.Vector3(1, 0, 0).applyQuaternion(group.quaternion);
          const up = new THREE.Vector3(0, 1, 0).applyQuaternion(group.quaternion);
          dragOffsetRef.current
            .addScaledVector(right, dxPx * perPixel)
            .addScaledVector(up, -dyPx * perPixel);
        },
      },
      // Pinça e rotação ficam de fora: no WebXR a distância é medida de verdade
      // pelo hit-test e o prumo vem da parede. Mexer neles aqui seria mentir.
      { move: true, scale: false, rotate: false },
    );

    gestures.attach();
    return () => gestures.detach();
  }, [stage, placed, locked]);

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

    const referenceSpace = (
      _state.gl.xr as THREE.WebXRManager & {
        getReferenceSpace(): XRReferenceSpace | null;
      }
    ).getReferenceSpace();
    referenceSpaceRef.current = referenceSpace;

    // --- já ancorado: a âncora manda, o ajuste fino soma -------------------
    if (placedRef.current) {
      if (anchor && xrFrame) {
        const pose = referenceSpace ? xrFrame.getPose(anchor.anchorSpace, referenceSpace) : null;
        if (pose) {
          const { position, orientation } = pose.transform;
          basePositionRef.current.set(position.x, position.y, position.z);
          baseQuaternionRef.current.set(orientation.x, orientation.y, orientation.z, orientation.w);
        }
      }
      // Sempre base + offset, nunca soma no grupo: o grupo é recomposto todo
      // frame, então acumular nele cresceria sem limite quando a âncora não
      // existe. Ao travar o offset é absorvido pela base e zerado.
      group.position.copy(basePositionRef.current).add(dragOffsetRef.current);
      group.quaternion.copy(baseQuaternionRef.current);
      group.visible = true;
      // O contorno era o feedback da mira; fixado o quadro, ele só polui.
      if (reticleRef.current) reticleRef.current.visible = false;
      return;
    }

    // --- mira: só existe enquanto o dedo está na tela ----------------------
    if (xrFrame && referenceSpace) touch.update(xrFrame, referenceSpace);

    const active = touch.activeRef.current;
    group.visible = active;
    if (reticleRef.current) reticleRef.current.visible = active;
    if (!active) return;

    group.position.copy(touch.position);
    group.quaternion.copy(touch.quaternion);
    if (reticleRef.current) {
      reticleRef.current.position.copy(touch.position);
      reticleRef.current.quaternion.copy(touch.quaternion);
    }

    const detected = touch.qualityRef.current === 'plane';
    if (detected !== onSurface) setOnSurface(detected);
  });

  return (
    <>
      <FrameModel
        ref={groupRef}
        product={product}
        art={art}
        style={style}
        ambient={ambient}
        // 0.85 sob o dedo deixa claro que ainda não está fixado.
        opacity={placed ? 1 : 0.85}
        visible={false}
        onMetrics={setMetrics}
      />
      {metrics && (
        <Reticle
          ref={reticleRef}
          width={metrics.outer.w}
          height={metrics.outer.h}
          stable={onSurface}
          visible={false}
        />
      )}
    </>
  );
}
