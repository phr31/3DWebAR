'use client';

import { useFrame } from '@react-three/fiber';
import { memo, type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import type * as THREE from 'three';
import type { LoadedTexture } from '../../core/AssetLoader';
import type { ARError } from '../../core/errors';
import type { YawStatus } from '../../core/passthrough/orientation';
import type { FrameStyle, ProductData, ResolvedOptions } from '../../core/types';
import type { ARApi } from '../hooks/useAR';
import { DEBUG_INTERVAL_MS, useFrameStats } from '../hooks/useFrameStats';
import { usePassthrough } from '../hooks/usePassthrough';
import { usePassthroughPlacement } from '../hooks/usePassthroughPlacement';
import { FrameModel } from './FrameModel';

/**
 * Cena do caminho de passthrough (iOS e qualquer aparelho sem WebXR).
 *
 * Sem sessão XR: o `<video>` fica atrás do canvas transparente, a câmera é
 * orientada pelo giroscópio (3-DoF, sem paralaxe) e o posicionamento é por
 * gestos. É o único caminho onde a captura de tela funciona.
 */

export interface PassthroughSceneProps {
  product: ProductData;
  art: LoadedTexture;
  style: Required<FrameStyle>;
  options: ResolvedOptions;
  api: ARApi;
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Elemento que captura os gestos. Null até o palco montar. */
  stage: HTMLElement | null;
}

function PassthroughSceneImpl({
  product,
  art,
  style,
  options,
  api,
  videoRef,
  stage,
}: PassthroughSceneProps): React.ReactElement {
  const groupRef = useRef<THREE.Group | null>(null);
  const placedRef = useRef(false);
  const [placed, setPlaced] = useState(false);
  const [locked, setLocked] = useState(false);
  const [ambient, setAmbient] = useState(1);
  const [yaw, setYaw] = useState<YawStatus>('unknown');
  const readyReportedRef = useRef(false);
  const lastDebugAtRef = useRef(0);

  const onError = useCallback((error: ARError) => api.fail(error, 'camera'), [api]);
  const onLost = useCallback(() => api.fail(new Error('camera track ended'), 'runtime'), [api]);

  const stats = useFrameStats(options.debug);

  const passthrough = usePassthrough({
    videoRef,
    options,
    enabled: true,
    onError,
    onLost,
    onAmbient: setAmbient,
  });

  const placement = usePassthroughPlacement({
    target: stage,
    options,
    onPlace: (info) => {
      placedRef.current = true;
      setPlaced(true);
      setLocked(false);
      api.reportPlaced(info);
    },
  });

  // "Reposicionar" reinicia: solta o quadro e volta ao começo do fluxo. A posição
  // atual é preservada — quem reposiciona continua de onde parou, e não do
  // centro.
  useEffect(() => {
    api.registerReposition(() => {
      placedRef.current = false;
      placement.unplace();
      setPlaced(false);
      setLocked(false);
      api.reportUnplaced();
    });
    return () => api.registerReposition(null);
  }, [api, placement]);

  // O cadeado não mexe na âncora aqui: no passthrough travar é só fechar os
  // gestos, e destravar é reabri-los sem mover nada.
  useEffect(() => {
    api.registerLock((next) => {
      placement.setLocked(next);
      setLocked(next);
      api.setLocked(next);
    });
    return () => api.registerLock(null);
  }, [api, placement]);

  useEffect(() => {
    // Ancorado e destravado: a dica passa a ser o ajuste fino. Travado, o texto
    // vem do `setLocked` no `useAR` e não deve ser sobrescrito aqui.
    if (placed) {
      if (!locked) api.setHint('adjust');
      return;
    }
    // Sem guinada não existe rastreamento horizontal: dizer isso vale mais do que
    // repetir "arraste para mover".
    if (yaw === 'dead') {
      api.setHint('no-yaw');
      return;
    }
    api.setHint('tap-to-place');
  }, [api, placed, locked, yaw]);

  useFrame((_state, _delta) => {
    const group = groupRef.current;
    if (!group) return;

    const now = performance.now();
    passthrough.update(now);

    // A câmera só está "pronta" quando o stream chegou; até lá o overlay fica
    // em 'loading' para não mostrar um quadro flutuando sobre tela preta.
    if (passthrough.readyRef.current && !readyReportedRef.current) {
      readyReportedRef.current = true;
      api.reportEngineReady('passthrough', true);
    }

    // Amostragem throttled: ler o sensor a 60 Hz para a interface só geraria
    // render à toa.
    if (now - lastDebugAtRef.current >= DEBUG_INTERVAL_MS) {
      lastDebugAtRef.current = now;
      const current = passthrough.yawRef.current;
      if (current !== yaw) setYaw(current);
      if (options.debug) {
        api.setDebug({
          engine: 'passthrough',
          hasOrientation: passthrough.hasOrientationRef.current,
          angles: passthrough.anglesRef.current,
          yaw: current,
          ...stats.current,
        });
      }
    }

    placement.apply(group, placedRef.current);
  });

  return (
    <FrameModel
      ref={groupRef}
      product={product}
      art={art}
      style={style}
      ambient={ambient}
      // 0.85 sob o dedo deixa claro que ainda não está fixado. A visibilidade em
      // si é do `placement.apply`, que sabe se já houve toque.
      opacity={placed ? 1 : 0.85}
      visible={false}
    />
  );
}

/**
 * Memo: o elemento é filho do `<Canvas>`, que o R3F reconcilia a cada render do
 * componente que o hospeda. Todas as props aqui já são estáveis (`api` sai de um
 * `useMemo`, `style` é `options.frame`), então a comparação rasa acerta sempre.
 */
export const PassthroughScene = memo(PassthroughSceneImpl);
