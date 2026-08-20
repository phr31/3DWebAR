import type { LoadedTexture } from './AssetLoader';
import { type BuiltFrame, buildFrame, makeFrameLights } from './FrameBuilder';
import { itemPosition, itemStyle, kitBounds, kitMetrics } from './kitLayout';
import type { ThreeNS } from './loadThree';
import type { FrameStyle, KitItem } from './types';

/**
 * Constrói o conjunto de quadros como um `BuiltFrame` COMPOSTO.
 *
 * Devolver a mesma interface de `buildFrame` é a decisão que sustenta o resto:
 * `SceneManager.setContent(frame)` continua recebendo um objeto só, e os dois
 * engines, os gestos, a âncora e o retículo ficam intactos. O pivô do grupo
 * externo obedece ao mesmo contrato do quadro solto — centro do conjunto na face
 * de trás, +Z saindo da parede — então `group.position.copy(hitPoint)` encosta o
 * kit inteiro na parede sem nenhuma conta no call site.
 *
 * As luzes saem UMA vez, aqui, e não por peça: são filhas do grupo (para o
 * sombreamento da moldura não depender de onde o usuário está na sala), e N
 * peças dariam 2N luzes na cena — recompilação de shader por nada, num aparelho
 * que já sustenta o feed da câmera e o compositor XR.
 */
export interface KitPart {
  item: KitItem;
  art: LoadedTexture;
}

export function buildKit(
  three: ThreeNS,
  input: KitPart[],
  style: Required<FrameStyle>,
): BuiltFrame {
  const items = input.map(({ item }) => item);
  const bounds = kitBounds(items);
  const group = new three.Group();

  const parts = input.map(({ item, art }) => {
    const built = buildFrame(three, item, art, itemStyle(style, item), false);
    const [x, y, z] = itemPosition(item, bounds);
    built.group.position.set(x, y, z);
    group.add(built.group);
    return built;
  });

  group.add(...makeFrameLights(three));

  return {
    group,
    metrics: kitMetrics(
      items,
      parts.map((part) => part.metrics),
    ),
    setAmbient(scale) {
      for (const part of parts) part.setAmbient(scale);
    },
    setOpacity(opacity) {
      for (const part of parts) part.setOpacity(opacity);
    },
    dispose() {
      // Cada peça descarta as próprias geometrias, materiais e a textura de
      // sombra que ELA criou. A textura da arte segue pertencendo ao
      // AssetLoader — quem a solta é o `release(url)` do ARController.
      for (const part of parts) part.dispose();
      group.clear();
    },
  };
}
