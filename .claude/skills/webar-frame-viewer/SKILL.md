---
name: webar-frame-viewer
description: Arquitetura do pacote webar-frame-viewer deste repositório — os dois engines de AR (WebXR immersive-ar vs passthrough por câmera e giroscópio), detecção de capabilities e navegadores in-app, hit-test de parede com histerese, construção procedural da moldura, a fronteira core/ (vanilla) vs react/ (R3F + @react-three/xr) e o build tsup com "use client". Use ao alterar qualquer arquivo em packages/webar-frame-viewer, depurar sessão XR, permissão de câmera ou posicionamento do quadro, ajustar gestos, ou mexer em exports e bundle do pacote.
---

# webar-frame-viewer

Visualizador de quadros em Realidade Aumentada no navegador. O usuário aponta o
celular para a parede e vê a moldura no tamanho real, na escala certa.

**Stack:** React 19 · R3F 9 · `@react-three/xr` 6 · three 0.185 · TypeScript ·
tsup · Biome. Monorepo npm workspaces: `packages/webar-frame-viewer` é a
biblioteca; `examples/nextjs` e `examples/vanilla` a consomem.

---

## Invariantes — não quebre sem discutir

**1. Zero dependências de runtime.** O `package.json` declara
`dependencies: {}`. Tudo é `peerDependencies` (`three`, `react`, `react-dom`,
`@react-three/fiber`, `@react-three/xr`). É por isso que `react/store.ts` usa
`useSyncExternalStore` em vez de zustand — as ~40 linhas economizadas não valem
a dependência. Antes de instalar qualquer pacote, pergunte.

**2. `start()` nunca rejeita.** Uma unhandled rejection no navegador de um
comprador não é aceitável. Toda falha vira `status: 'error'` + callback
`onError`. Ver `react/hooks/useAR.ts`.

**3. `XR_SESSION_FAILED` com `getUserMedia` disponível cai silenciosamente para
passthrough.** Sem mostrar erro ao usuário — o AR simplesmente acontece de outro
jeito.

**4. `XR_GESTURE_REQUIRED` volta para `idle`, não é erro.** É a sessão XR
pedindo um toque do usuário; o botão reaparece.

**5. O SceneManager é dono do próprio relógio.** Não existe `render()`,
`tick()` nem `onFrame()` na interface (`core/SceneManager.ts`), e o
`ARController` nunca causa um frame. `WebGLRenderer.setAnimationLoop` já
despacha para `XRSession.requestAnimationFrame` quando `xr.isPresenting` e para
`window.requestAnimationFrame` caso contrário — os dois engines usam a mesma
chamada. Nunca dispare render de fora do engine.

**6. `data-fv-state` no DOM é contrato público de tema**, documentado no README.
Hoje é derivado do store, mas o atributo não pode sumir.

---

## Mapa do pacote

```
src/
├── core/          lógica sem React — usável em qualquer app
│   ├── ARController.ts       orquestrador do caminho vanilla
│   ├── SceneManager.ts       interface dos engines + SceneCapabilities
│   ├── engines/
│   │   ├── WebXRSceneManager.ts        immersive-ar + hit-test
│   │   └── PassthroughSceneManager.ts  <video> + giroscópio + gestos
│   ├── capabilities.ts       detectCapabilities() → recomenda o engine
│   ├── FrameBuilder.ts       constrói a moldura proceduralmente
│   ├── xr/hitTest.ts         filtro/histerese, compartilhado com o React
│   ├── passthrough/          camera, orientation, frustum, ambient
│   ├── GestureController.ts  pan, pinça, rotação, tap, mira
│   ├── errors.ts             ARErrorCode + mensagens pt-BR
│   └── capture.ts            screenshot / compartilhamento
├── react/         caminho R3F
│   ├── FrameViewer.tsx       componente público
│   ├── hooks/useAR.ts        orquestrador do caminho React
│   ├── store.ts              useSyncExternalStore
│   └── components/           ARCanvas, XRScene, PassthroughScene, Overlay…
├── vanilla/createViewer.ts   fachada imperativa
├── ui/                       overlay DOM, strings, injectStyles
└── umd.ts                    entry do bundle UMD
```

**A confusão mais comum:** `useAR.ts` **substitui** o `ARController` no caminho
React — não o embrulha. São dois orquestradores paralelos que reproduzem o mesmo
comportamento de produto. Uma correção de lógica de sessão geralmente precisa ser
aplicada **nos dois**.

---

## Escolha de engine

`SceneKind = 'webxr' | 'passthrough'`. Quem decide é
`detectCapabilities()` em `core/capabilities.ts`, que devolve
`recommended: SceneKind | null` — `null` significa que a experiência não pode
ser oferecida.

| Caminho | Quando | Capacidades |
|---|---|---|
| `webxr` | Android/Chrome com `immersive-ar` | 6DoF, hit-test real, quadro fica na parede |
| `passthrough` | iOS e qualquer aparelho sem WebXR | `<video>` + giroscópio + gestos, sem world tracking |

`options.engine` força um dos dois — **existe só para QA**, não para lógica de
produto.

A detecção inclui **navegadores in-app** (`facebook`, `instagram`, `tiktok`,
`line`, `wechat`). É onde o AR quebra na prática: o link vem do Instagram e a
WebView não tem WebXR nem, às vezes, `getUserMedia`. Ao mexer em capabilities,
teste esse caminho.

### Códigos de erro

`INSECURE_CONTEXT` · `NO_AR_SUPPORT` · `WEBGL_UNAVAILABLE` · `IN_APP_BROWSER` ·
`ENGINE_LOAD_FAILED` · `ASSET_LOAD_FAILED` · `INVALID_PRODUCT` ·
`INVALID_STATE` · `CAMERA_DENIED` · `CAMERA_UNAVAILABLE` · `CAMERA_IN_USE` ·
`XR_SESSION_FAILED` · `XR_GESTURE_REQUIRED` · `SESSION_LOST` · `CONTEXT_LOST`

As mensagens ao usuário são pt-BR e ficam em `core/errors.ts`. Erros novos
precisam de mensagem — não deixe cair no genérico.

---

## Hit-test de parede

Tudo em `core/xr/hitTest.ts`, sem dependência de `XRFrame`, renderer ou React —
por isso serve tanto ao `WebXRSceneManager` quanto ao hook `useHitTest`.
**Ajuste em um lugar só.**

| Constante | Valor | Porquê |
|---|---|---|
| `STABLE_FRAMES` | 5 | frames válidos consecutivos antes de aceitar; sem isso o reticle pisca |
| `HIT_GRACE_MS` | 200 | carência sem hit antes de esconder o reticle |
| `MIN_HIT_M` / `MAX_HIT_M` | 0.4 / 6 | além de ~5 m o ARCore está chutando |
| `WALL_GAP` | 0.005 | folga p/ a peça não entrar na parede quando o plano erra |
| `SMOOTHING` | 0.25 | suavização do candidato |

`HitOutcome` = `stable` · `settling` · `grace` · `lost` (com `sawHits` indicando
que havia hits, mas eram chão ou teto). O filtro parede-vs-chão é
`isWallNormal` / `wallBasis` em `core/TransformUtils.ts`.

**Sintoma → causa:** reticle piscando → `STABLE_FRAMES`/`HIT_GRACE_MS`; quadro
entrando na parede → `WALL_GAP`; alvo "escorregando" → `SMOOTHING`.

---

## Moldura

`core/FrameBuilder.ts` constrói tudo **proceduralmente** — não há GLTF/GLB em
lugar nenhum do pacote. `buildFrame()` devolve `BuiltFrame` com `group`,
`metrics`, `setAmbient()`, `setOpacity()` e `dispose()`. Medidas vêm em cm e
passam por `cmToM` / `computeFit` (`TransformUtils.ts`).

Duas armadilhas já resolvidas, documentadas em comentários no arquivo — leia
antes de mexer:

- **`WALL_OFFSET = 0.002`** evita z-fighting entre o fundo da moldura e a parede.
- **A sombra não é sombra.** O framebuffer WebGL não contém a imagem da câmera
  (a cena é renderizada com alpha, o vídeo fica atrás), então `MultiplyBlending`
  e `CustomBlending` com `DstColorFactor` — a primeira ideia de todo mundo — não
  funcionam. O que funciona é um quad translúcido preto a 38% com
  `NormalBlending`.

---

## Gestos

`core/GestureController.ts` emite `onPan` (delta, ajuste fino), `onPinch`
(`factor > 1` = afastar os dedos), `onRotate`, `onTap` e `onAim`. O `onAim`
entrega ponto **absoluto** do dedo e só é emitido com um único ponteiro — com
dois o gesto é pinça/rotação e mirar no meio disso seria ruído.

Quais gestos valem depende do engine: `SceneCapabilities.gestures`
(`move`/`distance`/`roll`) declara o que cada um suporta. Também em
`SceneCapabilities`: `canCapture` é **false no WebXR** — `capture()` não
consegue devolver um Blob lá (ver `core/capture.ts`).

---

## Build

`tsup.config.ts` tem particularidades deliberadas:

- **Configs separadas para `react` e `core`.** Se compartilhassem, o banner
  `"use client"` contaminaria o bundle server-safe e ele viraria uma client
  reference inutilizável.
- **`treeshake: false`** — o Rollup roda por cima do esbuild e mexe na diretiva
  `"use client"`.
- **`clean: false`** — a limpeza é do script `prebuild`; configs em array podem
  rodar em paralelo e um `clean` apagaria a saída do outro.
- **Sempre external:** `three`, `react`, `react-dom`, `react/jsx-runtime`,
  `@react-three/fiber`, `@react-three/xr`.

Exports do `package.json` (`.`, `./core`, `./react`, `./styles.css`, `./umd`)
são contrato público — alterar quebra quem já integrou.

---

## Verificação

```bash
npm run typecheck     # tsc --noEmit em todos os workspaces
npm run lint          # biome check
npm run format        # biome check --write
npm run build         # tsup + relatório de tamanho
npm run size          # orçamento de bundle
npm run dev           # watch do pacote
npm run ex:next       # exemplo Next.js
```

**Para testar AR de verdade é obrigatório sair do localhost.** WebXR e
`getUserMedia` exigem contexto seguro, e o desktop não reproduz o
comportamento do celular:

```bash
npm run mobile        # dev server + túnel
npm run tunnel        # cloudflared para :8080
npm run serve         # server local simples
```

Roteiro mínimo de QA quando mexer em sessão, câmera ou posicionamento: Android
Chrome (caminho `webxr`), iOS Safari (caminho `passthrough`) e o link aberto
dentro do Instagram (caminho in-app browser).
