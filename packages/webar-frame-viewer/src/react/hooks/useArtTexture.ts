'use client';

import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { acquire, type LoadedTexture, release } from '../../core/AssetLoader';
import { type ARError, normalizeError } from '../../core/errors';

/**
 * Carrega a textura da arte pelo `AssetLoader`, e não por `useTexture` /
 * `useLoader` do R3F.
 *
 * O AssetLoader não é intercambiável: ele traz contagem de referências entre
 * viewers, diagnóstico de CORS (o `<img>` sem `crossOrigin` que distingue
 * "recurso não existe" de "faltou o header"), downscale acima de 2048 px,
 * retry com backoff e `imageOrientation: 'flipY'` no `createImageBitmap` — que
 * é obrigatório porque o three ignora `texture.flipY` quando a fonte é um
 * ImageBitmap. Nada disso existe no cache do R3F.
 */

/** Mesma constante de `ARController`. O three limita ao máximo do hardware. */
const ANISOTROPY = 8;

export interface ArtTextureResult {
  art: LoadedTexture | null;
  error: ARError | null;
}

export function useArtTexture(imageUrl: string): ArtTextureResult {
  const [result, setResult] = useState<ArtTextureResult>({ art: null, error: null });

  useEffect(() => {
    let active = true;
    setResult({ art: null, error: null });

    // `acquire` incrementa o refcount de forma síncrona, então o `release` da
    // limpeza já pareia com esta chamada mesmo que a promise resolva depois do
    // unmount. Um release no `then` seria decremento duplo.
    acquire(THREE, imageUrl, ANISOTROPY).then(
      (loaded) => {
        if (active) setResult({ art: loaded, error: null });
      },
      (err: unknown) => {
        if (active) setResult({ art: null, error: normalizeError(err, 'asset') });
      },
    );

    return () => {
      active = false;
      release(imageUrl);
    };
  }, [imageUrl]);

  return result;
}

export interface ArtTexturesResult {
  /** Uma textura por URL, na mesma ordem. `null` enquanto qualquer uma carrega. */
  arts: LoadedTexture[] | null;
  error: ARError | null;
}

/**
 * A versão de N URLs, para o kit.
 *
 * Tudo ou nada: enquanto uma peça não chegou, `arts` é `null`. Um kit com um
 * buraco no meio mentiria sobre o produto — e a falha vira o mesmo
 * `ASSET_LOAD_FAILED` do caminho de um quadro só, com o diagnóstico de CORS que
 * o `AssetLoader` já produz.
 *
 * URLs repetidas são esperadas (a mesma arte em duas peças de um kit) e não
 * precisam de tratamento: o `AssetLoader` conta referências por URL, então dois
 * `acquire` da mesma arte compartilham UMA textura na GPU, e o
 * `cloneForInstance` do `<FrameModel>` mantém `repeat`/`offset` separados.
 */
export function useArtTextures(urls: string[]): ArtTexturesResult {
  const [result, setResult] = useState<ArtTexturesResult>({ arts: null, error: null });

  // Assinatura ESTRUTURAL da lista: o integrador passa um array literal, novo a
  // cada render, e por identidade este efeito reiniciaria sem parar — soltando e
  // repegando todas as texturas do kit a cada frame de interface.
  const key = urls.join('\n');

  // O `urls` capturado é sempre o do render que produziu este `key`, então a
  // lista e a chave nunca discordam.
  // biome-ignore lint/correctness/useExhaustiveDependencies: ver acima
  useEffect(() => {
    let active = true;
    setResult({ arts: null, error: null });

    // `acquire` incrementa o refcount de forma síncrona, então o `release` da
    // limpeza pareia com estas chamadas mesmo que as promises resolvam depois do
    // unmount. Um release no `then` seria decremento duplo.
    const pending = urls.map((url) => acquire(THREE, url, ANISOTROPY));
    // `Promise.all` rejeita na primeira falha; sem isto as irmãs virariam
    // unhandled rejections. Não interfere no `all`, que observa as originais.
    for (const p of pending) p.catch(() => undefined);

    Promise.all(pending).then(
      (loaded) => {
        if (active) setResult({ arts: loaded, error: null });
      },
      (err: unknown) => {
        if (active) setResult({ arts: null, error: normalizeError(err, 'asset') });
      },
    );

    return () => {
      active = false;
      for (const url of urls) release(url);
    };
  }, [key]);

  return result;
}

/**
 * Clona a textura para esta instância. O `AssetLoader` compartilha uma única
 * `THREE.Texture` por URL entre viewers, mas `repeat`/`offset` do modo `cover`
 * são por produto — dois viewers da mesma arte com dimensões diferentes
 * brigariam pelo mesmo objeto. O clone compartilha a imagem já enviada à GPU,
 * então não há segundo upload.
 */
export function cloneForInstance(texture: THREE.Texture): THREE.Texture {
  const clone = texture.clone();
  clone.needsUpdate = true;
  return clone;
}
