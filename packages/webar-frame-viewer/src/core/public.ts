/**
 * Superfície pública server-safe: tipos, erros e detecção de ambiente.
 *
 * Este módulo NÃO carrega a diretiva `"use client"` e não toca em nenhum global
 * de navegador no escopo do módulo — todas as sondas de `capabilities` vivem
 * dentro da função. É o que um Server Component do Next.js pode importar para,
 * por exemplo, tipar os dados do produto.
 */

export { clearAssets, preload } from './AssetLoader';
export { type CapabilityReport, detectCapabilities, type InAppBrowser } from './capabilities';
export {
  ARError,
  type ARErrorCode,
  type ErrorPhase,
  type Locale,
  userMessage,
} from './errors';
export { provideThree, type ThreeLoader } from './loadThree';
export { resolveOptions, validateProduct } from './options';
export type {
  AREventMap,
  ARHint,
  ARStatus,
  FitMode,
  FrameStyle,
  PlacementInfo,
  ProductData,
  ResolvedOptions,
  SceneKind,
  ViewerOptions,
} from './types';
