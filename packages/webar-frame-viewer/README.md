# webar-frame-viewer

**Veja o quadro na sua parede, no tamanho real, direto no navegador do celular — sem instalar aplicativo.**

Um micro front-end que abre a câmera, detecta a parede e desenha o quadro na escala
física real, com moldura, passe-partout e sombra em 3D. WebXR onde existe, câmera ao
vivo (`getUserMedia` + Three.js) no resto — inclusive em todo iPhone.

📖 **[Documentação completa no GitHub](https://github.com/phr31/3DWebAR#readme)**

---

## Instalação

```bash
npm install webar-frame-viewer three react react-dom @react-three/fiber @react-three/xr
```

Todos são *peer dependencies*. Para consumo por `<script>` (CDN) não se instala nada:
o bundle UMD tem 15,8 KB gzip, busca o `three` sozinho e não usa React nem R3F.

## Uso

### Vanilla / `<script>`

```html
<script src="https://unpkg.com/webar-frame-viewer/dist/frame-viewer.umd.min.js"></script>
<script>
  const viewer = FrameViewer.create({
    container: document.getElementById('root'),
    product: { id: 'p1', imageUrl: '/quadro.jpg', widthCm: 50, heightCm: 70 },
  });
  viewer.start();
</script>
```

> A API imperativa (`ARController` / `create()`) existe **apenas** no build UMD acima.
> Em bundler, o caminho é o componente React.

### React / Next.js

```tsx
'use client';
import dynamic from 'next/dynamic';
import { detectCapabilities } from 'webar-frame-viewer/core';

// `ssr: false` é obrigatório: o <Canvas> do R3F toca em `window` na importação.
const FrameViewer = dynamic(
  () => import('webar-frame-viewer').then((m) => m.FrameViewer),
  { ssr: false },
);

<FrameViewer product={product} onClose={() => setAberto(false)} />;
```

Use `webar-frame-viewer/core` para checar suporte (`detectCapabilities`) e para os
tipos: esse subcaminho é *server-safe*, não tem `"use client"` e não arrasta React,
`three` nem R3F — dá para esconder o botão sem pagar o bundle da experiência.

## Compatibilidade

| Dispositivo | Engine | O que entrega |
|---|---|---|
| Android + Chrome com ARCore | `webxr` | Escala real, tracking 6-DoF, quadro ancorado na parede |
| iPhone / iPad (qualquer navegador) | `passthrough` | Câmera ao vivo, arrastar/pinçar, giroscópio 3-DoF |
| Android sem ARCore, desktop com webcam | `passthrough` | Idem acima |
| Webview de Instagram/Facebook/TikTok | — | Bloqueado pela plataforma; o overlay pede para abrir no navegador |

Safari iOS não tem WebXR (`navigator.xr` é `undefined`): todo iPhone usa o engine de
passthrough — sem paralaxe ao andar. Isso é o estado da plataforma, não um defeito da lib.

## Requisitos duros

- **HTTPS obrigatório.** `getUserMedia` e `navigator.xr` só existem em *secure context*.
- **CORS no CDN das imagens.** Sem `Access-Control-Allow-Origin`, o WebGL recusa uploads
  de textura *cross-origin* (`texImage2D` lança `SECURITY_ERR`). É falha total, não
  degradação — verifique no CDN de produção antes de integrar.
- **`three` como peer dependency.** Em ambientes com CSP restritiva, injete a sua própria
  instância com `provideThree()` ou aponte `options.threeUrl`.
- **Chame `destroy()` ao fechar.** No iOS o Safari não libera contextos WebGL de forma
  agressiva, e uma SPA acumula "Too many active WebGL contexts".

## Principais opções

| Opção | Padrão | Descrição |
|---|---|---|
| `autoStart` | `false` | `requestSession('immersive-ar')` exige gesto do usuário; mantenha `false` |
| `autoPlaceOnPlane` | `true` | Segue o plano detectado até o toque fixar |
| `allowRotate` / `allowScale` | `true` | Gestos (só no engine de passthrough) |
| `engine` | auto | Força `'webxr'` ou `'passthrough'`. Útil para QA |
| `frame` | ver abaixo | `fit`, `frameWidthCm`, `frameColor`, `matCm`, `matColor`, `shadow` |
| `assumedCameraFovH` | `68` | FOV horizontal assumido no passthrough, em graus |
| `assumedWallDistanceM` | `2` | Distância inicial assumida até a parede |
| `noHitTimeoutMs` | `6000` | Tempo sem hit antes de oferecer posicionamento manual |
| `wallToleranceDeg` | `15` | Tolerância angular para aceitar uma superfície como parede |
| `locale` | `'pt-BR'` | `'pt-BR'` ou `'en'` |
| `strings` | `{}` | Sobrescreve textos individuais do overlay |
| `threeUrl` | — | URL de um build ESM do `three`, para CSP restritiva |
| `onReady` / `onPlace` / `onError` / `onClose` | — | Callbacks |

Estilo padrão da moldura: `fit: 'contain'`, `frameWidthCm: 2`, `frameColor: '#2b2118'`,
`matCm: 0`, `matColor: '#f4f1ea'`, `shadow: 'soft'`.

`widthCm` e `heightCm` são as medidas **externas, com moldura** — como o e-commerce
anuncia o produto.

## API resumida

```ts
viewer.status;            // 'idle' | 'loading' | 'ready' | 'placing' | 'placed' | 'paused' | 'error' | 'destroyed'
viewer.engine;            // 'webxr' | 'passthrough' | null
viewer.on('placed', fn);  // status | hint | engine | placed | unplaced | error | close
await viewer.start();     // nunca rejeita — falhas viram evento 'error'
viewer.place();
viewer.reset();
viewer.pause();
await viewer.resume();
await viewer.setProduct(outroProduto);
await viewer.capture();   // Blob JPEG; null no engine WebXR
await viewer.destroy();
```

Também exportados: `detectCapabilities`, `ARError`, `userMessage`, `provideThree`,
`preload`, `clearAssets` e todos os tipos.

## Privacidade

Nenhuma imagem sai do aparelho. Sem upload, sem telemetria — só o download da arte e do
`three`. A foto é composta localmente e entregue à *share sheet* nativa.

## Licença

MIT © 2026 phr31
