import { ARController, type ViewerConfig } from '../core/ARController';

/**
 * Fábrica da API vanilla. Devolve o próprio controller — `start`, `pause` e
 * `destroy` já são a superfície pedida pela spec.
 */
export function createViewer(config: ViewerConfig): ARController {
  return ARController.create(config);
}
