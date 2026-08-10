'use client';

import { useEffect, useRef } from 'react';
import { ARController } from '../core/ARController';
import type { ARError } from '../core/errors';
import type { PlacementInfo, ProductData, ViewerOptions } from '../core/types';

export interface FrameViewerProps {
  product: ProductData;
  options?: Omit<ViewerOptions, 'onClose' | 'onPlace' | 'onError' | 'onReady'>;
  /**
   * Padrão false. Com false o overlay abre num estado inerte e a câmera só é
   * pedida quando o usuário toca em "Ver na minha parede" — que é o único jeito
   * correto de qualquer forma, porque `requestSession('immersive-ar')` exige
   * user activation. De quebra, neutraliza o double-mount do StrictMode.
   */
  autoStart?: boolean;
  onReady?: () => void;
  onPlace?: (info: PlacementInfo) => void;
  onError?: (error: ARError) => void;
  onClose?: () => void;
  className?: string;
}

export function FrameViewer(props: FrameViewerProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<ARController | null>(null);

  // Callbacks numa ref: um re-render do pai não pode derrubar a sessão de AR.
  const latest = useRef(props);
  latest.current = props;

  const { id, imageUrl, widthCm, heightCm } = props.product;

  // As demais props são lidas via `latest` de propósito: incluí-las nas
  // dependências derrubaria a sessão de AR a cada re-render do componente pai.
  // biome-ignore lint/correctness/useExhaustiveDependencies: ver acima
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const viewer = ARController.create({
      container: host,
      product: latest.current.product,
      options: {
        ...latest.current.options,
        autoStart: latest.current.autoStart ?? false,
        onReady: () => latest.current.onReady?.(),
        onPlace: (info) => latest.current.onPlace?.(info),
        onError: (error) => latest.current.onError?.(error),
        onClose: () => latest.current.onClose?.(),
      },
    });
    viewerRef.current = viewer;

    return () => {
      viewerRef.current = null;
      void viewer.destroy();
    };
    // Recria quando o produto muda de identidade. As demais props são lidas via
    // `latest`, então não entram nas dependências de propósito.
  }, [id, imageUrl, widthCm, heightCm]);

  return <div ref={hostRef} className={props.className} />;
}
