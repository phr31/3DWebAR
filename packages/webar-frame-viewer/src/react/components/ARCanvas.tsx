'use client';

import { Canvas } from '@react-three/fiber';
import { XR, type XRStore } from '@react-three/xr';
import { type RefObject, useEffect } from 'react';
import * as THREE from 'three';
import { pixelRatioCap } from '../../core/SceneManager';
import type { SceneKind } from '../../core/types';
import { useCapture } from '../hooks/useCapture';

/**
 * O `<Canvas>` do R3F configurado como o `createRenderer` de `core/SceneManager`.
 *
 * As opções não são estilo: `alpha` deixa a câmera aparecer atrás, e
 * `NoToneMapping` é requisito de produto — o padrão do R3F é ACESFilmic, que
 * deslocaria a cor da impressão e faria o quadro no AR não bater com a foto do
 * catálogo. O `flat` é justamente o atalho do R3F para NoToneMapping.
 *
 * No caminho WebXR o conteúdo é envolvido por `<XR>`; no passthrough não há
 * sessão, é um canvas transparente comum sobre o `<video>`.
 */

export interface ARCanvasProps {
  engine: SceneKind;
  xrStore: XRStore;
  videoRef: RefObject<HTMLVideoElement | null>;
  captureRef: RefObject<{ prepare(): void; share(): Promise<void> } | null>;
  captureFilename: string;
  children: React.ReactNode;
}

export function ARCanvas({
  engine,
  xrStore,
  videoRef,
  captureRef,
  captureFilename,
  children,
}: ARCanvasProps): React.ReactElement {
  return (
    <Canvas
      className="fv-canvas"
      flat
      dpr={[1, pixelRatioCap()]}
      gl={{
        alpha: true,
        antialias: true,
        powerPreference: 'high-performance',
        // A captura precisa acontecer no mesmo rAF do render — ver `useCapture`.
        preserveDrawingBuffer: false,
      }}
      camera={{
        // 60° no XR (a sessão sobrescreve com o FOV real), 50° no passthrough
        // até o `usePassthrough` casar o frustum com a área visível do vídeo.
        fov: engine === 'webxr' ? 60 : 50,
        near: 0.05,
        far: 100,
      }}
      onCreated={({ gl }) => {
        gl.setClearColor(0x000000, 0);
        gl.toneMapping = THREE.NoToneMapping;
        gl.outputColorSpace = THREE.SRGBColorSpace;
      }}
    >
      <CaptureBridge
        videoRef={videoRef}
        captureRef={captureRef}
        filename={captureFilename}
        enabled={engine === 'passthrough'}
      />
      {engine === 'webxr' ? <XR store={xrStore}>{children}</XR> : children}
    </Canvas>
  );
}

/**
 * `useCapture` precisa do renderer, que só existe dentro do `<Canvas>`. O botão
 * de foto vive no overlay, fora dele. Este componente é a ponte: publica as duas
 * funções numa ref que o `<FrameViewer>` já segura.
 */
function CaptureBridge({
  videoRef,
  captureRef,
  filename,
  enabled,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  captureRef: RefObject<{ prepare(): void; share(): Promise<void> } | null>;
  filename: string;
  enabled: boolean;
}): null {
  const capture = useCapture({ videoRef, filename });

  useEffect(() => {
    captureRef.current = enabled ? capture : null;
    return () => {
      captureRef.current = null;
    };
  }, [capture, captureRef, enabled]);

  return null;
}
