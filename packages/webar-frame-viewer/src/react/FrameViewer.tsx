'use client';

import { createXRStore } from '@react-three/xr';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ARError } from '../core/errors';
import { ARError as ARErrorClass } from '../core/errors';
import { resolveOptions, validateProduct } from '../core/options';
import type { PlacementInfo, ProductData, SceneKind, ViewerOptions } from '../core/types';
import { createStrings } from '../ui/strings';
import { ARCanvas } from './components/ARCanvas';
import { Overlay } from './components/Overlay';
import { PassthroughScene } from './components/PassthroughScene';
import { XRScene } from './components/XRScene';
import { useAR } from './hooks/useAR';
import { useArtTexture } from './hooks/useArtTexture';
import { createViewerStore, useViewerState, ViewerStoreContext } from './store';

/**
 * Visualizador de quadros em AR, declarativo.
 *
 * Android/Chrome entra em `immersive-ar` com hit-test (via @react-three/xr);
 * iOS e qualquer aparelho sem WebXR usam passthrough com giroscópio e gestos.
 * A escolha é automática — `options.engine` só existe para QA.
 */

export interface FrameViewerProps {
  product: ProductData;
  options?: Omit<ViewerOptions, 'onClose' | 'onPlace' | 'onError' | 'onReady'>;
  /**
   * Padrão false. Com false a câmera só é pedida quando o usuário toca em
   * "Ver na minha parede" — que é o único jeito correto de qualquer forma,
   * porque `requestSession('immersive-ar')` exige user activation. De quebra,
   * neutraliza o double-mount do StrictMode.
   */
  autoStart?: boolean;
  onReady?: () => void;
  onPlace?: (info: PlacementInfo) => void;
  onError?: (error: ARError) => void;
  onClose?: () => void;
  className?: string;
}

export function FrameViewer(props: FrameViewerProps): React.ReactElement {
  // Um store por instância: dois viewers na mesma página não podem compartilhar
  // estado. `useState` com inicializador só cria uma vez, inclusive no StrictMode.
  const [store] = useState(() => createViewerStore());

  return (
    <ViewerStoreContext.Provider value={store}>
      <FrameViewerInner {...props} />
    </ViewerStoreContext.Provider>
  );
}

function FrameViewerInner({
  product,
  options: rawOptions,
  autoStart = false,
  onReady,
  onPlace,
  onError,
  onClose,
  className,
}: FrameViewerProps): React.ReactElement {
  const state = useViewerState();

  const options = useMemo(() => resolveOptions(rawOptions), [rawOptions]);
  const t = useMemo(
    () => createStrings(options.locale, rawOptions?.strings),
    [options.locale, rawOptions?.strings],
  );

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const captureRef = useRef<{ prepare(): void; share(): Promise<void> } | null>(null);
  // Elemento, não ref: o `usePassthroughPlacement` precisa reagir à montagem
  // para anexar os gestos, e mudanças em `.current` não disparam render.
  const [stage, setStage] = useState<HTMLDivElement | null>(null);

  const api = useAR({ options, t, onReady, onPlace, onError, onClose });

  /**
   * `domOverlay` recebe o elemento do overlay: sem isso os botões somem quando a
   * sessão `immersive-ar` assume a tela. A store é criada uma vez por instância.
   */
  const xrStore = useMemo(
    () =>
      createXRStore({
        hitTest: true,
        anchors: true,
        domOverlay: true,
        // `local-floor` não precisa ser pedido: o @react-three/xr já o inclui
        // em `requiredFeatures`, que é exatamente o que o engine antigo fazia
        // com `setReferenceSpaceType('local-floor')`.
        //
        // Este é um fluxo de celular: nada de controles, mãos ou raios.
        controller: false,
        hand: false,
      }),
    [],
  );

  const enterXR = useCallback(() => xrStore.enterAR(), [xrStore]);

  useEffect(() => {
    api.setEnterXR(enterXR);
  }, [api, enterXR]);

  const art = useArtTexture(product.imageUrl);

  // Produto inválido é erro de integração, não de ambiente: falha cedo e claro.
  useEffect(() => {
    const problem = validateProduct(product);
    if (problem) api.fail(new ARErrorClass('INVALID_PRODUCT', problem), 'env');
  }, [product, api]);

  useEffect(() => {
    if (art.error) api.fail(art.error, 'asset');
  }, [art.error, api]);

  const handleStart = useCallback(() => {
    void api.start(enterXR);
  }, [api, enterXR]);

  // `autoStart` num macrotask: o double-invoke do StrictMode é síncrono dentro
  // do commit, então um timeout de 0 ms cai depois dele.
  useEffect(() => {
    if (!autoStart) return;
    const timer = window.setTimeout(handleStart, 0);
    return () => window.clearTimeout(timer);
  }, [autoStart, handleStart]);

  const handlePhotoPrepare = useCallback(() => captureRef.current?.prepare(), []);
  const handlePhoto = useCallback(() => void captureRef.current?.share(), []);

  /**
   * O canvas monta assim que a arte carrega, antes mesmo de o usuário tocar em
   * iniciar. É obrigatório: `xrStore.enterAR()` só funciona com um `<XR>` já
   * montado, e chamá-lo depois de um await queimaria a user activation.
   */
  const engine: SceneKind | null =
    state.status === 'destroyed' ? null : (state.engine ?? api.capabilities?.recommended ?? null);

  const ready = art.art !== null && engine !== null;

  return (
    <div className={className}>
      <Overlay
        t={t}
        title={product.title}
        videoRef={videoRef}
        stageRef={setStage}
        onStart={handleStart}
        onClose={api.close}
        onPhotoPrepare={handlePhotoPrepare}
        onPhoto={handlePhoto}
      >
        {ready && art.art && (
          <ARCanvas
            engine={engine}
            xrStore={xrStore}
            videoRef={videoRef}
            captureRef={captureRef}
            captureFilename={`quadro-${product.id || 'ar'}.jpg`}
          >
            {engine === 'webxr' ? (
              <XRScene
                product={product}
                art={art.art}
                style={options.frame}
                options={options}
                api={api}
              />
            ) : (
              // Só pede a câmera depois do toque: `status` sai de 'idle'.
              state.status !== 'idle' && (
                <PassthroughScene
                  product={product}
                  art={art.art}
                  style={options.frame}
                  options={options}
                  api={api}
                  videoRef={videoRef}
                  stage={stage}
                />
              )
            )}
          </ARCanvas>
        )}
      </Overlay>
    </div>
  );
}
