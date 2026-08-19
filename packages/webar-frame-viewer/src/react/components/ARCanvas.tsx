'use client';

import { Canvas } from '@react-three/fiber';
import { XR, type XRStore } from '@react-three/xr';
import { type RefObject, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { isLowEndDevice, pixelRatioCap } from '../../core/SceneManager';
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
 *
 * TODAS as props de configuração aqui são estáveis por construção. O layout
 * effect do `CanvasImpl` do R3F não tem array de dependências: ele refaz
 * `configure()` a cada render, e um literal inline em `gl` faz esse `configure`
 * chamar `applyProps(gl, …)` toda vez — a comparação interna nunca casa, porque
 * `WebGLRenderer` não expõe `alpha`, `antialias` nem `preserveDrawingBuffer`
 * como propriedades.
 */

/**
 * Estáveis, mas resolvidos na PRIMEIRA renderização e não na importação: as duas
 * sondas leem `navigator`, e o pacote não toca em global de navegador em escopo
 * de módulo — é o que o mantém importável num Server Component. Este componente
 * nunca chega a renderizar no servidor (o gate `ready` do `<FrameViewer>` exige
 * textura carregada e overlay montado), então aqui dentro a sonda é segura.
 */
let glOptions: {
  alpha: boolean;
  antialias: boolean;
  powerPreference: 'high-performance';
  preserveDrawingBuffer: boolean;
} | null = null;
let dpr: [number, number] | null = null;

function getGlOptions(): NonNullable<typeof glOptions> {
  // MSAA custa fillrate, e o `antialias` do contexto propaga para a
  // `XRWebGLLayer` (`three/src/renderers/webxr/WebXRManager.js`), portanto vale
  // dentro da sessão também. Nos aparelhos que já não dão conta, serrilhado na
  // moldura é preço melhor do que frame perdido.
  glOptions ??= {
    alpha: true,
    antialias: !isLowEndDevice(),
    powerPreference: 'high-performance',
    // A captura precisa acontecer no mesmo rAF do render — ver `useCapture`.
    preserveDrawingBuffer: false,
  };
  return glOptions;
}

/** Num aparelho com dpr 3, renderizar 5 quads a 3× é desperdício puro. */
function getDpr(): [number, number] {
  dpr ??= [1, pixelRatioCap()];
  return dpr;
}

function onCanvasCreated({ gl }: { gl: THREE.WebGLRenderer }): void {
  gl.setClearColor(0x000000, 0);
  gl.toneMapping = THREE.NoToneMapping;
  gl.outputColorSpace = THREE.SRGBColorSpace;
}

export interface ARCanvasProps {
  engine: SceneKind;
  xrStore: XRStore;
  videoRef: RefObject<HTMLVideoElement | null>;
  captureRef: RefObject<{ prepare(): void; share(): Promise<void> } | null>;
  captureFilename: string;
  /**
   * O usuário já pediu a experiência. Falso enquanto o overlay está em 'idle':
   * o canvas monta assim que a arte carrega — bem antes do toque, porque
   * `enterAR()` exige um `<XR>` já montado — e sem este gate ele ficaria
   * rodando o loop a 60 fps sobre uma cena vazia enquanto o usuário lê a tela.
   */
  active: boolean;
  children: React.ReactNode;
}

/**
 * Sem `memo` de propósito: este componente recebe `children`, cuja identidade
 * muda a cada render do pai, então a comparação rasa nunca casaria. O que
 * protege a árvore 3D é o `memo` das CENAS (`<XRScene>`, `<PassthroughScene>`),
 * cujas props são de fato estáveis — e o seletor do `<FrameViewer>`, que já
 * impede a maioria dos renders de chegarem até aqui.
 */
export function ARCanvas({
  engine,
  xrStore,
  videoRef,
  captureRef,
  captureFilename,
  active,
  children,
}: ARCanvasProps): React.ReactElement {
  const camera = useMemo(
    () => ({
      // 60° no XR (a sessão sobrescreve com o FOV real), 50° no passthrough
      // até o `usePassthrough` casar o frustum com a área visível do vídeo.
      fov: engine === 'webxr' ? 60 : 50,
      near: 0.05,
      far: 100,
    }),
    [engine],
  );

  return (
    <Canvas
      className="fv-canvas"
      flat
      dpr={getDpr()}
      frameloop={active ? 'always' : 'demand'}
      gl={getGlOptions()}
      camera={camera}
      onCreated={onCanvasCreated}
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
