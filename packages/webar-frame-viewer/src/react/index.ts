/**
 * Superfície pública React — o caminho principal do pacote.
 *
 * A diretiva `"use client"` vem do banner do tsup, e não daqui: repetir a nas
 * duas pontas só duplicaria a linha no bundle.
 *
 * A API imperativa (`ARController`) não é exportada aqui de propósito: ela
 * continua existindo como motor do build UMD, para quem consome por `<script>`.
 * Veja o README.
 */

// Reexports do núcleo, para o consumidor não precisar de dois imports.
export * from '../core/public';

// Componentes, para quem quiser montar a própria cena.
export { ARCanvas, type ARCanvasProps } from './components/ARCanvas';
export { type FrameMetrics, FrameModel, type FrameModelProps } from './components/FrameModel';
export { Overlay, type OverlayProps } from './components/Overlay';
export { PassthroughScene, type PassthroughSceneProps } from './components/PassthroughScene';
export { Reticle, type ReticleProps } from './components/Reticle';
export { XRScene, type XRSceneProps } from './components/XRScene';
export { FrameViewer, type FrameViewerProps } from './FrameViewer';
// Hooks.
export { type ARApi, hintText, type UseAROptions, useAR } from './hooks/useAR';
export { type ArtTextureResult, useArtTexture } from './hooks/useArtTexture';
export { type CaptureOptions, type CaptureResult, useCapture } from './hooks/useCapture';
export { type HitTestOptions, type HitTestResult, useHitTest } from './hooks/useHitTest';
export {
  type PassthroughOptions,
  type PassthroughResult,
  usePassthrough,
} from './hooks/usePassthrough';
export {
  type PassthroughPlacementOptions,
  type PassthroughPlacementResult,
  usePassthroughPlacement,
} from './hooks/usePassthroughPlacement';
// Store.
export {
  createViewerStore,
  type OverlayState,
  overlayState,
  type PanelAction,
  type PanelMode,
  type PanelState,
  useViewerState,
  useViewerStore,
  type ViewerState,
  type ViewerStore,
  ViewerStoreContext,
} from './store';
