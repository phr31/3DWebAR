export type Locale = 'pt-BR' | 'en';

export type ARErrorCode =
  // ambiente — terminal
  | 'INSECURE_CONTEXT'
  | 'NO_AR_SUPPORT'
  | 'WEBGL_UNAVAILABLE'
  | 'IN_APP_BROWSER'
  // carregamento
  | 'ENGINE_LOAD_FAILED'
  | 'ASSET_LOAD_FAILED'
  | 'INVALID_PRODUCT'
  | 'INVALID_STATE'
  // câmera
  | 'CAMERA_DENIED'
  | 'CAMERA_UNAVAILABLE'
  | 'CAMERA_IN_USE'
  // xr
  | 'XR_SESSION_FAILED'
  | 'XR_GESTURE_REQUIRED'
  | 'SESSION_LOST'
  | 'CONTEXT_LOST';

export type ErrorPhase = 'env' | 'engine' | 'asset' | 'camera' | 'xr' | 'runtime';

const MESSAGES: Record<ARErrorCode, Record<Locale, string>> = {
  INSECURE_CONTEXT: {
    'pt-BR': 'A câmera só funciona em páginas HTTPS. Abra o site por um endereço seguro.',
    en: 'The camera only works on HTTPS pages. Open the site over a secure address.',
  },
  NO_AR_SUPPORT: {
    'pt-BR': 'Seu dispositivo não é compatível com Realidade Aumentada.',
    en: 'Your device does not support augmented reality.',
  },
  WEBGL_UNAVAILABLE: {
    'pt-BR': 'Seu navegador não conseguiu iniciar os gráficos 3D.',
    en: 'Your browser could not start 3D graphics.',
  },
  IN_APP_BROWSER: {
    'pt-BR': 'Para ver na sua parede, abra esta página no navegador do celular.',
    en: 'To view it on your wall, open this page in your phone browser.',
  },
  ENGINE_LOAD_FAILED: {
    'pt-BR': 'Não conseguimos carregar os recursos 3D. Verifique sua conexão.',
    en: 'We could not load the 3D engine. Check your connection.',
  },
  ASSET_LOAD_FAILED: {
    'pt-BR': 'Não conseguimos carregar a imagem do quadro.',
    en: 'We could not load the artwork image.',
  },
  INVALID_PRODUCT: {
    'pt-BR': 'Os dados do produto estão incompletos.',
    en: 'The product data is incomplete.',
  },
  INVALID_STATE: {
    'pt-BR': 'Operação inválida no estado atual.',
    en: 'Invalid operation for the current state.',
  },
  CAMERA_DENIED: {
    'pt-BR': 'Permissão de câmera negada. Libere a câmera nas configurações do navegador.',
    en: 'Camera permission denied. Allow the camera in your browser settings.',
  },
  CAMERA_UNAVAILABLE: {
    'pt-BR': 'Nenhuma câmera foi encontrada neste dispositivo.',
    en: 'No camera was found on this device.',
  },
  CAMERA_IN_USE: {
    'pt-BR': 'A câmera está sendo usada por outro app. Feche-o e tente de novo.',
    en: 'The camera is in use by another app. Close it and try again.',
  },
  XR_SESSION_FAILED: {
    'pt-BR': 'Não foi possível iniciar a sessão de RA.',
    en: 'Could not start the AR session.',
  },
  XR_GESTURE_REQUIRED: {
    'pt-BR': 'Toque no botão para iniciar a Realidade Aumentada.',
    en: 'Tap the button to start augmented reality.',
  },
  SESSION_LOST: {
    'pt-BR': 'A sessão de RA foi encerrada.',
    en: 'The AR session ended.',
  },
  CONTEXT_LOST: {
    'pt-BR': 'Os gráficos 3D foram interrompidos. Tente novamente.',
    en: '3D graphics were interrupted. Please try again.',
  },
};

const RECOVERABLE: ReadonlySet<ARErrorCode> = new Set<ARErrorCode>([
  'ENGINE_LOAD_FAILED',
  'ASSET_LOAD_FAILED',
  'CAMERA_IN_USE',
  'XR_SESSION_FAILED',
  'XR_GESTURE_REQUIRED',
  'SESSION_LOST',
  'CONTEXT_LOST',
]);

export class ARError extends Error {
  override readonly name = 'ARError';
  readonly code: ARErrorCode;
  /** `start()` pode ser tentado de novo com alguma chance de sucesso? */
  readonly recoverable: boolean;
  /** Texto localizado, seguro para renderizar direto na tela. */
  readonly userMessage: string;

  constructor(
    code: ARErrorCode,
    message?: string,
    init?: { cause?: unknown; recoverable?: boolean; locale?: Locale },
  ) {
    const locale = init?.locale ?? 'pt-BR';
    super(message ?? MESSAGES[code][locale], { cause: init?.cause });
    this.code = code;
    this.recoverable = init?.recoverable ?? RECOVERABLE.has(code);
    this.userMessage = MESSAGES[code][locale];
  }
}

export function userMessage(code: ARErrorCode, locale: Locale = 'pt-BR'): string {
  return MESSAGES[code][locale];
}

function domName(raw: unknown): string {
  return raw instanceof Error ? raw.name : '';
}

/**
 * Funil único de erros. A tabela abaixo é a parte que realmente importa em
 * produção — os nomes de DOMException do getUserMedia são o que distingue
 * "negou a permissão" (terminal) de "outro app está com a câmera" (retry vale).
 */
export function normalizeError(
  raw: unknown,
  phase: ErrorPhase,
  ctx?: { inAppBrowser?: string | null; locale?: Locale },
): ARError {
  if (raw instanceof ARError) return raw;

  const locale = ctx?.locale ?? 'pt-BR';
  const name = domName(raw);
  const mk = (code: ARErrorCode) => new ARError(code, undefined, { cause: raw, locale });

  if (phase === 'camera') {
    // Sobrepõe qualquer outro diagnóstico: dentro do webview do Instagram/Facebook
    // a mensagem útil é "abra no navegador", não "permissão negada".
    if (ctx?.inAppBrowser) return mk('IN_APP_BROWSER');

    switch (name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        return mk('CAMERA_DENIED');
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return mk('CAMERA_UNAVAILABLE');
      case 'NotReadableError':
      case 'TrackStartError':
      case 'AbortError':
        return mk('CAMERA_IN_USE');
      case 'SecurityError':
        return mk('INSECURE_CONTEXT');
      default:
        return mk('CAMERA_UNAVAILABLE');
    }
  }

  if (phase === 'xr') {
    // requestSession exige user activation; sem ela o Chrome joga SecurityError.
    // Isso não é erro para o usuário — é só o pedido de um toque.
    if (name === 'SecurityError') return mk('XR_GESTURE_REQUIRED');
    return mk('XR_SESSION_FAILED');
  }

  if (phase === 'asset') return mk('ASSET_LOAD_FAILED');
  if (phase === 'engine') return mk('ENGINE_LOAD_FAILED');
  if (phase === 'env') return mk('NO_AR_SUPPORT');

  return mk('INVALID_STATE');
}
