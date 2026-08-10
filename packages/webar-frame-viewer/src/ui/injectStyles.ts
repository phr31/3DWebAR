import css from '../styles/overlay.css';

const STYLE_ID = 'webar-frame-viewer-styles';

/**
 * O CSS é injetado em runtime, não distribuído só como arquivo: usuário de CDN
 * não consegue adicionar um `<link>`, e o critério "inicializar em menos de 5
 * linhas" morre se exigir import de CSS. `dist/overlay.css` continua sendo
 * emitido para quem quiser self-host ou sobrescrever.
 */
export function injectStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}
