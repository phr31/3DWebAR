import { degToRad, radToDeg } from '../TransformUtils';

/**
 * O frustum WebGL precisa corresponder exatamente à porção VISÍVEL do vídeo.
 * Sem isso o objeto virtual "nada" em relação ao fundo quando o telefone gira
 * — é o erro mais comum de implementações de passthrough.
 *
 * Extraído de `engines/PassthroughSceneManager.updateFrustum` para ser
 * compartilhado com o hook `usePassthrough`. Função pura: recebe medidas,
 * devolve o FOV vertical em graus.
 */
export function fovForVisibleVideo(
  videoW: number,
  videoH: number,
  canvasW: number,
  canvasH: number,
  assumedCameraFovH: number,
): number | null {
  if (!(videoW > 0 && videoH > 0)) return null;

  const scale = Math.max(canvasW / videoW, canvasH / videoH); // object-fit: cover
  const visibleH = canvasH / scale;
  // Não existe campo padronizado de FOV em getSettings()/getCapabilities().
  // 68° ≈ lente principal de 26 mm equivalente. Calibrável via opções.
  const tanHalfH = Math.tan(degToRad(assumedCameraFovH) / 2);
  return 2 * radToDeg(Math.atan(tanHalfH * (visibleH / videoW)));
}

/**
 * O iOS reporta `video.videoWidth` desatualizado logo após a rotação, por isso
 * todo resize passa por este atraso.
 */
export const RESIZE_DELAY_MS = 300;
