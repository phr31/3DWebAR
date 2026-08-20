import type { FrameMetrics } from './FrameBuilder';
import { cmToM } from './TransformUtils';
import type { FrameStyle, KitItem } from './types';

/**
 * Arranjo e medidas de um kit. Módulo de aritmética pura: não importa `three`,
 * não toca no DOM e não conhece React — é o que permite as MESMAS contas
 * servirem ao `buildKit` (UMD) e ao `<KitModel>` (R3F) sem risco de divergirem,
 * e é o que o mantém barato no bundle de `<script>`.
 *
 * O import de `FrameBuilder` é só de TIPO, e de propósito: este módulo entra em
 * `core.mjs` (a entrada server-safe, com orçamento de 30 KB) via `public.ts`, e
 * um import de runtime arrastaria a construção da moldura inteira para lá. Por
 * isso `itemMetrics` mora no `FrameBuilder`, não aqui.
 *
 * Convenção de coordenadas, igual à do plano da parede: centímetros, +X à
 * direita, +Y para cima, origem no centro do conjunto.
 */

/**
 * - `row`: lado a lado, centros na mesma altura.
 * - `stack`: empilhado na vertical, centros no mesmo eixo.
 * - `grid`: células uniformes do tamanho da maior peça, preenchidas da esquerda
 *   para a direita e de cima para baixo.
 */
export type KitLayout = 'row' | 'stack' | 'grid';

export interface KitLayoutOptions {
  layout: KitLayout;
  /** Vão entre as BORDAS das peças, em cm. Padrão 6. */
  gapCm?: number;
  /** Só para `grid`. Padrão: a raiz quadrada arredondada para cima. */
  columns?: number;
}

const DEFAULT_GAP_CM = 6;

/**
 * Preenche `offsetXCm`/`offsetYCm` a partir de um preset, CENTRADOS na origem.
 *
 * Não sobrescreve quem já tem offset: o preset é conveniência, e um arranjo de
 * galeria assimétrico continua possível escrevendo os números à mão. Devolve um
 * array NOVO — os itens de entrada não são mutados.
 *
 * O recentro aqui é redundante para o RENDER (`kitBounds` recentra de novo, e é
 * o que faz offsets manuais valerem tanto quanto estes), mas não para o DADO:
 * uma fileira de três sai `-56, 0, 56` em vez de `25, 81, 137`, que é o que
 * alguém lendo o JSON — ou persistindo o arranjo no catálogo — espera ver.
 */
export function layoutKit(items: KitItem[], options: KitLayoutOptions): KitItem[] {
  const gap = options.gapCm ?? DEFAULT_GAP_CM;
  const placed = positions(items, options.layout, gap, options.columns);

  // Centro do arranjo GERADO. Com offsets manuais na jogada o resultado é uma
  // mistura, e aí quem dá a palavra final continua sendo o `kitBounds` do render.
  const center = kitBounds(
    items.map((item, i) => ({
      ...item,
      offsetXCm: placed[i]?.x ?? 0,
      offsetYCm: placed[i]?.y ?? 0,
    })),
  );

  return items.map((item, i) => {
    const at = placed[i] ?? { x: 0, y: 0 };
    return {
      ...item,
      offsetXCm: item.offsetXCm ?? at.x - center.centerXCm,
      offsetYCm: item.offsetYCm ?? at.y - center.centerYCm,
    };
  });
}

function positions(
  items: KitItem[],
  layout: KitLayout,
  gap: number,
  columns?: number,
): Array<{ x: number; y: number }> {
  if (layout === 'row') {
    let cursor = 0;
    return items.map((item) => {
      const x = cursor + item.widthCm / 2;
      cursor += item.widthCm + gap;
      return { x, y: 0 };
    });
  }

  if (layout === 'stack') {
    let cursor = 0;
    return items.map((item) => {
      const y = cursor - item.heightCm / 2;
      cursor -= item.heightCm + gap;
      return { x: 0, y };
    });
  }

  // Grid: células uniformes do tamanho da maior peça. Para o caso comum de um
  // kit de impressões iguais isso é exato; com tamanhos mistos cada peça fica
  // centrada na própria célula, que é o alinhamento que se espera de uma
  // composição em grade.
  const cols = Math.max(1, columns ?? Math.ceil(Math.sqrt(items.length)));
  const cellW = Math.max(...items.map((i) => i.widthCm)) + gap;
  const cellH = Math.max(...items.map((i) => i.heightCm)) + gap;

  return items.map((_item, i) => ({
    x: (i % cols) * cellW,
    y: -Math.floor(i / cols) * cellH,
  }));
}

export interface KitBounds {
  /** Bounding box do conjunto, em cm. */
  widthCm: number;
  heightCm: number;
  /** Profundidade da peça mais funda. */
  depthCm: number;
  /** Centro do bounding box, em cm — o que a renderização subtrai dos offsets. */
  centerXCm: number;
  centerYCm: number;
}

/**
 * Bounding box do conjunto e seu centro.
 *
 * O centro é o que faz offsets escritos à mão valerem tanto quanto os do preset:
 * a renderização SEMPRE subtrai o centro, então `0, 60, 120` e `-60, 0, 60`
 * produzem a mesma cena. Isso importa porque o pivô do grupo do kit tem de cair
 * no meio do conjunto — é ele que a âncora posiciona e é dele que saem o
 * retículo e a área de toque.
 */
export function kitBounds(items: KitItem[]): KitBounds {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let depthCm = 0;

  for (const item of items) {
    const x = item.offsetXCm ?? 0;
    const y = item.offsetYCm ?? 0;
    minX = Math.min(minX, x - item.widthCm / 2);
    maxX = Math.max(maxX, x + item.widthCm / 2);
    minY = Math.min(minY, y - item.heightCm / 2);
    maxY = Math.max(maxY, y + item.heightCm / 2);
    depthCm = Math.max(depthCm, item.depthCm ?? 3);
  }

  // Kit vazio não chega aqui (`validateKit` barra antes), mas devolver NaN seria
  // um quadro invisível em vez de um erro legível.
  if (!Number.isFinite(minX)) {
    return { widthCm: 0, heightCm: 0, depthCm: 0, centerXCm: 0, centerYCm: 0 };
  }

  return {
    widthCm: maxX - minX,
    heightCm: maxY - minY,
    depthCm,
    centerXCm: (minX + maxX) / 2,
    centerYCm: (minY + maxY) / 2,
  };
}

/** Posição local da peça dentro do grupo do kit, em METROS, já recentrada. */
export function itemPosition(item: KitItem, bounds: KitBounds): [x: number, y: number, z: number] {
  return [
    cmToM((item.offsetXCm ?? 0) - bounds.centerXCm),
    cmToM((item.offsetYCm ?? 0) - bounds.centerYCm),
    0,
  ];
}

/**
 * Estilo efetivo de uma peça: o do kit, com as chaves que ela sobrescreve.
 *
 * Devolve `base` por IDENTIDADE quando não há override — sem isso, o `memo` do
 * `<FrameModel>` erraria a comparação rasa a cada render e a árvore de malhas de
 * cada quadro seria reprocessada dentro da sessão de AR.
 */
export function itemStyle(base: Required<FrameStyle>, item: KitItem): Required<FrameStyle> {
  const override = item.frame;
  if (!override) return base;
  return {
    fit: override.fit ?? base.fit,
    frameWidthCm: override.frameWidthCm ?? base.frameWidthCm,
    frameColor: override.frameColor ?? base.frameColor,
    matCm: override.matCm ?? base.matCm,
    matColor: override.matColor ?? base.matColor,
    shadow: override.shadow ?? base.shadow,
  };
}

/**
 * Métricas do conjunto, a partir das métricas já calculadas de cada peça.
 *
 * Com UMA peça devolve as métricas dela intactas — é o que garante que um
 * produto solto, que agora também passa por aqui, continue reportando
 * exatamente o que reportava antes.
 *
 * Com várias, `outer` vira o bounding box. É o único campo lido por código
 * (`Reticle` e `tapHitsFrame` em `XRScene`, e o retículo do
 * `WebXRSceneManager`), e é justamente por reportá-lo assim que a mira e a área
 * de toque passam a valer para o conjunto inteiro sem nenhuma outra mudança.
 * `opening` e `artwork` são informativos e não fazem sentido agregados: recebem
 * o mesmo retângulo, e `croppedFraction` fica com o pior caso das peças.
 */
export function kitMetrics(items: KitItem[], perItem: FrameMetrics[]): FrameMetrics {
  const [only] = perItem;
  if (only && perItem.length === 1) return only;

  const bounds = kitBounds(items);
  const w = cmToM(bounds.widthCm);
  const h = cmToM(bounds.heightCm);

  return {
    outer: { w, h, d: cmToM(bounds.depthCm) },
    opening: { w, h },
    artwork: { w, h },
    imageAspect: h > 0 ? w / h : 1,
    croppedFraction: Math.max(0, ...perItem.map((m) => m.croppedFraction)),
  };
}
