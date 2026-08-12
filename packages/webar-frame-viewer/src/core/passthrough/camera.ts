/**
 * Aquisição da câmera traseira para o engine de passthrough.
 *
 * Extraído de `engines/PassthroughSceneManager` para ser compartilhado com o
 * hook `usePassthrough` do caminho React. É I/O puro de mídia: não conhece
 * three, cena nem React.
 */

const IDEAL_SIZE = { width: { ideal: 1280 }, height: { ideal: 720 } } as const;

export async function openCamera(): Promise<MediaStream> {
  const constraints: MediaStreamConstraints = {
    // `ideal`, nunca `exact: 'environment'` — em alguns aparelhos `exact` falha de vez.
    video: {
      facingMode: { ideal: 'environment' },
      ...IDEAL_SIZE,
    },
    audio: false,
  };

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    if (err instanceof Error && err.name === 'OverconstrainedError') {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    } else {
      throw err;
    }
  }

  // iOS 17+ pode entregar a ultra-wide com facingMode 'environment', o que
  // destrói a hipótese de FOV e deixa a peça ~2× menor. Os labels só ficam
  // disponíveis depois da permissão concedida.
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === 'videoinput' && d.label);
    const preferred = cams.find(
      (d) => /back|rear|traseira/i.test(d.label) && !/ultra|telephoto|tele/i.test(d.label),
    );
    const current = stream.getVideoTracks()[0]?.getSettings().deviceId;
    if (preferred?.deviceId && preferred.deviceId !== current) {
      for (const track of stream.getTracks()) track.stop();
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: preferred.deviceId },
          ...IDEAL_SIZE,
        },
        audio: false,
      });
    }
  } catch {
    // Mantém o stream original — preferir a lente certa é otimização, não requisito.
  }

  return stream;
}

/** Encerra todas as tracks. Sem isso a luz da câmera fica acesa após o unmount. */
export function stopStream(stream: MediaStream | null | undefined): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}
