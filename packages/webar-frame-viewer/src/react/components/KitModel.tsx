'use client';

import { forwardRef, memo, useEffect, useMemo } from 'react';
import type * as THREE from 'three';
import type { LoadedTexture } from '../../core/AssetLoader';
import { FRAME_LIGHTS, type FrameMetrics, itemMetrics } from '../../core/FrameBuilder';
import { itemPosition, itemStyle, kitBounds, kitMetrics } from '../../core/kitLayout';
import type { FrameStyle, KitItem } from '../../core/types';
import { FrameModel } from './FrameModel';

/**
 * O conjunto de quadros, declarativo. Contraparte R3F do `buildKit` de
 * `core/KitBuilder`, que segue existindo para o build UMD.
 *
 * O grupo externo obedece ao MESMO contrato de pivô do quadro solto — centro do
 * conjunto na face de trás, +Z saindo da parede — e é isso que deixa
 * `XRScene`/`PassthroughScene` continuarem escrevendo `group.position` de um
 * objeto só. Hit-test, âncora, gestos, retículo e `tapHitsFrame` não mudam:
 * eles passam a enxergar o bounding box porque é ele que `onMetrics` reporta.
 *
 * Um kit de uma peça é idêntico a um quadro solto — `kitMetrics` devolve as
 * métricas da própria peça, sem agregação.
 */

export interface KitModelProps {
  items: KitItem[];
  /** Uma textura por peça, na mesma ordem. */
  arts: LoadedTexture[];
  /** Estilo do conjunto. Cada peça pode sobrescrever chaves via `item.frame`. */
  style: Required<FrameStyle>;
  /** 0.85 enquanto "seguindo" o plano, 1 depois de fixado. */
  opacity?: number;
  visible?: boolean;
  ambient?: number;
  /** Métricas do CONJUNTO: `outer` é o bounding box. */
  onMetrics?(metrics: FrameMetrics): void;
}

const KitModelImpl = forwardRef<THREE.Group, KitModelProps>(function KitModel(
  { items, arts, style, opacity = 1, visible = true, ambient = 1, onMetrics },
  ref,
) {
  /**
   * Peças casadas com suas texturas, posição local e estilo efetivo.
   *
   * Calculado de uma vez porque o bounding box depende de TODAS as peças: não dá
   * para cada `<FrameModel>` descobrir sozinho onde fica. As métricas por peça
   * saem de `itemMetrics`, a mesma função que o `buildFrame` usa para reportar
   * as dele.
   */
  const parts = useMemo(() => {
    const bounds = kitBounds(items);
    const resolved = items.map((item, i) => {
      const art = arts[i];
      const effective = itemStyle(style, item);
      return {
        item,
        art,
        style: effective,
        position: itemPosition(item, bounds),
        metrics: art ? itemMetrics(item, art, effective) : null,
      };
    });

    return {
      resolved,
      metrics: kitMetrics(
        items,
        resolved.flatMap((part) => (part.metrics ? [part.metrics] : [])),
      ),
    };
  }, [items, arts, style]);

  useEffect(() => {
    onMetrics?.(parts.metrics);
  }, [parts.metrics, onMetrics]);

  return (
    <group ref={ref} visible={visible}>
      {parts.resolved.map(
        (part) =>
          part.art && (
            <FrameModel
              key={part.item.id}
              product={part.item}
              art={part.art}
              style={part.style}
              position={part.position}
              opacity={opacity}
              ambient={ambient}
              // As luzes sobem para cá: N peças dariam 2N luzes na cena, e cada
              // contagem nova recompila o shader da moldura.
              lights={false}
            />
          ),
      )}

      <ambientLight intensity={FRAME_LIGHTS.ambientIntensity} />
      <directionalLight
        intensity={FRAME_LIGHTS.directionalIntensity}
        position={FRAME_LIGHTS.directionalPosition}
      />
    </group>
  );
});

/**
 * Memo pelo mesmo motivo do `<FrameModel>`: o elemento é filho do `<Canvas>`, e
 * o layout effect do R3F reconcilia a árvore inteira a cada render de quem
 * hospeda o canvas.
 */
export const KitModel = memo(KitModelImpl);
