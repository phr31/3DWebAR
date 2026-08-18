'use client';

import type { ARHint } from '../../core/types';

/**
 * Ícone que acompanha a dica atual.
 *
 * SVG inline e não uma fonte de ícones: o pacote declara `dependencies: {}` e um
 * `<img>` externo não carregaria dentro do `dom-overlay` sem CSP do integrador.
 * Tudo em `currentColor` para herdar a mesma sombra do texto, e `aria-hidden`
 * porque a frase ao lado já diz o que fazer — o leitor de tela não deve ouvir
 * duas vezes.
 */

export interface CoachIconProps {
  hint: ARHint;
}

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

/** Uma dica pode não ter ícone: erro e diagnóstico ficam só no texto. */
function path(hint: ARHint): React.ReactNode {
  switch (hint) {
    // Mirar: retângulo da parede com uma mira no centro.
    case 'scan':
    case 'move-slower':
    case 'aim-wall':
    case 'no-wall-found':
      return (
        <>
          <rect x="2.5" y="4" width="19" height="16" rx="2" />
          <path d="M12 9.5v5M9.5 12h5" />
        </>
      );
    // Tocar: mão com um pulso de toque saindo do dedo. Mirar com o dedo na tela
    // é o mesmo gesto em andamento, então repete o ícone.
    case 'tap-to-place':
    case 'hold-to-aim':
      return (
        <>
          <path d="M9 11V6.5a1.75 1.75 0 0 1 3.5 0V13" />
          <path d="M12.5 12v-1.5a1.75 1.75 0 0 1 3.5 0V13" />
          <path d="M16 12.5a1.75 1.75 0 0 1 3.5 0V16a5.5 5.5 0 0 1-5.5 5.5h-1.5a5.5 5.5 0 0 1-4.6-2.5L5 15.2a1.6 1.6 0 0 1 2.6-1.9L9 15" />
          <path d="M4.5 5.5 3 4M8 3.2V1.5M12.8 5.5 14.3 4" />
        </>
      );
    // Ajustar: setas nas quatro direções.
    case 'adjust':
    case 'drag-to-move':
      return (
        <>
          <path d="M12 3.5v17M3.5 12h17" />
          <path d="m9 6.5 3-3 3 3M9 17.5l3 3 3-3M6.5 9l-3 3 3 3M17.5 9l3 3-3 3" />
        </>
      );
    // Travado: cadeado fechado.
    case 'placed':
      return (
        <>
          <rect x="5" y="10.5" width="14" height="10" rx="2" />
          <path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3" />
        </>
      );
    default:
      return null;
  }
}

export function CoachIcon({ hint }: CoachIconProps): React.ReactElement | null {
  const shape = path(hint);
  if (!shape) return null;

  return (
    <svg className="fv-coach-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g {...STROKE}>{shape}</g>
    </svg>
  );
}
