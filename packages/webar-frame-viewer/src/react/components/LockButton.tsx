'use client';

import type { StringKey } from '../../ui/strings';

/**
 * Cadeado de travamento da posição.
 *
 * É o único controle que sobrevive à ociosidade (o CSS só reduz a opacidade):
 * sumir de vez deixaria o usuário sem como congelar o quadro sem antes acordar a
 * interface. Precisa ficar dentro de `.fv-ui`, onde o `beforexrselect` é
 * bloqueado — fora dali o toque no botão também dispararia `select` na sessão XR.
 */

export interface LockButtonProps {
  locked: boolean;
  t(key: StringKey): string;
  onToggle(): void;
}

export function LockButton({ locked, t, onToggle }: LockButtonProps): React.ReactElement {
  return (
    <button
      type="button"
      className="fv-btn fv-btn--icon fv-lock"
      // `aria-pressed` e não um label que muda sozinho: é um botão de dois
      // estados, e o leitor de tela anuncia "pressionado" sem precisar de texto.
      aria-pressed={locked}
      aria-label={t(locked ? 'unlock' : 'lock')}
      onClick={onToggle}
    >
      {locked ? '🔒' : '🔓'}
    </button>
  );
}
