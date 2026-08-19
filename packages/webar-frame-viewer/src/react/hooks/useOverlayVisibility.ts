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
 * Piso entre re-armadas do temporizador de ociosidade.
 *
 * `pointermove` chega a 60–120 Hz durante um arraste, e cada evento derrubava e
 * recriava um `setTimeout`. Com um piso muito menor do que `IDLE_MS`, a precisão
 * percebida é a mesma e o churn de temporizador some.
 */
const IDLE_REARM_MS = 500;

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
    // Passivo: só lê o evento, nunca chama `preventDefault` — e o toque no palco
    // é justamente o que precisa chegar ao WebXR sem atraso.
    stage.addEventListener('pointerdown', dismiss, { passive: true });
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
  const armedAtRef = useRef(0);

  useEffect(() => {
    if (!root || !active) {
      setIdle(false);
      return;
    }

    const arm = (now: number): void => {
      armedAtRef.current = now;
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setIdle(true), IDLE_MS);
    };
    const wake = (): void => {
      setIdle(false);
      // Durante um arraste isto chega dezenas de vezes por segundo; re-armar em
      // todas só trocaria um temporizador por outro idêntico.
      const now = performance.now();
      if (now - armedAtRef.current >= IDLE_REARM_MS) arm(now);
    };

    arm(performance.now());
    root.addEventListener('pointerdown', wake, { passive: true });
    root.addEventListener('pointermove', wake, { passive: true });
    return () => {
      window.clearTimeout(timerRef.current);
      root.removeEventListener('pointerdown', wake);
      root.removeEventListener('pointermove', wake);
    };
  }, [root, active]);

  return idle;
}
