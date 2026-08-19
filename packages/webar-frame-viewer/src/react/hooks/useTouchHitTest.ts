'use client';

import { useXR } from '@react-three/xr';
import { type RefObject, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { SMOOTHING } from '../../core/xr/hitTest';
import { resolveTouchCandidate, type TouchQuality } from '../../core/xr/touchHitTest';

/**
 * Hit-test no ponto tocado, via `transient input`.
 *
 * O `useXRHitTest` do @react-three/xr só cobre hit-test source com espaço fixo
 * (`'viewer'`, `'local'`…), ou seja, raio do CENTRO da tela. Para "o quadro vai
 * exatamente onde o dedo está" o WebXR tem uma segunda API,
 * `requestHitTestSourceForTransientInput`, que a lib não expõe — por isso aqui se
 * fala com a `XRSession` direto.
 *
 * A leitura das poses usa o `referenceSpace` que o próprio three renderiza
 * (`gl.xr.getReferenceSpace()`), então o que sai já é coordenada de mundo; não há
 * `<XROrigin>` deslocado no `<ARCanvas>` para compensar.
 */

/** Perfil do WebXR para o toque na tela em AR de aparelho de mão. */
const TOUCHSCREEN_PROFILE = 'generic-touchscreen';

export interface TouchHitTestOptions {
  assumedWallDistanceM: number;
  wallToleranceDeg: number;
  /** Desliga a leitura — o quadro já foi ancorado. */
  enabled: boolean;
}

export interface TouchHitTestResult {
  /** Pose do candidato sob o dedo. Só vale enquanto `activeRef` for true. */
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  /** Há um dedo na tela com candidato resolvido neste frame. */
  activeRef: RefObject<boolean>;
  qualityRef: RefObject<TouchQuality>;
  /** Chamado de dentro do `useFrame`. */
  update(xrFrame: XRFrame, referenceSpace: XRReferenceSpace): void;
  /** Resolve a pose direto do evento `select`, para o tap curto demais. */
  resolveFromEvent(event: XRInputSourceEvent, referenceSpace: XRReferenceSpace): boolean;
  /** `selectstart`: novo toque, a suavização recomeça do zero. */
  begin(): void;
  restart(): void;
}

export function useTouchHitTest(options: TouchHitTestOptions): TouchHitTestResult {
  const session = useXR((state) => state.session);
  // Fora da ref `latest` de propósito: aqui `enabled` precisa mesmo ser
  // dependência de efeito, para a source ser cancelada ao ancorar.
  const { enabled } = options;

  const position = useMemo(() => new THREE.Vector3(), []);
  const quaternion = useMemo(() => new THREE.Quaternion(), []);
  const candidatePosition = useMemo(() => new THREE.Vector3(), []);
  const candidateQuaternion = useMemo(() => new THREE.Quaternion(), []);
  const rayOrigin = useMemo(() => new THREE.Vector3(), []);
  const rayDirection = useMemo(() => new THREE.Vector3(), []);
  const rayQuaternion = useMemo(() => new THREE.Quaternion(), []);

  const sourceRef = useRef<XRTransientInputHitTestSource | null>(null);
  const activeRef = useRef(false);
  const qualityRef = useRef<TouchQuality>('estimated');
  /** Primeiro frame do toque: copia a pose em vez de interpolar. */
  const freshRef = useRef(true);

  const latest = useRef(options);
  latest.current = options;

  /**
   * Uma source por sessão, enquanto ainda há o que mirar. `'point'` entra junto
   * de `'plane'` de propósito: numa parede branca o ARCore não promove plano
   * nenhum, e o feature point é o único retorno possível. Dele só se aproveita a
   * posição — ver `resolveTouchCandidate`.
   *
   * Depois de ancorar a source é CANCELADA, e não apenas ignorada no `update`:
   * ela custa trabalho do ARCore a cada frame, e a partir dali ninguém mais mira.
   * O `restart()` do reposicionamento reabre `enabled` e ela é recriada.
   */
  useEffect(() => {
    const request = session?.requestHitTestSourceForTransientInput;
    if (!(session && request && enabled)) return;
    let cancelled = false;

    // O tipo do @types/webxr admite `undefined` no retorno; um runtime que faça
    // isso simplesmente não tem a feature, e o fluxo segue como estimativa.
    const pending = request.call(session, {
      profile: TOUCHSCREEN_PROFILE,
      entityTypes: ['plane', 'point'],
    });

    void pending
      ?.then((source) => {
        if (cancelled) {
          source?.cancel();
          return;
        }
        sourceRef.current = source ?? null;
      })
      // Falha é aceitável: sem source todo toque vira estimativa, e o fluxo do
      // usuário é o mesmo — só nunca fica verde.
      .catch(() => undefined);

    return () => {
      cancelled = true;
      sourceRef.current?.cancel();
      sourceRef.current = null;
    };
  }, [session, enabled]);

  return useMemo(() => {
    /** Escreve a pose do candidato a partir do raio do toque. */
    function write(rayPose: XRPose, hitMatrix: Float32Array | null): void {
      const { position: origin, orientation } = rayPose.transform;
      rayOrigin.set(origin.x, origin.y, origin.z);
      rayDirection
        .set(0, 0, -1)
        .applyQuaternion(
          rayQuaternion.set(orientation.x, orientation.y, orientation.z, orientation.w),
        );

      qualityRef.current = resolveTouchCandidate(
        THREE,
        hitMatrix,
        rayOrigin,
        rayDirection,
        latest.current.assumedWallDistanceM,
        latest.current.wallToleranceDeg,
        candidatePosition,
        candidateQuaternion,
      );

      // Pose de hit treme; sem suavização o preview vibra sob o dedo. No
      // primeiro frame do toque, porém, interpolar arrastaria o quadro desde o
      // ponto do toque anterior.
      if (freshRef.current) {
        freshRef.current = false;
        position.copy(candidatePosition);
        quaternion.copy(candidateQuaternion);
      } else {
        position.lerp(candidatePosition, SMOOTHING);
        quaternion.slerp(candidateQuaternion, SMOOTHING);
      }

      activeRef.current = true;
    }

    return {
      position,
      quaternion,
      activeRef,
      qualityRef,

      update(xrFrame, referenceSpace) {
        if (!latest.current.enabled) {
          activeRef.current = false;
          return;
        }

        let hitMatrix: Float32Array | null = null;
        let rayPose: XRPose | null = null;

        const source = sourceRef.current;
        if (source) {
          // Só há entrada aqui enquanto o dedo está na tela — é o que define
          // `active` sem precisar rastrear pointer events em paralelo.
          const entry = xrFrame.getHitTestResultsForTransientInput(source)[0];
          if (entry) {
            rayPose = xrFrame.getPose(entry.inputSource.targetRaySpace, referenceSpace) ?? null;
            hitMatrix = entry.results[0]?.getPose(referenceSpace)?.transform.matrix ?? null;
          }
        } else {
          // Sem hit-test de transient input: o raio do toque continua existindo,
          // então a mira segue funcionando, sempre como estimativa.
          for (const input of xrFrame.session.inputSources) {
            if (input.targetRayMode !== 'screen') continue;
            rayPose = xrFrame.getPose(input.targetRaySpace, referenceSpace) ?? null;
            break;
          }
        }

        if (!rayPose) {
          activeRef.current = false;
          return;
        }

        write(rayPose, hitMatrix);
      },

      /**
       * Resgate do toque relâmpago: num tap curto o dedo pode sair antes de
       * qualquer frame ver a entrada, e sem isso o toque não posicionaria nada.
       * O evento `select` carrega o próprio raio, então dá para resolver a pose
       * ali mesmo — sempre como estimativa, que é o que teria sido de qualquer
       * forma em tão poucos milissegundos.
       */
      resolveFromEvent(event, referenceSpace) {
        if (!(latest.current.enabled && event.frame)) return false;
        const rayPose = event.frame.getPose(event.inputSource.targetRaySpace, referenceSpace);
        if (!rayPose) return false;
        write(rayPose, null);
        return true;
      },

      begin() {
        freshRef.current = true;
      },

      restart() {
        freshRef.current = true;
        activeRef.current = false;
        qualityRef.current = 'estimated';
      },
    };
  }, [
    candidatePosition,
    candidateQuaternion,
    position,
    quaternion,
    rayDirection,
    rayOrigin,
    rayQuaternion,
  ]);
}
