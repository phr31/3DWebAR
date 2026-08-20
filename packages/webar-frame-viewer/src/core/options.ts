import type { KitData, KitItem, ProductData, ResolvedOptions, ViewerOptions } from './types';

export function resolveOptions(options: ViewerOptions = {}): ResolvedOptions {
  return {
    allowRotate: options.allowRotate ?? true,
    allowScale: options.allowScale ?? true,
    // Padrão false: quem escolhe o lugar do quadro é o toque do usuário. Deixar
    // a peça seguir o plano sozinha só passava a impressão de que a ferramenta
    // decide — e ela errava, porque parede lisa não vira plano.
    autoPlaceOnPlane: options.autoPlaceOnPlane ?? false,
    // Padrão false de propósito: `requestSession('immersive-ar')` EXIGE user
    // activation, e o gate de toque também neutraliza o double-mount do StrictMode.
    autoStart: options.autoStart ?? false,
    assumedCameraFovH: options.assumedCameraFovH ?? 68,
    assumedWallDistanceM: options.assumedWallDistanceM ?? 2,
    noHitTimeoutMs: options.noHitTimeoutMs ?? 6000,
    wallToleranceDeg: options.wallToleranceDeg ?? 15,
    debug: options.debug ?? false,
    locale: options.locale ?? 'pt-BR',
    engine: options.engine,
    threeUrl: options.threeUrl,
    frame: {
      fit: options.frame?.fit ?? 'contain',
      frameWidthCm: options.frame?.frameWidthCm ?? 2,
      frameColor: options.frame?.frameColor ?? '#2b2118',
      matCm: options.frame?.matCm ?? 0,
      matColor: options.frame?.matColor ?? '#f4f1ea',
      shadow: options.frame?.shadow ?? 'soft',
    },
  };
}

export function validateProduct(product: {
  widthCm?: number;
  heightCm?: number;
  imageUrl?: string;
}): string | null {
  if (!product.imageUrl) return 'product.imageUrl é obrigatório.';
  if (!(product.widthCm && product.widthCm > 0)) return 'product.widthCm deve ser maior que zero.';
  if (!(product.heightCm && product.heightCm > 0))
    return 'product.heightCm deve ser maior que zero.';
  return null;
}

/**
 * Valida o kit peça por peça, reusando `validateProduct`.
 *
 * A mensagem carrega o ÍNDICE porque, com cinco peças, "imageUrl é obrigatório"
 * sozinho não diz em qual delas mexer — e este erro cai no `INVALID_PRODUCT`,
 * que é erro de integração e precisa ser acionável de primeira.
 */
export function validateKit(kit: KitData): string | null {
  if (!kit.items?.length) return 'kit.items precisa de pelo menos uma peça.';

  for (const [i, item] of kit.items.entries()) {
    const problem = validateProduct(item);
    if (problem) return problem.replace(/^product\./, `kit.items[${i}].`);
  }
  return null;
}

/**
 * O que o visualizador exibe, com produto solto e kit já reduzidos à mesma
 * forma: uma lista de peças.
 *
 * `ARController` (vanilla) e `useAR`/`FrameViewer` (React) são orquestradores
 * PARALELOS — um não embrulha o outro. Normalizar aqui, num lugar só, é o que
 * impede os dois de divergirem sobre o que é um kit válido.
 */
export interface ViewerContent {
  items: KitItem[];
  /** `kit.id` ou `product.id`. Vai para o nome do arquivo da captura. */
  id: string;
  title: string;
  /** Um kit de uma peça continua sendo kit — muda o nome do arquivo, só isso. */
  isKit: boolean;
}

export function resolveContent(source: { product?: ProductData; kit?: KitData }): ViewerContent {
  if (source.kit) {
    return {
      items: source.kit.items ?? [],
      id: source.kit.id,
      title: source.kit.title ?? '',
      isKit: true,
    };
  }
  const product = source.product;
  return {
    items: product ? [product] : [],
    id: product?.id ?? '',
    title: product?.title ?? '',
    isKit: false,
  };
}

export function validateContent(content: ViewerContent): string | null {
  const [first] = content.items;
  if (!first) {
    return content.isKit
      ? 'kit.items precisa de pelo menos uma peça.'
      : 'informe `product` ou `kit` ao criar o visualizador.';
  }
  return content.isKit
    ? validateKit({ id: content.id, items: content.items })
    : validateProduct(first);
}
