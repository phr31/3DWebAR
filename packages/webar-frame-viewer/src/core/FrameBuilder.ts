import type * as THREE from 'three';
import type { LoadedTexture } from './AssetLoader';
import type { ThreeNS } from './loadThree';
import { clamp, cmToM, computeFit } from './TransformUtils';
import type { FrameStyle, ProductData } from './types';

export interface FrameMetrics {
  outer: { w: number; h: number; d: number };
  opening: { w: number; h: number };
  artwork: { w: number; h: number };
  imageAspect: number;
  croppedFraction: number;
}

export interface BuiltFrame {
  group: THREE.Group;
  metrics: FrameMetrics;
  /** Escalar 0.55–1.0 multiplicando a cor da arte, para casar com a luz do ambiente. */
  setAmbient(scale: number): void;
  setOpacity(opacity: number): void;
  dispose(): void;
}

/** Folga entre a face de trás e o plano da parede, evitando z-fighting. */
const WALL_OFFSET = 0.002;

/**
 * Sombra de verdade exigiria luz + shadow map + superfície receptora, e na
 * parede não existe receptor visível. Pior: o framebuffer WebGL NÃO contém a
 * imagem da câmera (a cena é renderizada com alpha e o vídeo fica atrás), então
 * `MultiplyBlending` e `CustomBlending` com `DstColorFactor` — a primeira ideia
 * de todo mundo — não funcionam. Um quad translúcido escuro com NormalBlending
 * funciona: preto a 38% sobre a câmera escurece corretamente.
 *
 * `ctx.shadowBlur` em vez de `ctx.filter = 'blur()'`: o suporte a filter no
 * Safari é irregular. O truque é desenhar o retângulo-fonte fora do canvas e
 * deixar só a sombra cair dentro.
 */
function makeShadowTexture(three: ThreeNS, aspect: number, size = 256): THREE.CanvasTexture {
  const w = size;
  const h = Math.max(32, Math.round(size / aspect));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext('2d');
  if (ctx) {
    const blur = Math.round(Math.min(w, h) * 0.16);
    const pad = blur * 1.2;
    ctx.shadowColor = 'rgba(0,0,0,1)';
    ctx.shadowBlur = blur;
    ctx.shadowOffsetX = w * 2;
    ctx.fillStyle = '#000';
    ctx.fillRect(-w * 2 + pad, pad, w - pad * 2, h - pad * 2);
  }

  const tex = new three.CanvasTexture(canvas);
  tex.colorSpace = three.SRGBColorSpace;
  return tex;
}

function buildFrameGeometry(
  three: ThreeNS,
  W: number,
  H: number,
  openW: number,
  openH: number,
  D: number,
): THREE.ExtrudeGeometry {
  const shape = new three.Shape();
  shape.moveTo(-W / 2, -H / 2);
  shape.lineTo(W / 2, -H / 2);
  shape.lineTo(W / 2, H / 2);
  shape.lineTo(-W / 2, H / 2);
  shape.closePath();

  // Enrolamento oposto ao contorno externo.
  const hole = new three.Path();
  hole.moveTo(-openW / 2, -openH / 2);
  hole.lineTo(-openW / 2, openH / 2);
  hole.lineTo(openW / 2, openH / 2);
  hole.lineTo(openW / 2, -openH / 2);
  hole.closePath();
  shape.holes.push(hole);

  const geo = new three.ExtrudeGeometry(shape, {
    depth: D,
    steps: 1,
    curveSegments: 1,
    bevelEnabled: false,
  });
  geo.translate(0, 0, WALL_OFFSET);
  return geo;
}

/**
 * Constrói o quadro 3D. O pivô fica no CENTRO DA FACE DE TRÁS, com +Z apontando
 * para fora da parede: assim `group.position.copy(hitPoint)` já encosta a peça
 * na parede, sem offset de meia-profundidade no call site.
 *
 * `widthCm × heightCm` é a dimensão EXTERNA (moldura inclusa) — é como o
 * e-commerce anuncia o produto.
 */
export function buildFrame(
  three: ThreeNS,
  product: ProductData,
  art: LoadedTexture,
  style: Required<FrameStyle>,
): BuiltFrame {
  const W = cmToM(product.widthCm);
  const H = cmToM(product.heightCm);
  const D = cmToM(product.depthCm ?? 3);

  // Clamp para mini-quadros: uma barra de 2 cm num 10×10 comeria quase tudo.
  const bar = Math.min(cmToM(style.frameWidthCm), Math.min(W, H) * 0.2);
  const openW = W - 2 * bar;
  const openH = H - 2 * bar;
  const mat = clamp(cmToM(style.matCm), 0, Math.min(openW, openH) * 0.4);
  const artW = openW - 2 * mat;
  const artH = openH - 2 * mat;

  const fit = computeFit(artW, artH, art.aspect, style.fit);
  if (fit.croppedFraction > 0.15) {
    console.warn(
      `[webar-frame-viewer] fit "${style.fit}" descarta ` +
        `${(fit.croppedFraction * 100).toFixed(0)}% da arte de ${product.id}.`,
    );
  }

  const group = new three.Group();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const ownTextures: THREE.Texture[] = [];

  // O rebaixo de ~9 mm é o que produz a auto-sombra real na boca da moldura em
  // ângulo oblíquo — vende a tridimensionalidade mais do que qualquer luz.
  const frontZ = WALL_OFFSET + D;
  const recess = Math.min(0.01, D * 0.35);

  // --- sombra -------------------------------------------------------------
  if (style.shadow === 'soft') {
    const spread = D * 1.5 + 0.012;
    const sw = W + spread * 2;
    const sh = H + spread * 2;
    const geo = new three.PlaneGeometry(sw, sh);
    // `map`, não `alphaMap`: o three lê só o canal verde do alphaMap e perde a
    // rampa suave que o shadowBlur produz.
    const tex = makeShadowTexture(three, sw / sh);
    const material = new three.MeshBasicMaterial({
      map: tex,
      color: 0x000000,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
    });
    const mesh = new three.Mesh(geo, material);
    mesh.position.set(0, -0.01, 0.001); // luz vem de cima
    mesh.renderOrder = -1;
    group.add(mesh);
    geometries.push(geo);
    materials.push(material);
    ownTextures.push(tex);
  }

  // --- painel traseiro ----------------------------------------------------
  {
    const geo = new three.PlaneGeometry(W, H);
    const material = new three.MeshBasicMaterial({ color: 0x3a3a3a, side: three.DoubleSide });
    const mesh = new three.Mesh(geo, material);
    mesh.position.z = WALL_OFFSET;
    group.add(mesh);
    geometries.push(geo);
    materials.push(material);
  }

  // --- moldura ------------------------------------------------------------
  if (bar > 0) {
    const geo = buildFrameGeometry(three, W, H, openW, openH, D);
    const material = new three.MeshStandardMaterial({
      color: new three.Color(style.frameColor),
      roughness: 0.6,
      metalness: 0,
      flatShading: true,
    });
    group.add(new three.Mesh(geo, material));
    geometries.push(geo);
    materials.push(material);
  }

  // --- passe-partout ------------------------------------------------------
  {
    const geo = new three.PlaneGeometry(openW, openH);
    const material = new three.MeshBasicMaterial({ color: new three.Color(style.matColor) });
    const mesh = new three.Mesh(geo, material);
    mesh.position.z = frontZ - recess;
    group.add(mesh);
    geometries.push(geo);
    materials.push(material);
  }

  // --- arte ---------------------------------------------------------------
  // MeshBasicMaterial, não Standard: e-commerce vende cor. Se a impressão parece
  // mais escura no AR do que na foto do produto, isso vira reclamação.
  const artTexture = art.texture;
  artTexture.repeat.set(fit.repeatX, fit.repeatY);
  artTexture.offset.set(fit.offsetX, fit.offsetY);

  const artMaterial = new three.MeshBasicMaterial({ map: artTexture });
  {
    const geo = new three.PlaneGeometry(fit.planeW, fit.planeH);
    const mesh = new three.Mesh(geo, artMaterial);
    mesh.position.z = frontZ - recess + 0.001;
    group.add(mesh);
    geometries.push(geo);
    materials.push(artMaterial);
  }

  // --- luzes --------------------------------------------------------------
  // Filhas do próprio Group para o sombreamento da moldura ficar estável,
  // independentemente de onde o usuário está na sala.
  const ambient = new three.AmbientLight(0xffffff, 2.0);
  const dir = new three.DirectionalLight(0xffffff, 2.2);
  dir.position.set(-0.4, 0.8, 1.0);
  group.add(ambient, dir);

  const metrics: FrameMetrics = {
    outer: { w: W, h: H, d: D },
    opening: { w: openW, h: openH },
    artwork: { w: fit.planeW, h: fit.planeH },
    imageAspect: art.aspect,
    croppedFraction: fit.croppedFraction,
  };

  return {
    group,
    metrics,
    setAmbient(scale) {
      artMaterial.color.setScalar(clamp(scale, 0.55, 1));
    },
    setOpacity(opacity) {
      const transparent = opacity < 1;
      for (const material of materials) {
        const m = material as THREE.Material & { opacity: number };
        // A sombra tem opacidade própria; não deixe o estado "seguindo" apagá-la.
        if (m === materials[0] && style.shadow === 'soft') continue;
        m.transparent = transparent;
        m.opacity = opacity;
        m.needsUpdate = true;
      }
    },
    dispose() {
      for (const geo of geometries) geo.dispose();
      for (const material of materials) material.dispose();
      // Só as texturas criadas aqui. A textura da arte pertence ao AssetLoader.
      for (const tex of ownTextures) tex.dispose();
      group.clear();
    },
  };
}
