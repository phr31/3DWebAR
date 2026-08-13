'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { detectCapabilities, type ProductData } from 'webar-frame-viewer/core';

/**
 * `ssr: false` é obrigatório: o `FrameViewer` monta um `<Canvas>` do R3F, que
 * toca em `window` já na importação. Carregar sob demanda também mantém o three,
 * o R3F e o @react-three/xr fora do bundle inicial da página de produto — eles
 * só chegam quando o usuário decide ver na parede.
 */
const FrameViewer = dynamic(() => import('webar-frame-viewer').then((mod) => mod.FrameViewer), {
  ssr: false,
});

export function ProductAR({ product }: { product: ProductData }) {
  const [isOpen, setIsOpen] = useState(false);
  const [supported, setSupported] = useState<boolean | null>(null);
  // `?debug=1` liga o HUD com engine e sensores. Num effect, e não durante o
  // render, porque este componente também é renderizado no servidor.
  const [debug, setDebug] = useState(false);

  useEffect(() => {
    setDebug(new URLSearchParams(window.location.search).has('debug'));
  }, []);

  // `detectCapabilities` vem de `/core`, que é server-safe e não arrasta React
  // nem three — dá para checar suporte sem pagar o bundle da experiência.
  useEffect(() => {
    void detectCapabilities().then((caps) => setSupported(caps.recommended !== null));
  }, []);

  if (supported === false) {
    return (
      <p style={{ color: '#666' }}>Seu dispositivo não é compatível com Realidade Aumentada.</p>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        disabled={supported === null}
        style={{
          width: '100%',
          padding: 16,
          fontSize: 17,
          fontWeight: 600,
          border: 0,
          borderRadius: 999,
          background: '#16a34a',
          color: '#fff',
        }}
      >
        Ver na sua Parede
      </button>

      {isOpen && (
        <FrameViewer
          product={product}
          options={{
            debug,
            // O fluxo de orientação (apontar → tocar → ajustar → 🔒) já vem
            // pronto; `strings` só existe para ajustar o tom da loja. Frases
            // curtas: elas ficam sobre a parede e somem sozinhas.
            strings: {
              'hint.scan': 'Aponte para onde o quadro vai ficar',
              'hint.adjust': 'Arraste para ajustar · 🔒 trava',
            },
          }}
          onClose={() => setIsOpen(false)}
          // Dispara ao ANCORAR (primeiro toque), não ao travar: é o momento em
          // que o cliente escolheu a parede.
          onPlace={(info) => console.log('Quadro posicionado em:', info.position)}
          onError={(err) => console.error(err.code, err.userMessage)}
        />
      )}
    </>
  );
}
