'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type CapabilityReport, detectCapabilities } from '../../core/capabilities';
import { ARError, normalizeError, userMessage } from '../../core/errors';
import type { RelativeFramePose } from '../../core/TransformUtils';
import type { ARHint, PlacementInfo, ResolvedOptions, SceneKind } from '../../core/types';
import type { StringKey } from '../../ui/strings';
import { type DebugInfo, useViewerStore } from '../store';

/**
 * Orquestrador da experiência: decide o engine, controla o ciclo de vida e é o
 * único lugar que escreve `status` no store.
 *
 * Substitui o `ARController` no caminho React. Três comportamentos dele são
 * requisitos de produto e estão reproduzidos aqui:
 *
 * - `start()` NUNCA rejeita. Uma unhandled rejection no navegador de um
 *   comprador não é aceitável — toda falha vira `status: 'error'` + `onError`.
 * - `XR_SESSION_FAILED` com `getUserMedia` disponível cai silenciosamente para
 *   passthrough, sem mostrar erro.
 * - `XR_GESTURE_REQUIRED` volta para `idle` (mostra o botão de novo). Não é
 *   erro: é a sessão XR pedindo um toque do usuário.
 */

export interface UseAROptions {
  options: ResolvedOptions;
  t(key: StringKey): string;
  onReady?(): void;
  onPlace?(info: PlacementInfo): void;
  onError?(error: ARError): void;
  onClose?(): void;
}

export interface ARApi {
  capabilities: CapabilityReport | null;
  start(enterXR: () => Promise<unknown>): Promise<void>;
  /** Guarda o `enterAR` da store XR, para o botão "Tentar novamente" reusá-lo. */
  setEnterXR(enterXR: () => Promise<unknown>): void;
  close(): void;
  /**
   * A sessão XR terminou por fora (back do Android, botão do sistema). Volta ao
   * idle sem fechar o viewer — não confundir com `close`, que é o ✕.
   */
  reportSessionEnded(): void;
  /** Guarda a pose do quadro para a próxima entrada no AR. `null` limpa. */
  retainPose(pose: RelativeFramePose | null): void;
  /** Lê e consome a pose guardada. */
  takeRetainedPose(): RelativeFramePose | null;
  setHint(hint: ARHint | null): void;
  reportPlaced(info: PlacementInfo): void;
  reportUnplaced(): void;
  /** Chamado pelos engines quando a sessão morre por conta própria. */
  fail(error: unknown, phase: Parameters<typeof normalizeError>[1]): void;
  /** Sessão XR estabelecida com sucesso — o engine confirma que está no ar. */
  reportEngineReady(kind: SceneKind, canCapture: boolean): void;
  dismissPanel(): void;
  enableManualPlacement(): void;
  /**
   * A cena ativa publica aqui como destravar o quadro; o botão "Reposicionar" do
   * overlay é o único caminho de volta. Passar `null` no unmount.
   */
  registerReposition(handler: (() => void) | null): void;
  /** Acionado pelo overlay. Sem cena registrada, não faz nada. */
  reposition(): void;
  /**
   * Mesmo desenho do `registerReposition`: quem sabe travar é a cena — no WebXR
   * é recriar a âncora, no passthrough é fechar os gestos. Aqui só encaminha.
   */
  registerLock(handler: ((locked: boolean) => void) | null): void;
  /** Alterna o cadeado. Chamado pelo botão do overlay. */
  toggleLock(): void;
  /** Escrito pela cena depois de travar/destravar de fato. Dispara o toast. */
  setLocked(locked: boolean): void;
  showToast(text: string): void;
  /** Leitura de diagnóstico do HUD (`options.debug`). */
  setDebug(info: DebugInfo | null): void;
  manualModeRef: React.RefObject<boolean>;
}

export function useAR({ options, t, onReady, onPlace, onError, onClose }: UseAROptions): ARApi {
  const store = useViewerStore();
  const capabilitiesRef = useRef<CapabilityReport | null>(null);
  const manualModeRef = useRef(false);
  const repositionRef = useRef<(() => void) | null>(null);
  const lockRef = useRef<((locked: boolean) => void) | null>(null);
  const toastSeqRef = useRef(0);
  const startingRef = useRef(false);
  /**
   * Pose do quadro guardada quando a sessão XR morreu, para a próxima entrada.
   *
   * Uma ref, e não campo do store: toda escrita no store notifica listeners e
   * re-renderiza o overlay por um dado que ninguém pinta. E aqui, e não em escopo
   * de módulo, porque o store é por instância justamente para dois viewers na
   * mesma página não misturarem estado — um módulo global restauraria a pose do
   * quadro A sobre o quadro B.
   *
   * Vive enquanto o `<FrameViewer>` estiver montado: recarregar a página, ou
   * fechar no ✕ (que o integrador costuma tratar desmontando), começa limpo.
   */
  const retainedPoseRef = useRef<RelativeFramePose | null>(null);
  // Declarados aqui porque `fail` (definido antes de `start`) precisa reiniciar.
  const startRef = useRef<((enterXR: () => Promise<unknown>) => Promise<void>) | null>(null);
  const enterXRRef = useRef<() => Promise<unknown>>(() => Promise.resolve());

  const latest = useRef({ options, t, onReady, onPlace, onError, onClose });
  latest.current = { options, t, onReady, onPlace, onError, onClose };

  /**
   * `detectCapabilities` é assíncrona (a sonda de `immersive-ar` corre contra um
   * timeout, porque `isSessionSupported` já foi vista travar para sempre). Ela
   * roda na montagem, e não no clique: um await dentro do handler queimaria a
   * user activation que `requestSession('immersive-ar')` exige.
   *
   * Se o usuário for rápido demais e tocar antes da sonda terminar, o caminho
   * degrada sozinho — a sessão XR lança `SecurityError`, vira
   * `XR_GESTURE_REQUIRED` e o botão reaparece já com as capacidades em cache.
   */
  const [capabilities, setCapabilities] = useState<CapabilityReport | null>(null);

  useEffect(() => {
    let active = true;
    void detectCapabilities().then((report) => {
      capabilitiesRef.current = report;
      if (active) setCapabilities(report);
    });
    return () => {
      active = false;
    };
  }, []);

  const fail = useCallback(
    (raw: unknown, phase: Parameters<typeof normalizeError>[1]) => {
      const error =
        raw instanceof ARError
          ? raw
          : normalizeError(raw, phase, {
              locale: latest.current.options.locale,
              inAppBrowser: capabilitiesRef.current?.inAppBrowser ?? null,
            });

      store.set({
        status: 'error',
        error,
        panel: {
          mode: 'error',
          title: latest.current.t('retry'),
          message: error.userMessage,
          actions: error.recoverable
            ? [
                {
                  label: latest.current.t('retry'),
                  kind: 'primary',
                  onSelect: () => void startRef.current?.(enterXRRef.current),
                },
              ]
            : [],
        },
      });
      latest.current.onError?.(error);
    },
    [store],
  );

  /**
   * `enterXR` é injetado pelo componente porque a store do XR vive no
   * `<ARCanvas>`. Ele PRECISA ser chamado dentro do handler do clique:
   * `requestSession('immersive-ar')` exige user activation, e um await antes
   * dele já queimaria a ativação.
   */
  const start = useCallback(
    async (enterXR: () => Promise<unknown>) => {
      if (startingRef.current) return;
      const state = store.get();
      if (state.status === 'loading') return;

      startingRef.current = true;
      try {
        const caps = capabilitiesRef.current ?? (await detectCapabilities());
        capabilitiesRef.current = caps;
        const locale = latest.current.options.locale;

        // O webview do Instagram/Facebook bloqueia getUserMedia. Isso vem antes
        // da seleção de engine — não adianta escolher motor nenhum.
        if (caps.inAppBrowser) {
          fail(new ARError('IN_APP_BROWSER', undefined, { locale }), 'env');
          return;
        }

        const kind = latest.current.options.engine ?? caps.recommended;
        if (!kind) {
          fail(new ARError(caps.reason ?? 'NO_AR_SUPPORT', undefined, { locale }), 'env');
          return;
        }

        store.set({ status: 'loading', engine: kind, error: null, panel: null });
        if (kind !== 'webxr') return;

        try {
          await enterXR();
        } catch (raw) {
          const error = normalizeError(raw, 'xr', { locale });

          // Falta de user activation não é erro: é a sessão pedindo um toque.
          // Volta para 'idle' e o botão reaparece.
          if (error.code === 'XR_GESTURE_REQUIRED') {
            store.set({ status: 'idle', engine: null, error: null, panel: null });
            return;
          }

          // Sessão XR indisponível mas há câmera: cai para passthrough em
          // silêncio. O usuário não precisa saber que o ARCore falhou.
          if (error.code === 'XR_SESSION_FAILED' && caps.getUserMedia) {
            store.set({ status: 'loading', engine: 'passthrough', error: null, panel: null });
            return;
          }

          fail(error, 'xr');
        }
      } finally {
        startingRef.current = false;
      }
    },
    [store, fail],
  );

  startRef.current = start;

  const close = useCallback(() => {
    store.set({ status: 'destroyed', panel: null, hint: null });
    latest.current.onClose?.();
  }, [store]);

  /**
   * A XRSession acabou: back do Android, botão do sistema, ou o runtime desistiu.
   *
   * Volta para 'idle' e NÃO fecha o viewer. O botão "Ver na minha parede"
   * reaparece (o CSS só o mostra nesse estado) e `start()` reentra sem problema:
   * as capacidades já estão em cache, então `enterXR()` continua sendo chamado
   * dentro do clique, com a user activation intacta.
   *
   * O `ARController` do build UMD tratava `sessionend` emitindo `close` +
   * destroy, mas lá não havia volta. Aqui `onClose` continua significando "o
   * usuário fechou o overlay" e só sai do ✕ — o integrador costuma desmontar o
   * `<FrameViewer>` nesse callback, o que apagaria a pose retida entre sessões.
   *
   * `engine` NÃO é tocado de propósito: o `<XR>` só é renderizado enquanto ele
   * vale 'webxr', e desmontá-lo deixaria `xrStore.enterAR()` sem nada em que agir
   * na segunda tentativa.
   */
  const reportSessionEnded = useCallback(() => {
    const current = store.get();
    // 'error' tem um painel com "Tentar novamente" na tela, e sobrescrevê-lo
    // tiraria a única saída. 'destroyed' é o ✕, que já ganhou.
    if (current.status === 'error' || current.status === 'destroyed') return;
    store.set({ status: 'idle', hint: null, panel: null, locked: false, toast: null });
  }, [store]);

  const setHint = useCallback(
    (hint: ARHint | null) => {
      const current = store.get();
      if (current.hint === hint) return;

      // `no-wall-found` não é uma dica: é a oferta de posicionamento manual.
      if (hint === 'no-wall-found') {
        store.set({
          hint,
          panel: {
            mode: 'no-wall',
            title: latest.current.t('manual'),
            message: latest.current.t('hint.no-wall-found'),
            actions: [
              {
                label: latest.current.t('manual'),
                kind: 'primary',
                onSelect: () => {
                  manualModeRef.current = true;
                  store.set({ panel: null, status: 'placing', hint: 'tap-to-place' });
                },
              },
              {
                label: latest.current.t('keepTrying'),
                kind: 'secondary',
                onSelect: () => store.set({ panel: null, status: 'placing' }),
              },
            ],
          },
          status: 'error',
        });
        return;
      }
      store.set({ hint });
    },
    [store],
  );

  const reportEngineReady = useCallback(
    (kind: SceneKind, canCapture: boolean) => {
      // Câmera no ar e nada posicionado: o fluxo começa esperando o toque do
      // usuário, sempre — não há mais um modo em que a cena se posiciona sozinha.
      store.set({
        engine: kind,
        canCapture,
        status: 'placing',
        hint: 'tap-to-place',
        error: null,
        panel: null,
      });
      latest.current.onReady?.();
    },
    [store],
  );

  const showToast = useCallback(
    (text: string) => {
      toastSeqRef.current += 1;
      store.set({ toast: { id: toastSeqRef.current, text } });
    },
    [store],
  );

  const reportPlaced = useCallback(
    (info: PlacementInfo) => {
      // Ancorado, ainda destravado: é a janela de ajuste fino. Travar é um ato
      // explícito no cadeado — o toque nunca trava nem destrava sozinho.
      store.set({ status: 'placed', hint: 'adjust', locked: false });
      // 'auto' só sai da restauração entre sessões, onde a pose é uma ESTIMATIVA
      // relativa à câmera. O aviso é o que a torna honesta — e o estado
      // destravado, que já é o desta transição, é o convite a corrigir.
      if (info.source === 'auto') showToast(latest.current.t('toast.restored'));
      latest.current.onPlace?.(info);
    },
    [store, showToast],
  );

  const reportUnplaced = useCallback(() => {
    store.set({ status: 'placing', hint: 'tap-to-place', locked: false });
  }, [store]);

  const retainPose = useCallback((pose: RelativeFramePose | null) => {
    retainedPoseRef.current = pose;
  }, []);

  /** Lê E consome: restaurar acontece no máximo uma vez por sessão. */
  const takeRetainedPose = useCallback((): RelativeFramePose | null => {
    const pose = retainedPoseRef.current;
    retainedPoseRef.current = null;
    return pose;
  }, []);

  const registerReposition = useCallback((handler: (() => void) | null) => {
    repositionRef.current = handler;
  }, []);

  // Quem destrava de fato é a cena: só ela sabe se precisa soltar a âncora XR ou
  // apenas reabrir os gestos. Aqui é só o encaminhamento.
  const reposition = useCallback(() => {
    repositionRef.current?.();
  }, []);

  const registerLock = useCallback((handler: ((locked: boolean) => void) | null) => {
    lockRef.current = handler;
  }, []);

  const setLocked = useCallback(
    (locked: boolean) => {
      const current = store.get();
      if (current.locked === locked) return;
      toastSeqRef.current += 1;
      store.set({
        locked,
        hint: locked ? 'placed' : 'adjust',
        toast: {
          id: toastSeqRef.current,
          text: latest.current.t(locked ? 'toast.locked' : 'toast.unlocked'),
        },
      });
    },
    [store],
  );

  const toggleLock = useCallback(() => {
    const handler = lockRef.current;
    if (!handler) return;
    handler(!store.get().locked);
  }, [store]);

  const setDebug = useCallback(
    (info: DebugInfo | null) => {
      store.set({ debug: info });
    },
    [store],
  );

  const dismissPanel = useCallback(() => {
    store.set({ panel: null, status: 'placing' });
  }, [store]);

  const enableManualPlacement = useCallback(() => {
    manualModeRef.current = true;
    store.set({ panel: null, status: 'placing', hint: 'tap-to-place' });
  }, [store]);

  // Libera o overlay ao desmontar, para um remount não herdar 'destroyed'.
  useEffect(() => {
    return () => {
      store.set({ status: 'destroyed' });
    };
  }, [store]);

  const setEnterXR = useCallback((enterXR: () => Promise<unknown>) => {
    enterXRRef.current = enterXR;
  }, []);

  return useMemo(
    () => ({
      capabilities,
      start,
      setEnterXR,
      close,
      reportSessionEnded,
      retainPose,
      takeRetainedPose,
      setHint,
      reportPlaced,
      reportUnplaced,
      reportEngineReady,
      fail,
      dismissPanel,
      enableManualPlacement,
      registerReposition,
      reposition,
      registerLock,
      toggleLock,
      setLocked,
      showToast,
      setDebug,
      manualModeRef,
    }),
    [
      capabilities,
      start,
      setEnterXR,
      close,
      reportSessionEnded,
      retainPose,
      takeRetainedPose,
      setHint,
      reportPlaced,
      reportUnplaced,
      reportEngineReady,
      fail,
      dismissPanel,
      enableManualPlacement,
      registerReposition,
      reposition,
      registerLock,
      toggleLock,
      setLocked,
      showToast,
      setDebug,
    ],
  );
}

/** Texto da dica atual, já resolvido para o locale. */
export function hintText(hint: ARHint | null, t: (key: StringKey) => string): string {
  if (!hint) return '';
  return t(`hint.${hint}` as StringKey);
}

export { userMessage };
