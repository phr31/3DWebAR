'use client';

import { useThree } from '@react-three/fiber';
import { type RefObject, useCallback, useMemo, useRef } from 'react';
import { composeCapture, shareOrDownload } from '../../core/capture';

/**
 * Screenshot do passthrough: compõe o `<video>` com o canvas WebGL e entrega
 * para o `navigator.share`.
 *
 * Duas restrições moldam a forma deste hook e não são negociáveis:
 *
 * 1. `preserveDrawingBuffer: false` — o canvas só contém pixels válidos DENTRO
 *    do frame em que foi desenhado. Por isso o `render()` e a composição
 *    acontecem juntos, dentro de um mesmo `requestAnimationFrame`.
 * 2. `navigator.share` exige transient activation. Se esperássemos o blob ficar
 *    pronto durante o `click`, a ativação já teria expirado — daí `prepare()` no
 *    `pointerdown` e `share()` no `click`.
 *
 * No WebXR não há captura: dentro de uma `XRSession` o render vai para o
 * framebuffer do compositor e a imagem da câmera nunca esteve no nosso. Quem
 * chama decide pelo `canCapture` — aqui só existe o caminho do passthrough.
 */

export interface CaptureOptions {
  videoRef: RefObject<HTMLVideoElement | null>;
  filename: string;
}

export interface CaptureResult {
  /** Ligue no `pointerdown` do botão de foto. */
  prepare(): void;
  /** Ligue no `click` do botão de foto. */
  share(): Promise<void>;
}

export function useCapture({ videoRef, filename }: CaptureOptions): CaptureResult {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);
  const pending = useRef<Promise<Blob | null> | null>(null);

  const latest = useRef({ filename });
  latest.current = { filename };

  const prepare = useCallback(() => {
    const video = videoRef.current;
    if (!video?.srcObject) return;

    pending.current = new Promise<Blob | null>((resolve) => {
      requestAnimationFrame(() => {
        gl.render(scene, camera);
        composeCapture(video, gl).then(resolve, () => resolve(null));
      });
    });
  }, [gl, scene, camera, videoRef]);

  const share = useCallback(async () => {
    const promise = pending.current;
    pending.current = null;
    if (!promise) return;
    const blob = await promise;
    if (blob) await shareOrDownload(blob, latest.current.filename);
  }, []);

  return useMemo(() => ({ prepare, share }), [prepare, share]);
}
