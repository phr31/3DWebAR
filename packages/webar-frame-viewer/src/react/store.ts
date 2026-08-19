'use client';

import { createContext, useCallback, useContext, useRef, useSyncExternalStore } from 'react';
import type { ARError } from '../core/errors';
import type { DeviceAngles, YawStatus } from '../core/passthrough/orientation';
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

/** Leitura de diagnóstico do overlay. Preenchida só com `options.debug`. */
export interface DebugInfo {
  engine: SceneKind | null;
  /** Houve permissão e há evento de orientação chegando. */
  hasOrientation: boolean;
  /** Últimos ângulos recebidos. Null no WebXR, que não usa o giroscópio. */
  angles: DeviceAngles | null;
  yaw: YawStatus;
  /**
   * Custo por frame, amostrado por `useFrameStats`. Opcionais porque quem monta
   * o `DebugInfo` à mão (um integrador, um teste) não precisa deles.
   *
   * `frameMs` é média móvel — o número instantâneo oscila demais para ser lido
   * na tela. `textures` é o que denuncia vazamento de GPU entre sessões: ele
   * deve voltar ao mesmo valor depois de sair e reentrar no AR.
   */
  frameMs?: number;
  calls?: number;
  tris?: number;
  textures?: number;
}

/**
 * Aviso momentâneo. O `id` incremental existe para o `key` do React: sem ele,
 * travar → destravar → travar não reinicia a animação, porque o texto repetido é
 * o mesmo nó e o CSS não reanima.
 */
export interface ToastState {
  id: number;
  text: string;
}

export interface ViewerState {
  status: ARStatus;
  engine: SceneKind | null;
  hint: ARHint | null;
  panel: PanelState | null;
  canCapture: boolean;
  /**
   * Só significa alguma coisa com `status: 'placed'`. Ancorado e travado são
   * coisas diferentes: depois do toque o quadro para de seguir a parede (ancora)
   * mas continua arrastável, e só o cadeado congela os gestos.
   */
  locked: boolean;
  toast: ToastState | null;
  error: ARError | null;
  debug: DebugInfo | null;
}

export const INITIAL_STATE: ViewerState = {
  status: 'idle',
  engine: null,
  hint: null,
  panel: null,
  canCapture: false,
  locked: false,
  toast: null,
  error: null,
  debug: null,
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
 * O estado inteiro. Certo para o `<Overlay>`, que pinta quase todos os campos e
 * cujo re-render é uma árvore de DOM pequena.
 *
 * ERRADO para quem envolve o `<Canvas>`: o layout effect do R3F não tem array de
 * dependências, então todo render do componente que hospeda o `<Canvas>` refaz
 * `configure()` e reconcilia a árvore 3D inteira. Ali use `useViewerSelector`.
 */
export function useViewerState(): ViewerState {
  const store = useViewerStore();
  return useSyncExternalStore(store.subscribe, store.get, () => INITIAL_STATE);
}

/**
 * Um campo só do estado, para não re-renderizar por mudança que não interessa.
 *
 * Aceita apenas valores PRIMITIVOS de propósito: `useSyncExternalStore` compara
 * o snapshot com `Object.is` e entraria em laço infinito com um seletor que
 * devolve objeto novo a cada leitura. A saída seria
 * `use-sync-external-store/with-selector`, e essa dependência custa mais do que
 * vale — o pacote declara `dependencies: {}`. Para ler vários campos, chame o
 * hook uma vez por campo.
 */
export function useViewerSelector<T extends string | number | boolean | null | undefined>(
  selector: (state: ViewerState) => T,
): T {
  const store = useViewerStore();
  // O seletor costuma ser um literal inline, portanto novo a cada render; numa
  // ref ele não invalida o `getSnapshot` e não força reinscrição.
  const selectorRef = useRef(selector);
  selectorRef.current = selector;

  const getSnapshot = useCallback(() => selectorRef.current(store.get()), [store]);
  const getServerSnapshot = useCallback(() => selectorRef.current(INITIAL_STATE), []);

  return useSyncExternalStore(store.subscribe, getSnapshot, getServerSnapshot);
}

/** Estados visuais do CSS. `paused` e `destroyed` voltam a parecer `idle`. */
export type OverlayState = 'idle' | 'loading' | 'ready' | 'placing' | 'placed' | 'error';

export function overlayState(status: ARStatus): OverlayState {
  if (status === 'paused' || status === 'destroyed') return 'idle';
  return status;
}
