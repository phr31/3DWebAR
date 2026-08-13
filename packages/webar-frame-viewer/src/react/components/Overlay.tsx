'use client';

import { type Ref, type RefObject, useEffect, useRef } from 'react';
import type { SceneKind } from '../../core/types';
import { injectStyles } from '../../ui/injectStyles';
import type { StringKey } from '../../ui/strings';
import { hintText } from '../hooks/useAR';
import { overlayState, useViewerState } from '../store';

/**
 * A interface, agora em React.
 *
 * A árvore de classes `.fv-*` e os atributos `data-fv-state` / `data-fv-engine` /
 * `data-fv-hint` / `data-fv-capture` são preservados na íntegra: são contrato
 * público de tema, documentados no README, e integradores já dependem deles. O
 * `overlay.css` continua valendo sem alteração — a diferença é que o estado
 * agora vem do store em vez de ser escrito à mão no dataset.
 */

export interface OverlayProps {
  t(key: StringKey): string;
  title?: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Callback ref: os gestos do passthrough precisam reagir à montagem do palco. */
  stageRef: Ref<HTMLDivElement>;
  /** Callback ref: a raiz vira o `domOverlay` da sessão WebXR quando ela monta. */
  rootRef: Ref<HTMLDivElement>;
  onStart(): void;
  onClose(): void;
  onPhotoPrepare(): void;
  onPhoto(): void;
  onReposition(): void;
  children?: React.ReactNode;
}

export function Overlay({
  t,
  title,
  videoRef,
  stageRef,
  rootRef,
  onStart,
  onClose,
  onPhotoPrepare,
  onPhoto,
  onReposition,
  children,
}: OverlayProps): React.ReactElement {
  const state = useViewerState();
  const uiRef = useRef<HTMLDivElement | null>(null);

  // O CSS é injetado em runtime (e não importado) para o consumidor de CDN não
  // precisar adicionar um <link>. `dist/overlay.css` segue disponível para quem
  // quer self-host.
  useEffect(() => {
    injectStyles();
  }, []);

  /**
   * Sem isto, tocar num botão do overlay também dispara `select` na sessão XR e o
   * quadro se reposiciona junto com o clique em "Foto".
   *
   * O alvo é `.fv-ui`, e NÃO `.fv-root`: a raiz é o `domOverlay` da sessão e cobre
   * a tela inteira, então cancelar ali mataria o `select` de qualquer toque —
   * inclusive o "toque para fixar". Como `.fv-ui` é `pointer-events: none` e só os
   * controles são `auto`, o evento só passa por aqui quando o toque foi num botão.
   */
  useEffect(() => {
    const ui = uiRef.current;
    if (!ui) return;
    const block = (ev: Event): void => ev.preventDefault();
    ui.addEventListener('beforexrselect', block);
    return () => ui.removeEventListener('beforexrselect', block);
  }, []);

  const hint = hintText(state.hint, t);
  const engine: SceneKind | 'none' = state.engine ?? 'none';

  return (
    <div
      ref={rootRef}
      className="fv-root"
      role="dialog"
      aria-modal="true"
      aria-label="Visualizar quadro em Realidade Aumentada"
      data-fv-state={overlayState(state.status)}
      data-fv-engine={engine}
      data-fv-hint={hint ? '1' : ''}
      data-fv-capture={state.canCapture ? '1' : '0'}
    >
      <div className="fv-stage" ref={stageRef}>
        {/* Sem `playsinline` o iOS abre o player em tela cheia e a experiência
            acaba. No WebXR o CSS esconde este elemento: quem desenha a câmera é
            o compositor XR. */}
        <video
          ref={videoRef}
          className="fv-video"
          playsInline
          // Atributo legado, ainda necessário em versões antigas do iOS.
          {...{ 'webkit-playsinline': 'true' }}
          muted
          autoPlay
        />
        {children}
      </div>

      <div className="fv-ui" ref={uiRef}>
        {state.debug && (
          <p className="fv-debug">
            {`engine: ${state.debug.engine ?? '—'} · sensor: ${
              state.debug.hasOrientation ? 'on' : 'off'
            } · yaw: ${state.debug.yaw}`}
            {state.debug.angles &&
              ` · α ${state.debug.angles.alpha.toFixed(0)} β ${state.debug.angles.beta.toFixed(
                0,
              )} γ ${state.debug.angles.gamma.toFixed(0)}`}
          </p>
        )}

        <header className="fv-bar fv-bar--top">
          <p className="fv-title">{title ?? ''}</p>
          <button
            type="button"
            className="fv-btn fv-btn--icon fv-close"
            aria-label={t('close')}
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <div className="fv-center">
          <button type="button" className="fv-btn fv-btn--primary fv-start" onClick={onStart}>
            {t('start')}
          </button>

          <div className="fv-spinner" role="status" aria-live="polite">
            <span className="fv-sr">{t('loading')}</span>
          </div>

          <div className="fv-panel" role="alert">
            <p className="fv-panel__title">{state.panel?.title ?? ''}</p>
            <p className="fv-panel__msg">{state.panel?.message ?? ''}</p>
            <div className="fv-panel__actions">
              {state.panel?.actions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  className={`fv-btn ${action.kind === 'primary' ? 'fv-btn--primary' : ''}`}
                  onClick={action.onSelect}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <p className="fv-hint">{hint}</p>

        <footer className="fv-bar fv-bar--bottom">
          <div className="fv-actions">
            {/* Único caminho para soltar o quadro depois de fixado. O CSS o
                mostra apenas em `data-fv-state="placed"`. */}
            <button type="button" className="fv-btn fv-reposition" onClick={onReposition}>
              {t('reposition')}
            </button>

            {/* pointerdown prepara o blob, click compartilha: o `navigator.share`
                exige transient activation e não sobreviveria à espera do encode. */}
            <button
              type="button"
              className="fv-btn fv-btn--icon fv-shot"
              aria-label={t('photo')}
              onPointerDown={onPhotoPrepare}
              onClick={onPhoto}
            >
              📷
            </button>
          </div>
          <p className="fv-privacy">{t('privacy')}</p>
        </footer>
      </div>
    </div>
  );
}
