import { ARController, type ViewerConfig } from './core/ARController';
import { detectCapabilities } from './core/capabilities';
import { provideThree, setDefaultThreeLoader, type ThreeNS } from './core/loadThree';
import { createViewer } from './vanilla/createViewer';

/** Manter em sincronia com o range de `peerDependencies.three`. */
const THREE_VERSION = '0.185.1';

// URL absoluta e montada por função: `import('three')` com bare specifier falha
// em <script> clássico, e um literal seria dobrado pelo esbuild na análise
// estática — o que faria o three inteiro entrar neste bundle.
function cdnUrl(version: string): string {
  return `https://cdn.jsdelivr.net/npm/three@${version}/+esm`;
}

setDefaultThreeLoader(
  () =>
    import(/* webpackIgnore: true */ /* @vite-ignore */ cdnUrl(THREE_VERSION)) as Promise<ThreeNS>,
);

// Só named exports: `export default` faria `window.FrameViewer.default.create(...)`.
export const create = (config: ViewerConfig): ARController => createViewer(config);
export const isSupported = detectCapabilities;
export { userMessage } from './core/errors';
// Arranjo de kit: aritmética pura, e é o que a página de diagnóstico usa em
// `<script>` para montar um conjunto sem calcular offsets à mão.
export { kitBounds, layoutKit } from './core/kitLayout';
export { ARController, provideThree };
