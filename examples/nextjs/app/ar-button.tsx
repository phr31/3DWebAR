'use client';

import { useEffect, useState } from 'react';
import { detectCapabilities, FrameViewer, type ProductData } from 'webar-frame-viewer/react';

export function ProductAR({ product }: { product: ProductData }) {
  const [isOpen, setIsOpen] = useState(false);
  const [supported, setSupported] = useState<boolean | null>(null);

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
          onClose={() => setIsOpen(false)}
          onPlace={(info) => console.log('Quadro posicionado em:', info.position)}
          onError={(err) => console.error(err.code, err.userMessage)}
        />
      )}
    </>
  );
}
