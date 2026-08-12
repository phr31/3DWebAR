import type { ProductData } from 'webar-frame-viewer/core';
import { ProductAR } from './ar-button';

// Server Component: nada de AR aqui. O subpath `/core` é server-safe por
// construção — não tem a diretiva "use client" e não toca em nenhum global de
// navegador no escopo do módulo.
const product: ProductData = {
  id: 'prod-001',
  title: 'Quadro Abstrato 50 × 70',
  imageUrl: '/quadro.png',
  widthCm: 50,
  heightCm: 70,
  depthCm: 3,
};

export default function Page() {
  return (
    <main style={{ maxWidth: '32rem', margin: '0 auto', padding: 24 }}>
      <h1>{product.title}</h1>
      {/* biome-ignore lint/performance/noImgElement: exemplo mínimo, sem next/image */}
      <img
        src={product.imageUrl}
        alt={product.title}
        style={{ width: '100%', borderRadius: 8, background: '#eee' }}
      />
      <p style={{ color: '#666' }}>
        {product.widthCm} × {product.heightCm} cm
      </p>
      <ProductAR product={product} />
    </main>
  );
}
