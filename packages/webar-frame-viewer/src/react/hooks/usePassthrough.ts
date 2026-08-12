'use client';

import { useThree } from '@react-three/fiber';
import { type RefObject, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { type ARError, normalizeError } from '../../core/errors';
import { AmbientSampler } from '../../core/passthrough/ambient';
import { openCamera, stopStream } from '../../core/passthrough/camera';
import { fovForVisibleVideo, RESIZE_DELAY_MS } from '../../core/passthrough/frustum';
import {
  applyDeviceAngles,
  type DeviceAngles,
  listenToOrientation,
} from '../../core/passthrough/orientation';
import type { ResolvedOptions } from '../../core/types';

/**
 * Engine de passthrough para iOS (e qualquer aparelho sem WebXR): feed da câmera
 * como fundo, three por cima, tracking 3-DoF pelo giroscópio.
 *
 * O `@react-three/xr` não cobre nada disso — não há sessão XR. O que este hook
 * faz é a orquestração; toda a matemática e o I/O sensíveis continuam em
 * `core/passthrough/*`, exatamente como o `PassthroughSceneManager` do build UMD
 * os consome. Só a posse do renderer mudou de mãos para o R3F.
 */

export interface PassthroughOptions {
  videoRef: RefObject<HTMLVideoElement | null>;
  options: ResolvedOptions;
  enabled: boolean;
  onError(error: ARError): void;
  /** Track encerrada pelo sistema (outra aba tomou a câmera, etc.). */
  onLost(): void;
  onAmbient(value: number): void;
}

export interface PassthroughResult {
  /** Pronto = stream ativo e vídeo tocando. */
  readyRef: RefObject<boolean>;
  /** Chamado pelo `useFrame` do componente de cena. */
  update(time: number): void;
}

export function usePassthrough({
  videoRef,
  options,
  enabled,
  onError,
  onLost,
  onAmbient,
}: PassthroughOptions): PassthroughResult {
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);

  const sampler = useMemo(() => new AmbientSampler(), []);
  const deviceQuaternion = useMemo(() => new THREE.Quaternion(), []);
  const readyRef = useRef(false);
  const anglesRef = useRef<DeviceAngles | null>(null);
  const hasOrientationRef = useRef(false);

  const latest = useRef({ onError, onLost, onAmbient, options });
  latest.current = { onError, onLost, onAmbient, options };

  // Aquisição da câmera. Só depende de `enabled`: os callbacks são lidos via
  // `latest`, senão um re-render do componente pai reabriria o getUserMedia.
  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let stream: MediaStream | null = null;
    let stopOrientation: (() => void) | null = null;

    const onTrackEnded = (): void => latest.current.onLost();

    void (async () => {
      try {
        stream = await openCamera();
      } catch (err) {
        if (!cancelled) {
          latest.current.onError(
            normalizeError(err, 'camera', { locale: latest.current.options.locale }),
          );
        }
        return;
      }

      // O getUserMedia pode resolver depois do unmount; sem esta checagem a luz
      // da câmera fica acesa.
      if (cancelled) {
        stopStream(stream);
        return;
      }

      const video = videoRef.current;
      if (!video) {
        stopStream(stream);
        return;
      }

      video.srcObject = stream;
      video.setAttribute('playsinline', '');
      video.muted = true;
      await video.play().catch(() => undefined);

      for (const track of stream.getVideoTracks()) {
        track.addEventListener('ended', onTrackEnded);
      }

      stopOrientation = await listenToOrientation(
        (angles) => {
          anglesRef.current = angles;
        },
        () => cancelled,
      );
      hasOrientationRef.current = stopOrientation !== null;
      readyRef.current = true;
    })();

    return () => {
      cancelled = true;
      readyRef.current = false;
      hasOrientationRef.current = false;
      stopOrientation?.();
      for (const track of stream?.getVideoTracks() ?? []) {
        track.removeEventListener('ended', onTrackEnded);
      }
      stopStream(stream);
      const video = videoRef.current;
      if (video) video.srcObject = null;
    };
  }, [enabled, videoRef]);

  // O Safari não libera contextos WebGL de forma agressiva e uma SPA acumula
  // "Too many active WebGL contexts". O R3F chama `dispose()`, mas não isto.
  useEffect(() => {
    return () => {
      gl.forceContextLoss();
    };
  }, [gl]);

  // Frustum: precisa corresponder à porção VISÍVEL do vídeo, senão o objeto
  // "nada" contra o fundo ao girar o aparelho. O atraso existe porque o iOS
  // reporta `videoWidth` desatualizado logo após a rotação.
  useEffect(() => {
    const apply = (): void => {
      const video = videoRef.current;
      if (!video || !(camera instanceof THREE.PerspectiveCamera)) return;
      const fov = fovForVisibleVideo(
        video.videoWidth,
        video.videoHeight,
        size.width,
        size.height,
        latest.current.options.assumedCameraFovH,
      );
      if (fov !== null) camera.fov = fov;
      camera.aspect = size.width / size.height;
      camera.updateProjectionMatrix();
    };

    apply();
    const timer = window.setTimeout(apply, RESIZE_DELAY_MS);
    window.addEventListener('orientationchange', apply);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('orientationchange', apply);
    };
  }, [camera, size.width, size.height, videoRef]);

  return useMemo(
    () => ({
      readyRef,
      update(time: number) {
        const video = videoRef.current;
        if (!video) return;

        if (anglesRef.current && hasOrientationRef.current) {
          applyDeviceAngles(THREE, deviceQuaternion, anglesRef.current);
          camera.quaternion.copy(deviceQuaternion);
        }
        camera.updateMatrixWorld();

        const ambient = sampler.sample(video, time);
        if (ambient !== null) latest.current.onAmbient(ambient);
      },
    }),
    [camera, deviceQuaternion, sampler, videoRef],
  );
}
