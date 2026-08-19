'use client';

import { useXR } from '@react-three/xr';
import { useEffect, useRef } from 'react';
import type { ARApi } from '../hooks/useAR';

/**
 * O ciclo de vida da XRSession, num lugar só.
 *
 * O @react-three/xr não emite `sessionend`: no fim da sessão ele apenas zera a
 * própria store, então a transição `session != null → null` É o evento. Ela é
 * observada aqui com `useXR`, e não com `xrStore.subscribe` lá no
 * `<FrameViewer>`, porque a MESMA informação decide o render — a cena desmonta
 * junto com a sessão, e isso tem que ser estado de React de qualquer forma.
 *
 * E ela precisa mesmo desmontar: o `useXRAnchor` só solta a âncora no unmount, e
 * uma âncora da sessão anterior é veneno no `getPose` da sessão nova. De quebra,
 * a hit-test source (que é por sessão) e todas as refs de pose nascem limpas —
 * em vez de meia dúzia de resets manuais, um dos quais alguém esqueceria.
 *
 * Sem o portão, sair do AR pelo botão do sistema deixava o overlay preso: o
 * `useFrame` continua rodando depois que a sessão morre, então o HUD de AR ficava
 * na tela sem câmera e o botão de iniciar não voltava, porque o CSS só o mostra
 * em `data-fv-state="idle"`.
 */

export interface XRSessionGateProps {
  api: ARApi;
  children: React.ReactNode;
}

export function XRSessionGate({ api, children }: XRSessionGateProps): React.ReactElement {
  const session = useXR((state) => state.session);
  const hadSessionRef = useRef(false);

  // Uma ref, e não o cleanup do efeito: o StrictMode duplica cleanups na
  // montagem, e a transição explícita "houve sessão → não há mais" é idempotente
  // sob qualquer duplicação.
  //
  // A ordem do commit importa e é a que se quer: o React roda os cleanups dos
  // filhos removidos ANTES do efeito do pai, então a `XRScene` já guardou a pose
  // retida quando o `reportSessionEnded` volta o overlay para 'idle'.
  useEffect(() => {
    if (session) {
      hadSessionRef.current = true;
      return;
    }
    if (!hadSessionRef.current) return;
    hadSessionRef.current = false;
    api.reportSessionEnded();
  }, [session, api]);

  return <>{session ? children : null}</>;
}
