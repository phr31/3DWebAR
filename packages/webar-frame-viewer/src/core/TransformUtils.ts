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
 */
export function readHitPose(matrix: Float32Array): {
  normal: [number, number, number];
  position: [number, number, number];
} {
  return {
    normal: [matrix[4] as number, matrix[5] as number, matrix[6] as number],
    position: [matrix[12] as number, matrix[13] as number, matrix[14] as number],
  };
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
 * Orientação do quadro a partir da normal da parede.
 *
 * `lookAt` sozinho só funciona na parede perfeita: se a normal tem componente Y
 * — e o ARCore devolve 3° de inclinação o tempo todo — a base inclina junto e o
 * quadro fica torto. Ninguém nota 3° numa caixa; todo mundo nota num quadro.
 * Achatar a normal na horizontal e montar a base à mão custa duas linhas.
 */
export function wallBasis(
  three: ThreeNS,
  nx: number,
  ny: number,
  nz: number,
): THREE.Quaternion | null {
  void ny;
  const z = new three.Vector3(nx, 0, nz);
  if (z.lengthSq() < 1e-6) return null; // chão ou teto
  z.normalize();
  const y = new three.Vector3(0, 1, 0);
  const x = new three.Vector3().crossVectors(y, z).normalize();
  return new three.Quaternion().setFromRotationMatrix(new three.Matrix4().makeBasis(x, y, z));
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
