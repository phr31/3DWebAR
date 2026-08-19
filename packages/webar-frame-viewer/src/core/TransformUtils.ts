import type * as THREE from 'three';
import type { ThreeNS } from './loadThree';
import type { FitMode } from './types';

/** Convenção do mundo 3D: 1 unidade = 1 metro. */
export const cmToM = (cm: number): number => cm / 100;

export const clamp = (v: number, min: number, max: number): number =>
  v < min ? min : v > max ? max : v;

export const degToRad = (deg: number): number => (deg * Math.PI) / 180;
export const radToDeg = (rad: number): number => (rad * 180) / Math.PI;

/**
 * Tolerância para considerar que a proporção da imagem já bate com a do produto.
 * Evita uma tira de 1 px de passe-partout por erro de arredondamento quando a
 * arte foi autorada na proporção certa — que é o caso normal de catálogo.
 */
const ASPECT_EPS = 0.02;

export interface FitResult {
  /** Dimensões do plano da arte, em metros. */
  planeW: number;
  planeH: number;
  /** Transformação UV da textura. */
  repeatX: number;
  repeatY: number;
  offsetX: number;
  offsetY: number;
  /** Fração da arte descartada. 0 em `contain` e `stretch`. */
  croppedFraction: number;
}

/**
 * Concilia a proporção da imagem com a área disponível dentro da moldura.
 *
 * `cover` recorta pelas UVs. `contain` escala o PLANO, não as UVs: pelas UVs
 * `contain` exigiria `repeat > 1` com offset negativo, e a região fora de [0,1]
 * não tem resposta boa — `ClampToEdge` esmaga a última linha de pixels ao longo
 * de toda a tarja. Escalar o plano é a mesma matemática, uma linha, e é
 * fisicamente mais honesto: um 50×70 com impressão quadrada tem mesmo um papel
 * menor com passe-partout em volta.
 */
export function computeFit(
  artW: number,
  artH: number,
  imageAspect: number,
  fit: FitMode,
): FitResult {
  const areaAspect = artW / artH;
  const identity = {
    planeW: artW,
    planeH: artH,
    repeatX: 1,
    repeatY: 1,
    offsetX: 0,
    offsetY: 0,
    croppedFraction: 0,
  };

  if (!Number.isFinite(imageAspect) || imageAspect <= 0) return identity;
  if (Math.abs(imageAspect - areaAspect) <= ASPECT_EPS * areaAspect) return identity;
  if (fit === 'stretch') return identity;

  if (fit === 'cover') {
    let repeatX = 1;
    let repeatY = 1;
    if (imageAspect > areaAspect)
      repeatX = areaAspect / imageAspect; // imagem mais larga: corta laterais
    else repeatY = imageAspect / areaAspect; // imagem mais alta: corta topo e base

    // `texture.center` fica no default (0,0) de propósito. `Matrix3.setUvTransform`
    // já aplica `cx*(1-sx)`; usar center (0.5,0.5) JUNTO com este offset desloca
    // o recorte pela metade do excedente.
    return {
      planeW: artW,
      planeH: artH,
      repeatX,
      repeatY,
      offsetX: (1 - repeatX) / 2,
      offsetY: (1 - repeatY) / 2,
      croppedFraction: 1 - repeatX * repeatY,
    };
  }

  // contain
  const planeW = imageAspect > areaAspect ? artW : artH * imageAspect;
  const planeH = imageAspect > areaAspect ? artW / imageAspect : artH;
  return { ...identity, planeW, planeH };
}

/**
 * A pose de um hit-test tem o eixo +Y alinhado com a normal da superfície.
 * `XRPose.transform.matrix` é column-major.
 *
 * Aceita `ArrayLike` para servir tanto ao `Float32Array` do WebXR cru quanto ao
 * `number[]` de `Matrix4.elements`, que o caminho R3F usa — as duas são
 * column-major, então a leitura é a mesma.
 *
 * Escreve em vetores de saída em vez de devolver um objeto: isto roda por
 * candidato do hit-test, por frame, e a versão que devolvia
 * `{ normal: [...], position: [...] }` custava três alocações por chamada.
 */
export function readHitPoseInto(
  matrix: ArrayLike<number>,
  outNormal: THREE.Vector3,
  outPosition: THREE.Vector3,
): void {
  outNormal.set(matrix[4] as number, matrix[5] as number, matrix[6] as number);
  outPosition.set(matrix[12] as number, matrix[13] as number, matrix[14] as number);
}

/**
 * A normal faz ângulo θ com o "up" do mundo, logo `dot = cos θ`. Numa parede
 * perfeita θ = 90° e dot = 0; inclinada de `t` graus, |dot| = sin t. O teste é
 * exato, não aproximado. O valor absoluto pega chão (+1) e teto (−1) de uma vez.
 */
export function isWallNormal(normalY: number, toleranceDeg: number): boolean {
  return Math.abs(normalY) <= Math.sin(degToRad(toleranceDeg));
}

/**
 * Escrachos dos caminhos quentes deste módulo.
 *
 * Preguiçosos porque o `three` chega por parâmetro — não há como construí-los em
 * escopo de módulo, e é justamente essa restrição que mantém o arquivo sem
 * `import * as THREE`. Cada conjunto é escrito e consumido dentro da mesma
 * chamada síncrona; nenhuma das funções abaixo reentra em si mesma.
 */
interface BasisScratch {
  x: THREE.Vector3;
  y: THREE.Vector3;
  z: THREE.Vector3;
  m: THREE.Matrix4;
}
let basisScratch: BasisScratch | null = null;

function getBasisScratch(three: ThreeNS): BasisScratch {
  basisScratch ??= {
    x: new three.Vector3(),
    // Constante: `crossVectors` escreve em `x` e `makeBasis` só lê. Nunca é
    // mutado, então não precisa ser reescrito a cada chamada.
    y: new three.Vector3(0, 1, 0),
    z: new three.Vector3(),
    m: new three.Matrix4(),
  };
  return basisScratch;
}

/**
 * Orientação do quadro a partir da normal da parede, escrita num quaternion de
 * saída. Devolve `false` para chão ou teto, onde não há guinada a extrair.
 *
 * `lookAt` sozinho só funciona na parede perfeita: se a normal tem componente Y
 * — e o ARCore devolve 3° de inclinação o tempo todo — a base inclina junto e o
 * quadro fica torto. Ninguém nota 3° numa caixa; todo mundo nota num quadro.
 * Achatar a normal na horizontal e montar a base à mão custa duas linhas.
 *
 * `ny` entra sem ser usado para a assinatura casar com a da normal que os
 * chamadores têm em mãos — o achatamento é o ponto da função.
 */
export function wallBasisInto(
  three: ThreeNS,
  nx: number,
  ny: number,
  nz: number,
  out: THREE.Quaternion,
): boolean {
  void ny;
  const s = getBasisScratch(three);
  s.z.set(nx, 0, nz);
  if (s.z.lengthSq() < 1e-6) return false; // chão ou teto
  s.z.normalize();
  s.x.crossVectors(s.y, s.z).normalize();
  out.setFromRotationMatrix(s.m.makeBasis(s.x, s.y, s.z));
  return true;
}

/**
 * Versão que aloca, para os chamadores fora do loop de frame (o engine
 * imperativo do build UMD e o estado inicial do passthrough).
 */
export function wallBasis(
  three: ThreeNS,
  nx: number,
  ny: number,
  nz: number,
): THREE.Quaternion | null {
  const out = new three.Quaternion();
  return wallBasisInto(three, nx, ny, nz, out) ? out : null;
}

/**
 * O raio acerta um retângulo orientado?
 *
 * Interseção analítica raio×plano, e não `Raycaster` contra a malha: o grupo do
 * quadro inclui o quad de sombra, que é maior que a peça e ainda deslocado para
 * baixo, e o painel traseiro é `DoubleSide`. A área de acerto do raycaster seria
 * a da sombra, não a do produto que o usuário vê e mira.
 *
 * @param center      Centro do retângulo em mundo. Para o quadro é o centro da
 *                    FACE FRONTAL, não o pivô — que fica na face de trás, e cuja
 *                    diferença desloca o acerto ~3 cm em incidência de 45°,
 *                    sempre para o mesmo lado.
 * @param quaternion  Base do quadro: X/Y locais são o plano da parede e +Z é a
 *                    normal apontando para fora da parede — ver `wallBasis`.
 */
interface RectScratch {
  normal: THREE.Vector3;
  local: THREE.Vector3;
  axis: THREE.Vector3;
}
let rectScratch: RectScratch | null = null;

function getRectScratch(three: ThreeNS): RectScratch {
  rectScratch ??= {
    normal: new three.Vector3(),
    local: new three.Vector3(),
    axis: new three.Vector3(),
  };
  return rectScratch;
}

export function rayHitsRect(
  three: ThreeNS,
  rayOrigin: THREE.Vector3,
  rayDirection: THREE.Vector3,
  center: THREE.Vector3,
  quaternion: THREE.Quaternion,
  halfW: number,
  halfH: number,
): boolean {
  const s = getRectScratch(three);
  const normal = s.normal.set(0, 0, 1).applyQuaternion(quaternion);

  // Só a face frontal conta: `d·n < 0` é o raio viajando CONTRA a normal, ou
  // seja, vindo do lado em que o usuário está. Pelas costas não há quadro para
  // tocar, e o raio paralelo à parede sai por aqui sem divisão por zero.
  const denom = rayDirection.dot(normal);
  if (denom > -1e-6) return false;

  // Plano: (X − C)·n = 0 com X = O + t·d ⇒ t = (C − O)·n / (d·n).
  // Com `d·n < 0` garantido, t > 0 ⟺ a origem está do lado +n, isto é, na frente.
  const t = s.local.subVectors(center, rayOrigin).dot(normal) / denom;
  if (t <= 0) return false;

  const local = s.local.copy(rayOrigin).addScaledVector(rayDirection, t).sub(center);
  // A base de `wallBasis` é ortonormal, então projetar é um produto escalar puro
  // — não há norma para dividir. `axis` é reusado entre as duas projeções, então
  // `u` precisa ser consumido antes de `v` ser montado.
  const u = local.dot(s.axis.set(1, 0, 0).applyQuaternion(quaternion));
  const v = local.dot(s.axis.set(0, 1, 0).applyQuaternion(quaternion));
  return Math.abs(u) <= halfW && Math.abs(v) <= halfH;
}

/**
 * Altura em pixels de tela de um objeto de `heightM` a `distanceM` da câmera.
 * A altura do frustum na distância D é `2·D·tan(fovV/2)`.
 */
export function screenHeightPx(
  heightM: number,
  distanceM: number,
  fovVDeg: number,
  canvasH: number,
): number {
  return (canvasH * heightM) / (2 * distanceM * Math.tan(degToRad(fovVDeg) / 2));
}

/** Quantos metros de mundo correspondem a 1 px de tela, na distância dada. */
export function worldPerPixel(distanceM: number, fovVDeg: number, canvasH: number): number {
  return (2 * distanceM * Math.tan(degToRad(fovVDeg) / 2)) / canvasH;
}

/**
 * Retenção da pose do quadro entre duas XRSessions.
 *
 * Cada sessão nova cria um `local-floor` próprio, cuja origem é onde o aparelho
 * estava quando ela começou — a coordenada de mundo da sessão anterior não
 * significa nada na seguinte, e âncoras também morrem com a sessão. O que
 * sobrevive é a relação quadro↔usuário: "estava a 2,1 m à minha frente, 30 cm à
 * direita, virado 12° em relação a para onde eu olhava". Isso é reprojetável.
 *
 * Tipado por estrutura em vez de `THREE.Vector3`/`Quaternion` de propósito: sem
 * importar o three, estas funções rodam num REPL de Node e o roundtrip pode ser
 * conferido à mão.
 */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}
export interface QuatLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface RelativeFramePose {
  /** Metros à frente da câmera, ao longo da visada achatada na horizontal. */
  forward: number;
  /** Metros à direita da câmera, no plano horizontal. */
  right: number;
  /** Metros acima da câmera. Reserva de altura, quando o piso não é confiável. */
  up: number;
  /** Altura absoluta no `local-floor` — as duas sessões estimam o MESMO piso. */
  floorY: number;
  /** Guinada do quadro MENOS a da câmera, em radianos. */
  yaw: number;
}

/** Distâncias horizontais plausíveis para uma parede. Fora disso não vale reter. */
const MIN_RETAIN_M = 0.3;
const MAX_RETAIN_M = 8;
/** Altura de quadro plausível acima do piso estimado. */
const FLOOR_Y_MIN = 0.2;
const FLOOR_Y_MAX = 3;

/** Ângulo em (−π, π]. Sem ramos: o atan2 do próprio seno/cosseno já normaliza. */
export function normalizeAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/**
 * Guinada (rotação em torno de +Y) implícita na orientação.
 *
 * Lida da imagem do eixo +Z, que é a terceira coluna da matriz de rotação. Serve
 * tanto à câmera quanto ao quadro porque a convenção do pacote já é essa: a base
 * de `wallBasis` tem `z` = normal achatada e `y` = up do mundo, ou seja, o
 * quaternion do quadro é garantidamente só guinada. Extrair só a guinada da pose
 * da âncora — que ganha 2-3° de correção de drift do ARCore — é portanto um
 * reaprumamento deliberado, não uma perda.
 */
export function headingFromQuaternion(q: QuatLike): number {
  const zx = 2 * (q.x * q.z + q.w * q.y);
  const zy = 2 * (q.y * q.z - q.w * q.x);
  const zz = 1 - 2 * (q.x * q.x + q.y * q.y);
  if (zx * zx + zz * zz >= 1e-6) return Math.atan2(zx, zz);

  // Celular deitado: +Z aponta para o zênite ou o nadir e a projeção horizontal
  // some. A imagem de +Y ainda carrega a guinada — é o topo da tela, que continua
  // deitado no plano horizontal. O sinal vem do lado para onde o aparelho pende.
  const yx = 2 * (q.x * q.y - q.w * q.z);
  const yz = 2 * (q.y * q.z + q.w * q.x);
  const s = zy >= 0 ? -1 : 1;
  return Math.atan2(s * yx, s * yz);
}

/**
 * Pose do quadro descrita em relação à câmera. `null` quando a distância é
 * implausível — não vale reter uma pose absurda para "restaurar" lixo depois.
 */
export function relativeFramePose(
  framePosition: Vec3Like,
  frameQuaternion: QuatLike,
  cameraPosition: Vec3Like,
  cameraQuaternion: QuatLike,
): RelativeFramePose | null {
  const heading = headingFromQuaternion(cameraQuaternion);
  const sin = Math.sin(heading);
  const cos = Math.cos(heading);

  const dx = framePosition.x - cameraPosition.x;
  const dy = framePosition.y - cameraPosition.y;
  const dz = framePosition.z - cameraPosition.z;

  // Base horizontal da câmera: visada = (−sin, 0, −cos), direita = (cos, 0, −sin).
  const forward = -dx * sin - dz * cos;
  const right = dx * cos - dz * sin;

  const distance = Math.hypot(forward, right);
  if (distance < MIN_RETAIN_M || distance > MAX_RETAIN_M) return null;

  return {
    forward,
    right,
    up: dy,
    floorY: framePosition.y,
    yaw: normalizeAngle(headingFromQuaternion(frameQuaternion) - heading),
  };
}

/**
 * O caminho de volta: pose de mundo na sessão NOVA, relativa à câmera de agora.
 * `yaw` sai absoluto, pronto para `setFromAxisAngle((0,1,0), yaw)`.
 *
 * Fiel: a distância até a parede, e a lateralidade e a guinada relativas à
 * direção em que o usuário está olhando ao reentrar. Aproximado: tudo que é
 * ancorado ao cômodo — se o usuário andou dois passos entre sair e voltar, o
 * quadro reaparece deslocado exatamente por esse tanto.
 */
export function absoluteFramePose(
  pose: RelativeFramePose,
  cameraPosition: Vec3Like,
  cameraQuaternion: QuatLike,
): { x: number; y: number; z: number; yaw: number } {
  const heading = headingFromQuaternion(cameraQuaternion);
  const sin = Math.sin(heading);
  const cos = Math.cos(heading);

  const forward = clamp(pose.forward, -MAX_RETAIN_M, MAX_RETAIN_M);
  const right = clamp(pose.right, -MAX_RETAIN_M, MAX_RETAIN_M);

  return {
    x: cameraPosition.x + forward * -sin + right * cos,
    z: cameraPosition.z + forward * -cos + right * -sin,
    // O piso é a referência mais estável que as duas sessões compartilham: ambas
    // estimam o MESMO chão físico. A altura relativa à câmera depende de como o
    // usuário segurava o celular ao sair, então só entra quando o piso da sessão
    // anterior estava claramente errado.
    y:
      pose.floorY >= FLOOR_Y_MIN && pose.floorY <= FLOOR_Y_MAX
        ? pose.floorY
        : cameraPosition.y + pose.up,
    yaw: normalizeAngle(heading + pose.yaw),
  };
}
