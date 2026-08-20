---
name: 3d-web-experience
description: Padrões de cena Three.js e React Three Fiber — seleção de stack, materiais, luzes, câmera, loaders GLTF, orçamento de performance (draw calls, DPR, instancing, LOD) e estratégias de fallback quando não há WebGL. Use ao criar ou revisar uma cena 3D, ajustar iluminação ou materiais, otimizar FPS em mobile, preparar modelos para a web, ou decidir entre Three.js imperativo e R3F declarativo.
metadata:
  source: vibeship-spawner-skills (Apache 2.0)
  merged_from: 3d-visualizer (daffy0208/ai-dev-standards)
  date_added: 2026-02-27
---

# 3D Web Experience

Arquiteto de experiências 3D na web. Sabe quando 3D agrega e quando é só
exibicionismo; equilibra impacto visual com performance; torna 3D acessível
para quem nunca usou um app 3D.

> Para arquitetura multi-biblioteca (R3F + GSAP + Motion + React Spring),
> estado compartilhado entre cena e UI, e animação dirigida por scroll, use
> `web3d-integration-patterns` — esta skill cobre a cena em si.
>
> Para o pacote `webar-frame-viewer` deste repositório (WebXR, passthrough,
> hit-test), use `webar-frame-viewer`.

## Seleção de stack

| Ferramenta | Melhor para | Curva | Controle |
|---|---|---|---|
| Spline | Protótipos rápidos, designers | Baixa | Médio |
| React Three Fiber | Apps React, cenas complexas | Média | Alto |
| Three.js vanilla | Controle máximo, não-React | Alta | Máximo |
| Babylon.js | Jogos, 3D pesado | Alta | Máximo |

```
Precisa de um elemento 3D rápido?  → Spline
Usa React?                          → React Three Fiber
Precisa de controle/performance máx? → Three.js vanilla
```

### React Three Fiber — cena mínima

```jsx
import { Canvas } from '@react-three/fiber';
import { OrbitControls, useGLTF } from '@react-three/drei';

function Model() {
  const { scene } = useGLTF('/model.glb');
  return <primitive object={scene} />;
}

export default function Scene() {
  return (
    <Canvas camera={{ position: [5, 5, 5], fov: 50 }}>
      <ambientLight intensity={0.5} />
      <pointLight position={[10, 10, 10]} />
      <Model />
      <OrbitControls />
    </Canvas>
  );
}
```

### Animação por frame

`useFrame` recebe `delta` — use-o em vez de somar constantes, senão a
velocidade muda conforme o FPS do aparelho.

```jsx
function RotatingCube() {
  const meshRef = useRef<Mesh>(null);

  useFrame((state, delta) => {
    if (!meshRef.current) return;
    meshRef.current.rotation.x += delta;
    meshRef.current.rotation.y += delta * 0.5;
  });

  return (
    <mesh ref={meshRef}>
      <boxGeometry args={[2, 2, 2]} />
      <meshStandardMaterial color="orange" />
    </mesh>
  );
}
```

## Pipeline de modelos

| Formato | Uso | Tamanho |
|---|---|---|
| GLB/GLTF | Padrão web 3D | Menor |
| FBX | Saída de software 3D | Grande |
| OBJ | Malhas simples | Médio |
| USDZ | AR da Apple (Quick Look) | Médio |

```
1. Modelar no Blender
2. Reduzir polígonos (< 100K para web)
3. Bakear texturas (combinar materiais)
4. Exportar como GLB
5. Comprimir com gltf-transform
6. Conferir tamanho final (< 5MB ideal)
```

```bash
npm install -g @gltf-transform/cli
gltf-transform optimize input.glb output.glb \
  --compress draco \
  --texture-compress webp
```

Carregamento sempre dentro de `<Suspense>` com indicador de progresso:

```jsx
import { useGLTF, useProgress, Html } from '@react-three/drei';

function Loader() {
  const { progress } = useProgress();
  return <Html center>{progress.toFixed(0)}%</Html>;
}

<Canvas>
  <Suspense fallback={<Loader />}>
    <Model />
  </Suspense>
</Canvas>
```

## Performance

| Dispositivo | FPS alvo | Máx. triângulos |
|---|---|---|
| Desktop | 60fps | 500K |
| Mobile | 30–60fps | 100K |
| Low-end | 30fps | 50K |

Ganhos rápidos, em ordem de impacto:

1. **Instancing** para objetos repetidos — um draw call em vez de N.
2. **Limitar luzes** — uma `ambientLight` + uma `directionalLight` resolve a
   maioria dos casos. Cada luz adicional multiplica o custo do shader.
3. **LOD** para geometria distante.
4. **Lazy load** dos modelos pesados.
5. **DPR menor no mobile** — o maior ganho isolado em telas retina.

```jsx
const isMobile = /iPhone|iPad|Android/i.test(navigator.userAgent);

<Canvas
  dpr={isMobile ? 1 : 2}
  performance={{ min: 0.5 }}  // permite queda de frames sob carga
>
```

### InstancedMesh

Quando há centenas de objetos com a mesma geometria e material. Reaproveite
um único `Object3D` como escriba das matrizes — criar um por partícula por
frame produz pressão de GC que aparece como stutter.

```tsx
export function Particles({ count = 1000 }: { count?: number }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  const particles = useMemo(
    () =>
      Array.from({ length: count }, () => ({
        t: Math.random() * 100,
        factor: 20 + Math.random() * 100,
        speed: 0.01 + Math.random() / 200,
      })),
    [count],
  );

  useFrame(() => {
    if (!meshRef.current) return;
    particles.forEach((p, i) => {
      p.t += p.speed;
      const s = Math.cos(p.t);
      dummy.position.set(
        Math.cos((p.t / 10) * p.factor),
        Math.sin((p.t / 10) * p.factor),
        Math.cos((p.t / 10) * p.factor),
      );
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      meshRef.current!.setMatrixAt(i, dummy.matrix);
    });
    meshRef.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, count]}>
      <sphereGeometry args={[0.05, 16, 16]} />
      <meshPhongMaterial color="cyan" />
    </instancedMesh>
  );
}
```

### Fallback sem WebGL

```jsx
function Scene() {
  const [webGLSupported, setWebGLSupported] = useState(true);
  if (!webGLSupported) return <img src="/fallback.png" alt="Prévia 3D" />;
  return <Canvas onCreated={/* ... */} />;
}
```

## Checklist de revisão

| Problema | Severidade | Correção |
|---|---|---|
| Sem indicador de carregamento do 3D | Alta | `Suspense` com fallback, ou `useProgress` |
| Sem fallback para ausência de WebGL | Média | Detectar WebGL e servir imagem estática |
| Modelos não comprimidos | Média | `gltf-transform` com Draco + WebP |
| `OrbitControls` capturando o scroll da página | Média | `enableZoom={false}` ou tratar touch/scroll |
| DPR alto no mobile | Média | Limitar a 1 |
| Geometria/textura sem `dispose()` ao desmontar | Alta | Liberar recursos GPU no cleanup do efeito |

## Limitações

- Use esta skill apenas quando a tarefa claramente corresponder ao escopo acima.
- O resultado não substitui validação, teste em dispositivo real, nem revisão
  de especialista.
- Pare e peça esclarecimento se faltarem entradas, permissões ou critérios de
  sucesso.
