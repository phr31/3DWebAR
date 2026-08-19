import type * as THREE from 'three';
import { ARError } from './errors';
import type { ThreeNS } from './loadThree';

export interface LoadedTexture {
  texture: THREE.Texture;
  width: number;
  height: number;
  aspect: number;
}

interface Entry {
  promise: Promise<LoadedTexture>;
  loaded?: LoadedTexture;
  refs: number;
  bytes: number;
  idleAt?: number;
}

const cache = new Map<string, Entry>();

/** ~6 texturas de 1024² com mipmaps. Segura a navegação típica sem estourar memória. */
const IDLE_BUDGET_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 12_000;
/**
 * Teto da textura da arte.
 *
 * 1024² são ~5,6 MB de VRAM com mipmaps; 2048² seriam ~21 MB — quase quatro
 * vezes mais, num aparelho que ao mesmo tempo sustenta o feed da câmera e o
 * compositor XR. E a resolução extra não chega à tela: o quadro ocupa uma
 * fração da viewport a 2 m de distância, e o ganho de nitidez em ângulo rasante
 * quem entrega é a anisotropia, não o número de texels.
 */
const MAX_DIMENSION = 1024;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `fetch` rejeita com um `TypeError` sem status tanto em falha de CORS quanto de
 * rede. Só no caminho de erro final vale uma sonda extra: um `<img>` sem
 * `crossOrigin` carrega mesmo sem os headers de CORS. Se ele carregar, o recurso
 * existe e o problema é só o header — o que transforma "não funciona" numa
 * mensagem acionável.
 */
async function looksLikeCors(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    const done = (ok: boolean) => {
      img.onload = null;
      img.onerror = null;
      resolve(ok);
    };
    img.onload = () => done(true);
    img.onerror = () => done(false);
    img.src = url;
    setTimeout(() => done(false), 5000);
  });
}

async function fetchBitmap(url: string, signal: AbortSignal): Promise<ImageBitmap> {
  const res = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'force-cache', signal });
  if (!res.ok) throw new ARError('ASSET_LOAD_FAILED', `HTTP ${res.status} ao carregar ${url}`);
  const blob = await res.blob();

  // Com ImageBitmap, `texture.flipY` é IGNORADO pelo three — a orientação tem
  // que ser decidida aqui. E `colorSpaceConversion: 'default'` (não 'none'):
  // foto de produto exportada com perfil Display-P3 sai dessaturada sem conversão.
  let bitmap = await createImageBitmap(blob, {
    imageOrientation: 'flipY',
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'default',
  });

  if (bitmap.width > MAX_DIMENSION || bitmap.height > MAX_DIMENSION) {
    const scale = MAX_DIMENSION / Math.max(bitmap.width, bitmap.height);
    console.warn(
      `[webar-frame-viewer] textura ${bitmap.width}x${bitmap.height} acima do recomendado; ` +
        'reduzindo. Sirva imagens de até 1024px.',
    );
    const resized = await createImageBitmap(bitmap, {
      resizeWidth: Math.round(bitmap.width * scale),
      resizeHeight: Math.round(bitmap.height * scale),
      resizeQuality: 'high',
    });
    bitmap.close();
    bitmap = resized;
  }

  return bitmap;
}

async function loadWithRetry(url: string): Promise<ImageBitmap> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      return await fetchBitmap(url, ctrl.signal);
    } catch (err) {
      lastError = err;
      // 404/403 são permanentes; retry só atrasa a mensagem de erro.
      const permanent = err instanceof ARError && /HTTP 4\d\d/.test(err.message);
      if (permanent || attempt === 2) break;
      const backoff = 300 * 2 ** attempt * (0.7 + Math.random() * 0.6);
      await sleep(backoff);
    } finally {
      clearTimeout(timer);
    }
  }

  if (lastError instanceof TypeError && (await looksLikeCors(url))) {
    throw new ARError(
      'ASSET_LOAD_FAILED',
      `A imagem ${url} existe mas foi bloqueada por CORS. O CDN precisa enviar ` +
        'o header Access-Control-Allow-Origin — o WebGL recusa uploads cross-origin sem ele.',
      { cause: lastError },
    );
  }
  throw lastError instanceof ARError
    ? lastError
    : new ARError('ASSET_LOAD_FAILED', undefined, { cause: lastError });
}

function toTexture(three: ThreeNS, bitmap: ImageBitmap, maxAnisotropy: number): THREE.Texture {
  const tex = new three.Texture(bitmap as unknown as HTMLImageElement);
  tex.colorSpace = three.SRGBColorSpace;
  // Quadro na parede é quase sempre visto em ângulo rasante. Sem anisotropia a
  // impressão vira uma mancha borrada — é a linha de maior retorno do arquivo.
  tex.anisotropy = Math.min(8, maxAnisotropy);
  tex.generateMipmaps = true;
  tex.minFilter = three.LinearMipmapLinearFilter;
  tex.magFilter = three.LinearFilter;
  tex.wrapS = three.ClampToEdgeWrapping;
  tex.wrapT = three.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

function sweepIdle(): void {
  let idleBytes = 0;
  const idle: Array<[string, Entry]> = [];
  for (const [url, entry] of cache) {
    if (entry.refs === 0 && entry.loaded) {
      idleBytes += entry.bytes;
      idle.push([url, entry]);
    }
  }
  if (idleBytes <= IDLE_BUDGET_BYTES) return;

  idle.sort((a, b) => (a[1].idleAt ?? 0) - (b[1].idleAt ?? 0));
  for (const [url, entry] of idle) {
    if (idleBytes <= IDLE_BUDGET_BYTES) break;
    entry.loaded?.texture.dispose();
    cache.delete(url);
    idleBytes -= entry.bytes;
  }
}

/**
 * O AssetLoader é o ÚNICO dono das texturas de imagem. Quem constrói malhas
 * chama `release(url)` e nunca `texture.dispose()` — é isso que resolve o
 * "dois viewers compartilham uma textura, quem descarta?".
 */
export function acquire(
  three: ThreeNS,
  url: string,
  maxAnisotropy: number,
): Promise<LoadedTexture> {
  const existing = cache.get(url);
  if (existing) {
    existing.refs++;
    existing.idleAt = undefined;
    return existing.promise;
  }

  const entry: Entry = { refs: 1, bytes: 0, promise: undefined as never };
  entry.promise = loadWithRetry(url)
    .then((bitmap) => {
      const loaded: LoadedTexture = {
        texture: toTexture(three, bitmap, maxAnisotropy),
        width: bitmap.width,
        height: bitmap.height,
        aspect: bitmap.width / bitmap.height,
      };
      entry.loaded = loaded;
      entry.bytes = bitmap.width * bitmap.height * 4 * 1.34; // RGBA + mipmaps
      return loaded;
    })
    .catch((err) => {
      // Uma promise rejeitada cacheada para sempre significa que este produto
      // nunca mais carrega na sessão, nem depois da rede voltar.
      cache.delete(url);
      throw err;
    });

  cache.set(url, entry);
  return entry.promise;
}

export function release(url: string): void {
  const entry = cache.get(url);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs === 0) {
    entry.idleAt = performance.now();
    sweepIdle();
  }
}

export function preload(three: ThreeNS, urls: string[], maxAnisotropy: number): void {
  for (const url of urls) {
    void acquire(three, url, maxAnisotropy)
      .then(() => release(url))
      .catch(() => release(url));
  }
}

/** Descarta tudo. Use no unmount definitivo de uma SPA. */
export function clearAssets(): void {
  for (const entry of cache.values()) entry.loaded?.texture.dispose();
  cache.clear();
}
