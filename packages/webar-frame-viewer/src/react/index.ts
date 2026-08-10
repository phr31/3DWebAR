'use client';

import { setDefaultThreeLoader } from '../core/loadThree';

// Este bundle é independente do `index.mjs`; precisa registrar o próprio loader.
// O estado fica em globalThis, então as duas entries compartilham a instância.
setDefaultThreeLoader(() => import('three'));

export { ARController, type ViewerConfig } from '../core/ARController';
export { type CapabilityReport, detectCapabilities } from '../core/capabilities';
export { ARError, type ARErrorCode, type Locale, userMessage } from '../core/errors';
export { provideThree, type ThreeLoader } from '../core/loadThree';
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
} from '../core/types';
export { FrameViewer, type FrameViewerProps } from './FrameViewer';
