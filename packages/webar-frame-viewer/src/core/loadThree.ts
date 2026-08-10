export type ThreeNS = typeof import('three');
export type ThreeLoader = () => Promise<ThreeNS>;

/**
 * Este é o ÚNICO arquivo autorizado a mencionar `three` fora de `import type`.
 * Qualquer `import * as THREE from 'three'` em outro módulo tira o three do
 * `external` e coloca ~150 KB gzip no bundle inicial.
 *
 * O loader não tem padrão embutido de propósito: o build UMD não pode conter um
 * `import('three')` com bare specifier (falha em <script> clássico e o esbuild
 * acabaria embutindo o three inteiro). Cada entry registra o seu.
 */

const KEY = '__webarFrameViewerThree__';

interface Store {
  loader?: ThreeLoader;
  pending?: Promise<ThreeNS>;
}

// O estado vive em globalThis, não no escopo do módulo: `index.mjs` e
// `react.mjs` são bundles separados e teriam cópias independentes.
function store(): Store {
  const g = globalThis as Record<string, unknown>;
  g[KEY] ??= {};
  return g[KEY] as Store;
}

/** Registro interno feito pelas entries. Não sobrescreve um loader já definido. */
export function setDefaultThreeLoader(loader: ThreeLoader): void {
  const s = store();
  if (!s.loader) s.loader = loader;
}

/** Permite ao integrador injetar a própria instância do three (CSP restritiva, monorepo). */
export function provideThree(loader: ThreeLoader): void {
  const s = store();
  s.loader = loader;
  s.pending = undefined;
}

export function loadThree(): Promise<ThreeNS> {
  const s = store();
  if (!s.loader) {
    return Promise.reject(
      new Error('Nenhum loader do three registrado. Chame provideThree() antes de iniciar.'),
    );
  }
  s.pending ??= s.loader().catch((err) => {
    // Sem isso, uma falha de rede transitória impediria qualquer retry na sessão.
    s.pending = undefined;
    throw err;
  });
  return s.pending;
}
