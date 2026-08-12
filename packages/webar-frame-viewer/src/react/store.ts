'use client';

import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ARError } from '../core/errors';
import type { ARHint, ARStatus, SceneKind } from '../core/types';

/**
 * Estado reativo do visualizador.
 *
 * Substitui a máquina de estados em CSS de `ui/overlay` — o `data-fv-state`
 * continua saindo no DOM (é contrato público de tema, documentado no README),
 * mas agora derivado deste estado em vez de escrito à mão.
 *
 * Implementado com `useSyncExternalStore` em vez de zustand de propósito: o
 * pacote declara `dependencies: {}` e essa propriedade vale mais do que as ~40
 * linhas economizadas. Um store externo (e não `useState` no componente) porque
 * o loop de render do R3F precisa escrever estado de dentro do `useFrame` sem
 * arrastar a árvore inteira junto.
 */

export type PanelMode = 'error' | 'no-wall';

export interface PanelAction {
  label: string;
  kind: 'primary' | 'secondary';
  onSelect: () => void;
}

export interface PanelState {
  mode: PanelMode;
  title: string;
  message: string;
  actions: PanelAction[];
}

export interface ViewerState {
  status: ARStatus;
  engine: SceneKind | null;
  hint: ARHint | null;
  panel: PanelState | null;
  canCapture: boolean;
  error: ARError | null;
}

export const INITIAL_STATE: ViewerState = {
  status: 'idle',
  engine: null,
  hint: null,
  panel: null,
  canCapture: false,
  error: null,
};

export interface ViewerStore {
  get(): ViewerState;
  set(patch: Partial<ViewerState>): void;
  subscribe(listener: () => void): () => void;
}

export function createViewerStore(initial: ViewerState = INITIAL_STATE): ViewerStore {
  let state = initial;
  const listeners = new Set<() => void>();

  return {
    get: () => state,
    set(patch) {
      let changed = false;
      for (const key of Object.keys(patch) as Array<keyof ViewerState>) {
        if (patch[key] !== state[key]) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
      state = { ...state, ...patch };
      // Itera sobre uma cópia: um listener pode se desinscrever durante o loop.
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const ViewerStoreContext = createContext<ViewerStore | null>(null);

export function useViewerStore(): ViewerStore {
  const store = useContext(ViewerStoreContext);
  if (!store) throw new Error('useViewerStore precisa estar dentro de <FrameViewer>.');
  return store;
}

/**
 * O estado inteiro, não um seletor: são seis campos e um overlay pequeno, então
 * um seletor com memo custaria mais complexidade do que economiza em render.
 */
export function useViewerState(): ViewerState {
  const store = useViewerStore();
  return useSyncExternalStore(store.subscribe, store.get, () => INITIAL_STATE);
}

/** Estados visuais do CSS. `paused` e `destroyed` voltam a parecer `idle`. */
export type OverlayState = 'idle' | 'loading' | 'ready' | 'placing' | 'placed' | 'error';

export function overlayState(status: ARStatus): OverlayState {
  if (status === 'paused' || status === 'destroyed') return 'idle';
  return status;
}
