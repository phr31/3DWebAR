import { defineConfig } from 'tsup';

const shared = {
  platform: 'browser' as const,
  target: 'es2020' as const,
  sourcemap: true,
  // A limpeza acontece no script `prebuild`. Configs em array podem rodar em
  // paralelo e `clean: true` faria um apagar a saída do outro.
  clean: false,
  // `treeshake` roda o Rollup por cima do esbuild e mexe na diretiva "use client".
  treeshake: false,
  loader: { '.css': 'text' as const },
};

export default defineConfig([
  // 1) Build npm: núcleo + API vanilla.
  {
    ...shared,
    name: 'npm',
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    splitting: false,
    external: ['three'],
    outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.mjs' }),
  },

  // 2) Build React: config separado só por causa do banner. Se `index` e `react`
  //    dividissem o config, o `index.mjs` (server-safe) também ganharia a
  //    diretiva e viraria uma client reference inutilizável.
  {
    ...shared,
    name: 'react',
    entry: { react: 'src/react/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    splitting: false,
    external: ['three', 'react', 'react-dom', 'react/jsx-runtime'],
    banner: { js: '"use client";' },
    outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.mjs' }),
  },

  // 3) Build CDN: arquivo único IIFE expondo o global `FrameViewer`.
  //    `src/umd.ts` existe separado porque `import('three')` com bare specifier
  //    falha em <script> clássico — lá o loader usa URL absoluta.
  {
    ...shared,
    name: 'umd',
    entry: { 'frame-viewer.umd': 'src/umd.ts' },
    format: ['iife'],
    globalName: 'FrameViewer',
    dts: false,
    minify: true,
    outExtension: () => ({ js: '.min.js' }),
  },

  // 4) CSS standalone, para quem quer self-host ou sobrescrever.
  //    Sem `loader` aqui — com ele o CSS sairia como string JS.
  {
    name: 'css',
    entry: ['src/styles/overlay.css'],
    outDir: 'dist',
    minify: true,
    clean: false,
  },
]);
