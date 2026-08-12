/**
 * Estimativa de luz ambiente amostrando o próprio feed da câmera.
 *
 * Extraído de `engines/PassthroughSceneManager.sampleAmbient` para ser
 * compartilhado com o hook `usePassthrough`. É o equivalente pobre do
 * `light-estimation` do WebXR: 8×8 pixels, uma vez por segundo, suavizado.
 */

const SAMPLE_INTERVAL_MS = 1000;
const SIZE = 8;

export class AmbientSampler {
  private canvas: HTMLCanvasElement | null = null;
  private lastSample = 0;
  private value = 1;

  /**
   * Devolve a nova luminância quando amostrou neste frame, ou `null` quando
   * pulou (throttle ou vídeo ainda sem dimensão). Assim quem chama só propaga
   * para o material quando há mudança de verdade.
   */
  sample(video: HTMLVideoElement, now: number): number | null {
    if (now - this.lastSample < SAMPLE_INTERVAL_MS || video.videoWidth === 0) return null;
    this.lastSample = now;

    this.canvas ??= Object.assign(document.createElement('canvas'), {
      width: SIZE,
      height: SIZE,
    });
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    try {
      ctx.drawImage(video, 0, 0, SIZE, SIZE);
      const { data } = ctx.getImageData(0, 0, SIZE, SIZE);
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) {
        sum +=
          0.2126 * (data[i] as number) +
          0.7152 * (data[i + 1] as number) +
          0.0722 * (data[i + 2] as number);
      }
      const luminance = sum / (data.length / 4) / 255;
      this.value += (luminance * 0.6 + 0.5 - this.value) * 0.1;
      return this.value;
    } catch {
      // getImageData pode falhar em contextos exóticos; a luz fica no default.
      return null;
    }
  }

  reset(): void {
    this.lastSample = 0;
    this.value = 1;
  }
}
