import type { ARErrorCode } from './errors';
import type { SceneKind } from './types';

export type InAppBrowser = 'facebook' | 'instagram' | 'tiktok' | 'line' | 'wechat' | null;

export interface CapabilityReport {
  secureContext: boolean;
  isIOS: boolean;
  isAndroid: boolean;
  inAppBrowser: InAppBrowser;
  webgl: boolean;
  getUserMedia: boolean;
  immersiveAR: boolean;
  /** `null` significa que a experiência não pode ser oferecida. */
  recommended: SceneKind | null;
  reason?: ARErrorCode;
}

const UNSUPPORTED_SSR: CapabilityReport = {
  secureContext: false,
  isIOS: false,
  isAndroid: false,
  inAppBrowser: null,
  webgl: false,
  getUserMedia: false,
  immersiveAR: false,
  recommended: null,
  reason: 'NO_AR_SUPPORT',
};

function detectInApp(ua: string): InAppBrowser {
  if (/FBAN|FBAV/.test(ua)) return 'facebook';
  if (/Instagram/.test(ua)) return 'instagram';
  if (/TikTok|BytedanceWebview/.test(ua)) return 'tiktok';
  if (/Line\//.test(ua)) return 'line';
  if (/MicroMessenger/.test(ua)) return 'wechat';
  return null;
}

function probeWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl =
      (canvas.getContext('webgl2') as WebGL2RenderingContext | null) ??
      (canvas.getContext('webgl') as WebGLRenderingContext | null);
    if (!gl) return false;
    // Um probe não pode deixar um contexto vivo para trás: o Safari limita o
    // número de contextos WebGL simultâneos e nunca mais renderiza depois disso.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

async function probeImmersiveAR(): Promise<boolean> {
  const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
  if (!xr?.isSessionSupported) return false;
  // A corrida não é paranoia: já foi observado esse método pendurar indefinidamente.
  return Promise.race([
    xr.isSessionSupported('immersive-ar').catch(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
  ]);
}

/**
 * Todos os probes ficam dentro do corpo da função — nada de acesso a browser
 * globals em escopo de módulo. É isso que torna o pacote SSR-safe.
 */
export async function detectCapabilities(): Promise<CapabilityReport> {
  if (typeof window === 'undefined') return UNSUPPORTED_SSR;

  const ua = navigator.userAgent;
  const secureContext = window.isSecureContext === true;
  // iPadOS 13+ se reporta como MacIntel. Sem o teste de maxTouchPoints todo iPad
  // entraria no caminho WebXR e travaria esperando uma sessão que nunca abre.
  const isIOS =
    /iP(hone|ad|od)/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(ua);
  const inAppBrowser = detectInApp(ua);
  const webgl = probeWebGL();
  const getUserMedia = typeof navigator.mediaDevices?.getUserMedia === 'function';
  const immersiveAR = secureContext ? await probeImmersiveAR() : false;

  const base = {
    secureContext,
    isIOS,
    isAndroid,
    inAppBrowser,
    webgl,
    getUserMedia,
    immersiveAR,
  };

  if (!secureContext) return { ...base, recommended: null, reason: 'INSECURE_CONTEXT' };
  if (!webgl) return { ...base, recommended: null, reason: 'WEBGL_UNAVAILABLE' };
  // Escrito como `immersiveAR && !isIOS` em vez de `isIOS => passthrough`:
  // mesmo comportamento hoje, e no dia em que a Apple lançar WebXR a migração
  // é apagar `&& !isIOS`.
  if (immersiveAR && !isIOS) return { ...base, recommended: 'webxr' };
  if (getUserMedia) return { ...base, recommended: 'passthrough' };
  return { ...base, recommended: null, reason: 'NO_AR_SUPPORT' };
}
