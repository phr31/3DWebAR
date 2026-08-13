import type { ARError } from './errors';

/** Dados do produto. Fornecidos pelo integrador — a lib é agnóstica quanto à origem. */
export interface ProductData {
  id: string;
  /** URL da imagem da arte, sem moldura. O CDN precisa enviar `Access-Control-Allow-Origin`. */
  imageUrl: string;
  /** Reservado para uma futura moldura vinda de asset externo. Ignorado nesta versão. */
  frameUrl?: string;
  /** Largura externa real, moldura inclusa, em centímetros. */
  widthCm: number;
  /** Altura externa real, moldura inclusa, em centímetros. */
  heightCm: number;
  /** Profundidade em centímetros. Padrão 3. */
  depthCm?: number;
  /** Nome exibido no topo do overlay. */
  title?: string;
}

/**
 * Como conciliar a proporção da imagem com as dimensões do produto quando elas
 * divergem.
 * - `contain`: preserva a arte inteira e completa com passe-partout (padrão).
 * - `cover`: preenche a abertura recortando as bordas da arte.
 * - `stretch`: distorce a arte para preencher.
 */
export type FitMode = 'contain' | 'cover' | 'stretch';

export interface FrameStyle {
  fit?: FitMode;
  /** Largura da barra da moldura em cm. Padrão 2. */
  frameWidthCm?: number;
  frameColor?: string;
  /** Passe-partout em cm. Padrão 0. */
  matCm?: number;
  matColor?: string;
  shadow?: 'soft' | 'none';
}

export type SceneKind = 'webxr' | 'passthrough';

export type ARStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'placing'
  | 'placed'
  | 'paused'
  | 'error'
  | 'destroyed';

/** Dicas de progresso exibidas no overlay. Mapeadas para texto em `ui/strings`. */
export type ARHint =
  | 'scan'
  | 'move-slower'
  | 'aim-wall'
  | 'tap-to-place'
  | 'no-wall-found'
  | 'drag-to-move'
  | 'no-yaw'
  | 'placed';

export interface PlacementInfo {
  distanceMeters: number;
  source: 'hit-test' | 'manual' | 'auto';
  position: { x: number; y: number; z: number };
}

export interface ViewerOptions {
  allowRotate?: boolean;
  allowScale?: boolean;
  /** Segue o plano detectado até o usuário tocar para fixar. Padrão true. */
  autoPlaceOnPlane?: boolean;
  /** Inicia câmera/sessão sem esperar o toque do usuário. Padrão false — ver README. */
  autoStart?: boolean;
  /** Força um engine. Útil para QA. */
  engine?: SceneKind;
  /** Estilo da moldura renderizada em 3D. */
  frame?: FrameStyle;
  /** FOV horizontal assumido da câmera traseira, em graus. Padrão 68. */
  assumedCameraFovH?: number;
  /** Distância inicial assumida até a parede, em metros. Padrão 2. */
  assumedWallDistanceM?: number;
  /** Milissegundos sem hit válido antes de oferecer posicionamento manual. Padrão 6000. */
  noHitTimeoutMs?: number;
  /** Tolerância, em graus, para aceitar uma superfície como parede. Padrão 15. */
  wallToleranceDeg?: number;
  /** URL de um build ESM do three, para ambientes com CSP restritiva. */
  threeUrl?: string;
  /** Mostra no overlay o engine ativo e o estado dos sensores. Padrão false. */
  debug?: boolean;
  locale?: 'pt-BR' | 'en';
  /** Sobrescreve textos individuais do overlay. */
  strings?: Partial<Record<string, string>>;

  onReady?: () => void;
  onPlace?: (info: PlacementInfo) => void;
  onError?: (err: ARError) => void;
  onClose?: () => void;
}

export interface ResolvedOptions
  extends Required<
    Omit<
      ViewerOptions,
      'engine' | 'threeUrl' | 'strings' | 'onReady' | 'onPlace' | 'onError' | 'onClose' | 'frame'
    >
  > {
  engine?: SceneKind;
  threeUrl?: string;
  frame: Required<FrameStyle>;
}

// `type`, não `interface`: interfaces não ganham index signature implícita e não
// satisfazem o `Record<string, unknown>` do Emitter.
export type AREventMap = {
  status: ARStatus;
  hint: ARHint;
  engine: SceneKind;
  placed: PlacementInfo;
  unplaced: undefined;
  error: ARError;
  close: undefined;
};
