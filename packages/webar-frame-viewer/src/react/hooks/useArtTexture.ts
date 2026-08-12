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
