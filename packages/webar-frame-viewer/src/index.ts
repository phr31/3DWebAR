import { setDefaultThreeLoader } from './core/loadThree';

// O bundler do consumidor resolve o bare specifier; `three` fica em `external`,
// então nada disso entra no bundle inicial da página.
setDefaultThreeLoader(() => import('three'));

export { ARController, FrameViewer, type ViewerConfig } from './core/ARController';
export { clearAssets, preload } from './core/AssetLoader';
export { type CapabilityReport, detectCapabilities } from './core/capabilities';
export { ARError, type ARErrorCode, type Locale, userMessage } from './core/errors';
export { provideThree, type ThreeLoader } from './core/loadThree';
export type {
  AREventMap,
  ARHint,
  ARStatus,
  FitMode,
  FrameStyle,
  PlacementInfo,
  ProductData,
  SceneKind,
  ViewerOptions,
} from './core/types';
export { createViewer } from './vanilla/createViewer';
