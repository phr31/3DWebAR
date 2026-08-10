import type { ProductData } from 'webar-frame-viewer';
import { ProductAR } from './ar-button';

// Server Component: nada de AR aqui. O import de `webar-frame-viewer` traz só
// tipos, então nenhum browser global é tocado na renderização do servidor.
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
