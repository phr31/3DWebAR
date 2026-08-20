import { type KitData, kitBounds, layoutKit, type ProductData } from 'webar-frame-viewer/core';
import { ProductAR } from './ar-button';

// Server Component: nada de AR aqui. O subpath `/core` é server-safe por
// construção — não tem a diretiva "use client" e não toca em nenhum global de
// navegador no escopo do módulo. `layoutKit` é aritmética pura, então o arranjo
// do kit pode ser calculado no SERVIDOR e chegar pronto ao cliente.
const product: ProductData = {
  id: 'prod-001',
  title: 'Quadro Abstrato 50 × 70',
  imageUrl: '/quadro.png',
  widthCm: 50,
  heightCm: 70,
  depthCm: 3,
};

// Trio 30 × 40 lado a lado, 8 cm de vão. `layoutKit` preenche os offsets; um
// arranjo assimétrico seria escrito à mão com `offsetXCm`/`offsetYCm`.
const kit: KitData = {
  id: 'kit-trio',
  title: 'Trio Abstrato 30 × 40',
  items: layoutKit(
    ['a', 'b', 'c'].map((suffix) => ({
      id: `kit-trio-${suffix}`,
      imageUrl: '/quadro.png',
      widthCm: 30,
      heightCm: 40,
      depthCm: 3,
    })),
    { layout: 'row', gapCm: 8 },
  ),
};

const bounds = kitBounds(kit.items);

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

      <hr style={{ margin: '32px 0', border: 0, borderTop: '1px solid #e5e5e5' }} />

      <h2>{kit.title}</h2>
      <p style={{ color: '#666' }}>
        {kit.items.length} peças de {kit.items[0]?.widthCm} × {kit.items[0]?.heightCm} cm — o
        conjunto ocupa {bounds.widthCm} × {bounds.heightCm} cm de parede
      </p>
      <ProductAR kit={kit} />
    </main>
  );
}
