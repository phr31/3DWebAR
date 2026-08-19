'use client';

import { useFrame, useThree } from '@react-three/fiber';
import { type RefObject, useRef } from 'react';

/**
 * Custo por frame para o HUD de `options.debug`.
 *
 * Escreve numa ref e não no store: o número muda a cada frame, e mandá-lo para o
 * estado do React seria criar, para medir performance, exatamente o re-render
 * por frame que este trabalho existe para eliminar. Quem consome lê a ref no
 * próprio bloco de 4 Hz que já tem.
 *
 * Os valores de `gl.info` são do frame ANTERIOR: `renderer.info` é zerado no
 * início de cada `render()`, e o `useFrame` roda antes dele. Para um HUD isso é
 * o que se quer — o número mostrado corresponde a um frame completo.
 */

/** Período de atualização do HUD. 4 Hz é legível e não gera render à toa. */
export const DEBUG_INTERVAL_MS = 250;

export interface FrameStats {
  /** Média móvel do tempo de frame, em ms. */
  frameMs: number;
  calls: number;
  tris: number;
  textures: number;
}

/**
 * Peso da média móvel. 0.1 estabiliza o número o bastante para ser lido em
 * movimento, sem esconder um engasgo de verdade.
 */
const SMOOTHING = 0.1;

export function useFrameStats(enabled: boolean): RefObject<FrameStats> {
  const gl = useThree((state) => state.gl);
  const stats = useRef<FrameStats>({ frameMs: 0, calls: 0, tris: 0, textures: 0 });

  useFrame((_state, delta) => {
    if (!enabled) return;

    const current = stats.current;
    const ms = delta * 1000;
    // No primeiro frame copia em vez de interpolar: partindo de zero, a média
    // levaria segundos para alcançar o valor real e o HUD mentiria justamente
    // durante a abertura da sessão, que é quando mais se olha para ele.
    current.frameMs =
      current.frameMs === 0 ? ms : current.frameMs + (ms - current.frameMs) * SMOOTHING;

    const { render, memory } = gl.info;
    current.calls = render.calls;
    current.tris = render.triangles;
    current.textures = memory.textures;
  });

  return stats;
}
