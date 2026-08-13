'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Os dois temporizadores que mantêm a interface fora do caminho.
 *
 * São dois, e não um, porque o requisito pede coisas opostas: a dica some ao
 * interagir (já cumpriu o papel — o usuário fez o que ela mandava), enquanto os
 * controles reaparecem ao interagir e só somem parados. Um único timer não
 * conseguiria os dois comportamentos.
 */

/** Tempo de leitura de uma frase curta, com folga. */
const HINT_MS = 5000;
/** Inatividade até a interface sair da frente da parede. */
const IDLE_MS = 5000;

/**
 * Visibilidade da dica: aparece a cada MUDANÇA de mensagem, some sozinha depois
 * de alguns segundos ou no primeiro toque no palco — o que vier antes.
 *
 * `key` é o que identifica "outra mensagem". Repetir a mesma dica não reabre o
 * texto, senão a linha piscaria a cada ida e volta do hit-test.
 */
export function useCoachHint(key: string | null, stage: HTMLElement | null): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!key) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), HINT_MS);
    return () => window.clearTimeout(timer);
  }, [key]);

  useEffect(() => {
    if (!stage || !visible) return;
    const dismiss = (): void => setVisible(false);
    stage.addEventListener('pointerdown', dismiss);
    return () => stage.removeEventListener('pointerdown', dismiss);
  }, [stage, visible]);

  return visible;
}

/**
 * Ociosidade da interface: 5 s sem toque e os controles somem; qualquer toque os
 * traz de volta.
 *
 * `active` desliga o comportamento fora dos estados em que ele faz sentido —
 * esconder o botão de iniciar, o spinner ou um painel de erro seria deixar o
 * usuário sem saída.
 */
export function useIdleChrome(root: HTMLElement | null, active: boolean): boolean {
  const [idle, setIdle] = useState(false);
  const timerRef = useRef(0);

  useEffect(() => {
    if (!root || !active) {
      setIdle(false);
      return;
    }

    const arm = (): void => {
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setIdle(true), IDLE_MS);
    };
    const wake = (): void => {
      setIdle(false);
      arm();
    };

    arm();
    root.addEventListener('pointerdown', wake);
    root.addEventListener('pointermove', wake);
    return () => {
      window.clearTimeout(timerRef.current);
      root.removeEventListener('pointerdown', wake);
      root.removeEventListener('pointermove', wake);
    };
  }, [root, active]);

  return idle;
}
