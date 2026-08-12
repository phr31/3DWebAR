'use client';

import { useFrame } from '@react-three/fiber';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import type * as THREE from 'three';
import type { LoadedTexture } from '../../core/AssetLoader';
import type { ARError } from '../../core/errors';
import type { FrameStyle, ProductData, ResolvedOptions } from '../../core/types';
import type { ARApi } from '../hooks/useAR';
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

export function PassthroughScene({
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
  const [ambient, setAmbient] = useState(1);
  const readyReportedRef = useRef(false);

  const onError = useCallback((error: ARError) => api.fail(error, 'camera'), [api]);
  const onLost = useCallback(() => api.fail(new Error('camera track ended'), 'runtime'), [api]);

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
      api.reportPlaced(info);
    },
  });

  // O passthrough é o único engine que consegue capturar: o vídeo e o canvas
  // WebGL são ambos nossos, então dá para compor os dois.
  useEffect(() => {
    api.setHint(options.autoPlaceOnPlane ? 'drag-to-move' : 'tap-to-place');
  }, [api, options.autoPlaceOnPlane]);

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

    placement.apply(group, placedRef.current);
  });

  return (
    <FrameModel
      ref={groupRef}
      product={product}
      art={art}
      style={style}
      ambient={ambient}
      opacity={placed || !options.autoPlaceOnPlane ? 1 : 0.85}
    />
  );
}
