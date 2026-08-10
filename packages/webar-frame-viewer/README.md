# webar-frame-viewer

**Veja o quadro na sua parede, no tamanho real, direto no navegador do celular — sem instalar aplicativo.**

Um micro front-end que abre a câmera, detecta a parede e desenha o quadro na escala
física real, com moldura, passe-partout e sombra em 3D. WebXR onde existe, câmera ao
vivo (`getUserMedia` + Three.js) no resto — inclusive em todo iPhone.

📖 **[Documentação completa no GitHub](https://github.com/phr31/3DWebAR#readme)**

---

## Instalação

```bash
npm install webar-frame-viewer three
```

`three` é *peer dependency* (`>=0.160.0 <1.0.0`) e é carregado por `import()` dinâmico —
nunca entra no bundle inicial da sua página. `react` e `react-dom` (`>=18`) só são
necessários para o subcaminho `/react`.

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

### ESM / bundler

```ts
import { createViewer, detectCapabilities } from 'webar-frame-viewer';

const caps = await detectCapabilities();
if (!caps.recommended) return; // esconda o botão

const viewer = createViewer({ container, product });
await viewer.start();
```

### React / Next.js

```tsx
'use client';
import { FrameViewer } from 'webar-frame-viewer/react';

<FrameViewer product={product} onClose={() => setAberto(false)} />;
```

Não precisa de `next/dynamic` nem `ssr: false`: o componente renderiza uma `<div>` vazia
no servidor e monta o overlay em `useEffect`. O entry `webar-frame-viewer` é seguro no
servidor; só `webar-frame-viewer/react` carrega a diretiva `"use client"`.

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
