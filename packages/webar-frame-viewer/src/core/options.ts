import type { ResolvedOptions, ViewerOptions } from './types';

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
