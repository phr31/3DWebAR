'use client';

import { forwardRef, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { LoadedTexture } from '../../core/AssetLoader';
import { makeShadowTexture, WALL_OFFSET } from '../../core/FrameBuilder';
import { clamp, cmToM, computeFit } from '../../core/TransformUtils';
import type { FrameStyle, ProductData } from '../../core/types';
import { cloneForInstance } from '../hooks/useArtTexture';

/**
 * O quadro em 3D, declarativo. Porte do `buildFrame` de `core/FrameBuilder`,
 * que segue existindo para o build UMD.
 *
 * O pivô fica no CENTRO DA FACE DE TRÁS, com +Z apontando para fora da parede:
 * assim `group.position.copy(hitPoint)` já encosta a peça na parede, sem offset
 * de meia-profundidade no call site.
 *
 * `widthCm × heightCm` é a dimensão EXTERNA (moldura inclusa) — é como o
 * e-commerce anuncia o produto.
 */

export interface FrameMetrics {
  outer: { w: number; h: number; d: number };
  opening: { w: number; h: number };
  artwork: { w: number; h: number };
  imageAspect: number;
  croppedFraction: number;
}

export interface FrameModelProps {
  product: ProductData;
  art: LoadedTexture;
  style: Required<FrameStyle>;
  /** 0.85 enquanto "seguindo" o plano, 1 depois de fixado. */
  opacity?: number;
  visible?: boolean;
  /**
   * Escalar 0.55–1.0 multiplicando a cor da arte, para casar com a luz do
   * ambiente. Vem do `light-estimation` do XR ou da amostragem do vídeo.
   */
  ambient?: number;
  onMetrics?(metrics: FrameMetrics): void;
}

export function useFrameGeometry(product: ProductData, style: Required<FrameStyle>) {
  return useMemo(() => {
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

    // O rebaixo de ~9 mm é o que produz a auto-sombra real na boca da moldura em
    // ângulo oblíquo — vende a tridimensionalidade mais do que qualquer luz.
    const frontZ = WALL_OFFSET + D;
    const recess = Math.min(0.01, D * 0.35);

    return { W, H, D, bar, openW, openH, artW, artH, frontZ, recess };
  }, [product.widthCm, product.heightCm, product.depthCm, style.frameWidthCm, style.matCm]);
}

/** Contorno externo CCW com o furo enrolado ao contrário — a triangulação depende disso. */
function makeFrameShape(W: number, H: number, openW: number, openH: number): THREE.Shape {
  const shape = new THREE.Shape();
  shape.moveTo(-W / 2, -H / 2);
  shape.lineTo(W / 2, -H / 2);
  shape.lineTo(W / 2, H / 2);
  shape.lineTo(-W / 2, H / 2);
  shape.closePath();

  const hole = new THREE.Path();
  hole.moveTo(-openW / 2, -openH / 2);
  hole.lineTo(-openW / 2, openH / 2);
  hole.lineTo(openW / 2, openH / 2);
  hole.lineTo(openW / 2, -openH / 2);
  hole.closePath();
  shape.holes.push(hole);

  return shape;
}

export const FrameModel = forwardRef<THREE.Group, FrameModelProps>(function FrameModel(
  { product, art, style, opacity = 1, visible = true, ambient = 1, onMetrics },
  ref,
) {
  const dims = useFrameGeometry(product, style);
  const { W, H, D, bar, openW, openH, artW, artH, frontZ, recess } = dims;

  const fit = useMemo(
    () => computeFit(artW, artH, art.aspect, style.fit),
    [artW, artH, art.aspect, style.fit],
  );

  useEffect(() => {
    if (fit.croppedFraction > 0.15) {
      console.warn(
        `[webar-frame-viewer] fit "${style.fit}" descarta ` +
          `${(fit.croppedFraction * 100).toFixed(0)}% da arte de ${product.id}.`,
      );
    }
  }, [fit.croppedFraction, style.fit, product.id]);

  const metrics = useMemo<FrameMetrics>(
    () => ({
      outer: { w: W, h: H, d: D },
      opening: { w: openW, h: openH },
      artwork: { w: fit.planeW, h: fit.planeH },
      imageAspect: art.aspect,
      croppedFraction: fit.croppedFraction,
    }),
    [W, H, D, openW, openH, fit, art.aspect],
  );

  useEffect(() => {
    onMetrics?.(metrics);
  }, [metrics, onMetrics]);

  // --- geometrias (todas descartadas no unmount pelo efeito abaixo) ---------

  const frameGeometry = useMemo(() => {
    if (bar <= 0) return null;
    const geo = new THREE.ExtrudeGeometry(makeFrameShape(W, H, openW, openH), {
      depth: D,
      steps: 1,
      curveSegments: 1,
      bevelEnabled: false,
    });
    geo.translate(0, 0, WALL_OFFSET);
    return geo;
  }, [W, H, openW, openH, D, bar]);

  const shadow = useMemo(() => {
    if (style.shadow !== 'soft') return null;
    const spread = D * 1.5 + 0.012;
    const sw = W + spread * 2;
    const sh = H + spread * 2;
    // `map`, não `alphaMap`: o three lê só o canal verde do alphaMap e perde a
    // rampa suave que o shadowBlur produz.
    return { sw, sh, texture: makeShadowTexture(THREE, sw / sh) };
  }, [W, H, D, style.shadow]);

  /**
   * A textura da arte é clonada: o `AssetLoader` compartilha uma instância por
   * URL entre viewers, mas `repeat`/`offset` do modo `cover` são deste produto.
   * O clone reaproveita a imagem já enviada à GPU.
   */
  const artTexture = useMemo(() => {
    const texture = cloneForInstance(art.texture);
    texture.repeat.set(fit.repeatX, fit.repeatY);
    texture.offset.set(fit.offsetX, fit.offsetY);
    return texture;
  }, [art.texture, fit]);

  useEffect(() => () => artTexture.dispose(), [artTexture]);
  useEffect(() => () => frameGeometry?.dispose(), [frameGeometry]);
  useEffect(() => () => shadow?.texture.dispose(), [shadow]);

  const transparent = opacity < 1;
  // Mesma faixa do `setAmbient` original: abaixo de 0.55 a impressão ficaria
  // escura demais para representar o produto com honestidade.
  const artColor = useMemo(() => new THREE.Color().setScalar(clamp(ambient, 0.55, 1)), [ambient]);

  return (
    <group ref={ref} visible={visible}>
      {/* Sombra: mantém a opacidade própria, o estado "seguindo" não a apaga. */}
      {shadow && (
        <mesh position={[0, -0.01, 0.001]} renderOrder={-1}>
          <planeGeometry args={[shadow.sw, shadow.sh]} />
          <meshBasicMaterial
            map={shadow.texture}
            color={0x000000}
            transparent
            opacity={0.38}
            depthWrite={false}
          />
        </mesh>
      )}

      {/* Painel traseiro */}
      <mesh position={[0, 0, WALL_OFFSET]}>
        <planeGeometry args={[W, H]} />
        <meshBasicMaterial
          color={0x3a3a3a}
          side={THREE.DoubleSide}
          transparent={transparent}
          opacity={opacity}
        />
      </mesh>

      {/* Moldura — o único MeshStandardMaterial, e por isso as luzes existem. */}
      {frameGeometry && (
        <mesh geometry={frameGeometry}>
          <meshStandardMaterial
            color={style.frameColor}
            roughness={0.6}
            metalness={0}
            flatShading
            transparent={transparent}
            opacity={opacity}
          />
        </mesh>
      )}

      {/* Passe-partout */}
      <mesh position={[0, 0, frontZ - recess]}>
        <planeGeometry args={[openW, openH]} />
        <meshBasicMaterial color={style.matColor} transparent={transparent} opacity={opacity} />
      </mesh>

      {/*
        Arte em MeshBasicMaterial, não Standard: e-commerce vende cor. Se a
        impressão parece mais escura no AR do que na foto do produto, vira
        reclamação. Só a moldura recebe iluminação.
      */}
      <mesh position={[0, 0, frontZ - recess + 0.001]} name="fv-art">
        <planeGeometry args={[fit.planeW, fit.planeH]} />
        <meshBasicMaterial
          map={artTexture}
          color={artColor}
          transparent={transparent}
          opacity={opacity}
        />
      </mesh>

      {/*
        Luzes filhas do próprio grupo: o sombreamento da moldura fica estável
        independentemente de onde o usuário está na sala.
      */}
      <ambientLight intensity={2.0} />
      <directionalLight intensity={2.2} position={[-0.4, 0.8, 1.0]} />
    </group>
  );
});
