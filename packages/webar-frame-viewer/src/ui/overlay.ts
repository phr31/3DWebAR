import type { SceneKind } from '../core/types';
import { injectStyles } from './injectStyles';
import type { StringKey } from './strings';

export type OverlayState = 'idle' | 'loading' | 'ready' | 'placing' | 'placed' | 'error';

export interface OverlayHandlers {
  onStart(): void;
  onClose(): void;
  /** Disparado no pointerdown, para o blob já existir quando o click chegar. */
  onPhotoPrepare(): void;
  onPhoto(): void;
  onPrimaryAction(): void;
  onSecondaryAction(): void;
}

export interface PanelAction {
  label: string;
  kind: 'primary' | 'secondary';
}

export interface Overlay {
  root: HTMLElement;
  stage: HTMLElement;
  setState(state: OverlayState): void;
  setHint(text: string): void;
  setTitle(text: string): void;
  setEngine(kind: SceneKind | 'none'): void;
  setCanCapture(enabled: boolean): void;
  showPanel(title: string, message: string, actions: PanelAction[]): void;
  destroy(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function createOverlay(
  container: HTMLElement,
  t: (key: StringKey) => string,
  handlers: OverlayHandlers,
): Overlay {
  injectStyles();

  const root = el('div', 'fv-root');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Visualizar quadro em Realidade Aumentada');
  root.dataset.fvState = 'idle';
  root.dataset.fvEngine = 'none';

  const stage = el('div', 'fv-stage');
  const video = el('video', 'fv-video');
  // Sem `playsinline` o iOS abre o player em tela cheia e a experiência acaba.
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.muted = true;
  video.autoplay = true;
  const canvas = el('canvas', 'fv-canvas');
  stage.append(video, canvas);

  const ui = el('div', 'fv-ui');

  const top = el('header', 'fv-bar fv-bar--top');
  const title = el('p', 'fv-title');
  const close = el('button', 'fv-btn fv-btn--icon fv-close', '✕');
  close.type = 'button';
  close.setAttribute('aria-label', t('close'));
  top.append(title, close);

  const center = el('div', 'fv-center');
  const start = el('button', 'fv-btn fv-btn--primary fv-start', t('start'));
  start.type = 'button';
  const spinner = el('div', 'fv-spinner');
  spinner.setAttribute('role', 'status');
  spinner.setAttribute('aria-live', 'polite');
  spinner.append(el('span', 'fv-sr', t('loading')));

  const panel = el('div', 'fv-panel');
  panel.setAttribute('role', 'alert');
  const panelTitle = el('p', 'fv-panel__title');
  const panelMsg = el('p', 'fv-panel__msg');
  const panelActions = el('div', 'fv-panel__actions');
  panel.append(panelTitle, panelMsg, panelActions);
  center.append(start, spinner, panel);

  const hint = el('p', 'fv-hint');

  const bottom = el('footer', 'fv-bar fv-bar--bottom');
  const photo = el('button', 'fv-btn fv-btn--icon fv-shot', '📷');
  photo.type = 'button';
  photo.setAttribute('aria-label', t('photo'));
  const privacy = el('p', 'fv-privacy', t('privacy'));
  bottom.append(photo, privacy);

  ui.append(top, center, hint, bottom);
  root.append(stage, ui);
  container.appendChild(root);

  start.addEventListener('click', handlers.onStart);
  close.addEventListener('click', handlers.onClose);
  photo.addEventListener('pointerdown', handlers.onPhotoPrepare);
  photo.addEventListener('click', handlers.onPhoto);

  return {
    root,
    stage,
    setState(state) {
      root.dataset.fvState = state;
    },
    setHint(text) {
      hint.textContent = text;
      root.dataset.fvHint = text ? '1' : '';
    },
    setTitle(text) {
      title.textContent = text;
    },
    setEngine(kind) {
      root.dataset.fvEngine = kind;
    },
    setCanCapture(enabled) {
      root.dataset.fvCapture = enabled ? '1' : '0';
    },
    showPanel(panelTitleText, message, actions) {
      panelTitle.textContent = panelTitleText;
      panelMsg.textContent = message;
      panelActions.replaceChildren();
      actions.forEach((action, index) => {
        const button = el(
          'button',
          `fv-btn ${action.kind === 'primary' ? 'fv-btn--primary' : ''}`,
          action.label,
        );
        button.type = 'button';
        button.addEventListener(
          'click',
          index === 0 ? handlers.onPrimaryAction : handlers.onSecondaryAction,
        );
        panelActions.append(button);
      });
    },
    destroy() {
      start.removeEventListener('click', handlers.onStart);
      close.removeEventListener('click', handlers.onClose);
      photo.removeEventListener('pointerdown', handlers.onPhotoPrepare);
      photo.removeEventListener('click', handlers.onPhoto);
      video.srcObject = null;
      root.remove();
    },
  };
}
