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
 * Uma peça de um kit.
 *
 * Estende `ProductData` de propósito: `validateProduct` vale sem alteração, e o
 * integrador que já monta produtos só precisa acrescentar a posição.
 *
 * Os offsets são do CENTRO da peça até a origem do arranjo, em centímetros, com
 * +X à direita e +Y para cima — o mesmo sistema do plano da parede. A origem não
 * precisa ser o centro do conjunto: `kitBounds` recentra tudo, então uma linha
 * escrita como `0, 60, 120` fica idêntica a `-60, 0, 60`.
 */
export interface KitItem extends ProductData {
  offsetXCm?: number;
  offsetYCm?: number;
  /** Estilo desta peça. Ausente = herda `options.frame`. */
  frame?: FrameStyle;
}

/**
 * Um conjunto de quadros posicionado como BLOCO ÚNICO: um hit-test, uma âncora,
 * um arraste move tudo. O arranjo entre as peças é fixo — é o que faz o kit ser
 * um kit, e o que mantém intactos os engines, os gestos e a âncora.
 */
export interface KitData {
  id: string;
  /** Nome exibido no topo do overlay. */
  title?: string;
  /** Pelo menos uma. Um kit de uma peça é indistinguível de um produto solto. */
  items: KitItem[];
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
  // Dedo na tela mirando: o quadro já aparece no ponto tocado, falta soltar.
  | 'hold-to-aim'
  | 'no-wall-found'
  | 'drag-to-move'
  | 'no-yaw'
  // Ancorado mas ainda destravado: é a janela de ajuste fino, antes do cadeado.
  | 'adjust'
  | 'placed';

export interface PlacementInfo {
  distanceMeters: number;
  source: 'hit-test' | 'manual' | 'auto';
  position: { x: number; y: number; z: number };
}

export interface ViewerOptions {
  allowRotate?: boolean;
  allowScale?: boolean;
  /**
   * Legado: faz o quadro seguir sozinho o plano detectado, antes do toque.
   * Padrão false — o fluxo atual é o usuário tocar onde quer o quadro. Ignorado
   * no caminho WebXR.
   */
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
