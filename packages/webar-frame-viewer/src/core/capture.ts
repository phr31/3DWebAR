import type * as THREE from 'three';

/**
 * Compõe o frame do vídeo com o canvas WebGL num único canvas de saída.
 *
 * Precisa ser chamado logo após um `render()`, dentro do mesmo rAF: sem
 * `preserveDrawingBuffer` o backbuffer é limpo na próxima composição.
 *
 * Taint: `drawImage(video)` de um MediaStream da própria câmera não contamina, e
 * a textura do produto já passou obrigatoriamente por CORS (o WebGL recusa
 * uploads cross-origin sem ele). A armadilha que sobra é desenhar marca d'água a
 * partir de um `<img>` sem `crossOrigin` — aí `toBlob` lança SecurityError.
 */
export async function composeCapture(
  video: HTMLVideoElement,
  renderer: THREE.WebGLRenderer,
): Promise<Blob> {
  const source = renderer.domElement;
  const out = document.createElement('canvas');
  out.width = source.width;
  out.height = source.height;

  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('2D context indisponível para a captura.');

  if (video.videoWidth > 0) {
    // Replica o `object-fit: cover` do <video>.
    const scale = Math.max(out.width / video.videoWidth, out.height / video.videoHeight);
    const dw = video.videoWidth * scale;
    const dh = video.videoHeight * scale;
    ctx.drawImage(video, (out.width - dw) / 2, (out.height - dh) / 2, dw, dh);
  }
  ctx.drawImage(source, 0, 0);

  return new Promise<Blob>((resolve, reject) => {
    // JPEG, nunca PNG: um PNG de 1080×2000 de foto de câmera passa de 4 MB e a
    // share sheet engasga.
    out.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('toBlob falhou'))),
      'image/jpeg',
      0.92,
    );
  });
}

/**
 * `navigator.share` exige ativação transitória — um `await` longo antes da
 * chamada quebra o gesto no iOS. Capture em `pointerdown` e compartilhe no
 * `click` para o blob já estar pronto aqui.
 */
export async function shareOrDownload(blob: Blob, filename: string): Promise<void> {
  const file = new File([blob], filename, { type: blob.type });
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };

  if (nav.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch {
      // Cancelou ou falhou: cai no download.
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
