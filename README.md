# 3DWebAR — `webar-frame-viewer`

Micro front-end para visualizar quadros na parede em Realidade Aumentada, direto
no navegador do celular, sem instalar aplicativo.

```
packages/webar-frame-viewer/   a biblioteca
examples/vanilla/              exemplo com <script> UMD
examples/nextjs/               exemplo App Router
```

## Como funciona

Dois engines atrás da mesma interface `SceneManager`, escolhidos em runtime:

| Engine | Onde roda | O que entrega |
|---|---|---|
| **WebXR** (`immersive-ar` + `hit-test`) | Chrome/Android com ARCore | escala física real, tracking 6-DoF, quadro ancorado na parede |
| **Passthrough** (`getUserMedia` + Three.js) | iPhone e todo o resto | câmera ao vivo, arrastar/pinçar, giroscópio 3-DoF |

### Duas coisas que precisam estar claras desde o início

1. **AR.js/A-Frame não serve para este produto.** É marker-based e location-based
   — não detecta planos. Pendurar na parede com AR.js exigiria imprimir e colar
   um marcador. Por isso a escolha é WebXR + Three.js.
2. **Safari iOS não tem WebXR.** `navigator.xr` é `undefined` em 100% dos
   iPhones. Todo iPhone cai no engine de passthrough — sem paralaxe ao andar e
   sem escala automática. Isso não é bug, é o estado da plataforma.

## Uso

### Vanilla (CDN)

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

### React / Next.js

```tsx
'use client';
import { FrameViewer } from 'webar-frame-viewer/react';

<FrameViewer product={product} onClose={() => setIsOpen(false)} />
```

O componente não tem problema de hidratação: renderiza uma `<div>` vazia no
servidor e monta o overlay em `useEffect`. Não precisa de `next/dynamic`.

### Esconder o botão quando não dá

```ts
const caps = await FrameViewer.isSupported();
if (!caps.recommended) hideButton();
```

## Requisitos de integração

- **HTTPS obrigatório.** `getUserMedia` e `navigator.xr` só existem em secure
  context. `http://192.168.x.x` do XAMPP **não** funciona.
- **CORS no CDN de imagens.** Sem `Access-Control-Allow-Origin` a lib não
  funciona — o WebGL recusa uploads de textura cross-origin (`texImage2D` lança
  `SECURITY_ERR`). Não é degradação, é falha total. Verifique isso no CDN de
  produção antes de integrar.
- **`three` é peer dependency.** Carregado por `import()` dinâmico, nunca no
  bundle inicial. Em lojas com CSP `script-src` restritiva, injete a sua própria
  instância com `provideThree()` ou aponte `options.threeUrl`.

## Desenvolvimento

```powershell
npm install
npm run build          # tsup: ESM + CJS + UMD + .d.ts, depois o guard de tamanho
npm run dev            # tsup --watch
npm run typecheck
```

### Testar no celular (o passo que mais trava)

O único método que cobre Android **e** iPhone, com certificado confiável, sem
conta e sem instalar CA:

```powershell
winget install --id Cloudflare.cloudflared     # uma vez

# terminal 1 — sirva os arquivos
#   XAMPP já serve examples/vanilla em http://localhost/3DWebAR/examples/vanilla/
npm run ex:next                                # ou o exemplo Next em :3000

# terminal 2 — abra o túnel
npm run tunnel:xampp                           # ou npm run tunnel:next
```

Abra no celular a URL `https://*.trycloudflare.com` que o cloudflared imprimir.

Alternativa só-Android, com latência mínima e zero certificado: depuração USB +
`chrome://inspect` → *Port forwarding*. `http://localhost:*` é trustworthy origin
por definição, e o `immersive-ar` funciona de verdade ali.

## Verificações de empacotamento

```powershell
npm run check:pkg
Get-Content packages\webar-frame-viewer\dist\react.mjs -TotalCount 1   # DEVE ser: "use client";
Get-Content packages\webar-frame-viewer\dist\index.mjs -TotalCount 1   # NÃO deve ter "use client"
npm run size
```

## Limitações conhecidas

| Limitação | Impacto |
|---|---|
| Webview do Instagram/Facebook bloqueia `getUserMedia` | Detectado; o overlay pede para abrir no navegador |
| ARCore não detecta parede branca e lisa | Após 6 s aparece "Posicionar manualmente", que mantém tracking 6-DoF |
| Captura de tela indisponível no WebXR | O framebuffer XR não contém a câmera; o botão de foto não aparece no Android |
| FOV real da câmera não é legível por API | O passthrough assume 68°, calibrável via `options.assumedCameraFovH` |
| iOS sem paralaxe | Giroscópio 3-DoF com deriva; há botão de recentralizar |

## Licença

MIT
