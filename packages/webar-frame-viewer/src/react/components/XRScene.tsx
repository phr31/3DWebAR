'use client';

import { useFrame, useThree } from '@react-three/fiber';
import { useXR, useXRAnchor } from '@react-three/xr';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import type { LoadedTexture } from '../../core/AssetLoader';
import { WALL_OFFSET } from '../../core/FrameBuilder';
import { GestureController } from '../../core/GestureController';
import {
  absoluteFramePose,
  type RelativeFramePose,
  rayHitsRect,
  relativeFramePose,
  worldPerPixel,
} from '../../core/TransformUtils';
import type { ARHint, FrameStyle, KitItem, ResolvedOptions } from '../../core/types';
import { ambientFromLightEstimate } from '../../core/xr/hitTest';
import type { ARApi } from '../hooks/useAR';
import { DEBUG_INTERVAL_MS, useFrameStats } from '../hooks/useFrameStats';
import { useHitTest } from '../hooks/useHitTest';
import { useTouchHitTest } from '../hooks/useTouchHitTest';
import type { FrameMetrics } from './FrameModel';
import { KitModel } from './KitModel';
import { Reticle } from './Reticle';

/**
 * Cena do caminho WebXR (Android/ARCore): o usuário toca onde quer o quadro, o
 * hit-test qualifica aquele ponto e o toque ancora.
 *
 * Roda dentro de `<XR>`. Duas fontes de mira convivem, com precedência fixa: a
 * varredura do centro da tela (`useHitTest`) só ANTECIPA o retículo enquanto
 * ninguém tocou, e o dedo (`useTouchHitTest`) ganha dela no instante em que
 * encosta. O QUADRO nunca aparece sem dedo na tela — só o retículo. A resolução
 * da pose sob o dedo mora em `core/xr/touchHitTest`; aqui só há a ligação com o
 * loop do R3F e com o estado do React.
 */

/**
 * Piso entre dicas vindas da varredura. O hit-test troca de estado muito mais
 * rápido do que se lê uma linha, e o `useCoachHint` usa a dica como `key` — sem
 * o piso, 'aim-wall' e 'move-slower' piscariam alternadamente sobre a parede. O
 * guard de `useAR.setHint` só protege repetição idêntica, não alternância.
 */
const SCAN_HINT_MS = 2000;

/**
 * Folga da área de acerto do toque no quadro, em PIXELS de tela — o erro de mira
 * do dedo é de tela, não de parede: a 6 m um 50×70 ocupa ~60 px, e uma folga
 * fixa em centímetros ali não compensaria nada.
 *
 * 12 px e 400 ms são os mesmos limiares com que o `GestureController` separa
 * toque de arraste, então o "toquei" do usuário e o "toquei" do código
 * concordam. Folga maior arriscaria destravar por engano.
 */
const TAP_PAD_PX = 12;
const TAP_MAX_MOVE_PX = 12;
const TAP_MAX_MS = 400;

/** Eixo da guinada. `setFromAxisAngle` não muta o eixo, então dá para compartilhar. */
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Escrachos de módulo para os caminhos quentes (loop de frame, `pointermove` do
 * arraste, `select`). Todos são escritos e consumidos dentro da MESMA chamada
 * síncrona — nada aqui sobrevive ao retorno da função que o usou, e nenhum dos
 * caminhos que os tocam reentra em si mesmo. Um `new THREE.Vector3()` num
 * `onPan` custa uma alocação por evento de ponteiro, ou seja 60–120 por segundo
 * durante todo o ajuste fino.
 */
const scratchVecA = new THREE.Vector3();
const scratchVecB = new THREE.Vector3();
const scratchVecC = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();

// `light-estimation` ainda não está em @types/webxr. Só o mínimo que usamos.
interface LightProbe {
  readonly probeSpace: XRSpace;
}
interface LightEstimate {
  readonly primaryLightIntensity?: DOMPointReadOnly;
}
type SessionWithProbe = XRSession & { requestLightProbe?: () => Promise<LightProbe> };
type FrameWithEstimate = XRFrame & {
  getLightEstimate?: (probe: LightProbe) => LightEstimate | null;
};

/**
 * Metros de mundo por pixel de tela, na distância dada.
 *
 * Lê o fator direto da matriz de projeção (`m[1][1] = 1/tan(fovV/2)`) em vez de
 * `camera.fov`: dentro da sessão quem renderiza é a câmera do WebXR, cujo FOV
 * vem do aparelho e não do valor que o R3F guarda na propriedade. Usar o `.fov`
 * ali deixaria o arraste com ganho errado — o quadro correria mais (ou menos) do
 * que o dedo. `worldPerPixel` continua servindo de reserva para uma projeção
 * degenerada.
 */
function wallMetersPerPixel(camera: THREE.Camera, distanceM: number, canvasH: number): number {
  const focal = camera.projectionMatrix.elements[5] ?? 0;
  if (focal > 0) return (2 * distanceM) / (focal * canvasH);
  return worldPerPixel(distanceM, (camera as THREE.PerspectiveCamera).fov ?? 60, canvasH);
}

/**
 * Origem e direção do raio de um evento de toque, em coordenadas de mundo.
 *
 * Mesma leitura que `useTouchHitTest.resolveFromEvent` faz, mas a FUNÇÃO de lá
 * não serve para o toque no quadro: ela é um escritor da pose de mira — liga
 * `activeRef` — e sairia cedo, porque o `enabled` dela é `!placed`.
 */
function readEventRay(
  event: XRInputSourceEvent,
  referenceSpace: XRReferenceSpace,
  outOrigin: THREE.Vector3,
  outDirection: THREE.Vector3,
): boolean {
  if (!event.frame) return false;
  const pose = event.frame.getPose(event.inputSource.targetRaySpace, referenceSpace);
  if (!pose) return false;
  const { position, orientation } = pose.transform;
  outOrigin.set(position.x, position.y, position.z);
  outDirection
    .set(0, 0, -1)
    .applyQuaternion(scratchQuat.set(orientation.x, orientation.y, orientation.z, orientation.w));
  return true;
}

export interface XRSceneProps {
  /** As peças do conteúdo. Um produto solto chega aqui como lista de uma. */
  items: KitItem[];
  /** Uma textura por peça, na mesma ordem. */
  arts: LoadedTexture[];
  style: Required<FrameStyle>;
  options: ResolvedOptions;
  api: ARApi;
  /** Elemento que captura o arraste de ajuste. Null até o palco montar. */
  stage: HTMLElement | null;
}

function XRSceneImpl({
  items,
  arts,
  style,
  options,
  api,
  stage,
}: XRSceneProps): React.ReactElement {
  const session = useXR((state) => state.session);
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);

  const groupRef = useRef<THREE.Group | null>(null);
  const reticleRef = useRef<THREE.Group | null>(null);
  const placedRef = useRef(false);
  /**
   * Espelho de `locked` para o handler de `select`, que roda fora do render: o
   * efeito que registra o handler não tem `locked` nas dependências, então o
   * closure nunca veria a mudança de estado.
   */
  const lockedRef = useRef(false);
  const lightProbeRef = useRef<LightProbe | null>(null);
  /**
   * Pose do quadro ancorado, antes do ajuste fino. É a âncora quem a atualiza a
   * cada frame (correção de drift do ARCore); sem âncora concedida ela fica
   * parada no ponto do toque.
   */
  const basePositionRef = useRef(new THREE.Vector3());
  const baseQuaternionRef = useRef(new THREE.Quaternion());
  /**
   * Deslocamento acumulado pelo ajuste fino, em metros, SOMADO à pose base a
   * cada frame. Guardado à parte (em vez de escrito direto no grupo) porque a
   * âncora reescreve a pose continuamente — somar no grupo seria acumular sem
   * fim, e escrever na base seria perder a correção de drift.
   */
  const dragOffsetRef = useRef(new THREE.Vector3());
  /**
   * O espaço em que o three renderiza, guardado no loop. O handler de `select`
   * roda fora do `useFrame` e precisa dele para ler o raio do toque.
   */
  const referenceSpaceRef = useRef<XRReferenceSpace | null>(null);
  /**
   * Instante e direção do raio no `selectstart`, para separar toque de arraste
   * com o quadro travado. O `select` cru do WebXR não distingue os dois, e nessa
   * janela o `GestureController` está desanexado — sem o filtro, um deslize que
   * termine sobre o quadro o destravaria sem que ninguém tenha pedido.
   */
  const selectStartAtRef = useRef(0);
  const selectStartDirRef = useRef(new THREE.Vector3());
  const selectStartValidRef = useRef(false);
  /**
   * Pose do observador no último frame XR.
   *
   * Amostrada dentro do loop, e NÃO no cleanup do unmount: quando a sessão morre,
   * o `<XR>` já devolveu a câmera original ao R3F — sincronamente, dentro do
   * `setState` da store dele, portanto antes de qualquer cleanup de efeito. Ler
   * `camera` na saída daria a pose de antes de entrar no AR, e o quadro
   * reapareceria perto da origem na sessão seguinte.
   */
  const viewerPositionRef = useRef(new THREE.Vector3());
  const viewerQuaternionRef = useRef(new THREE.Quaternion());
  const hasViewerPoseRef = useRef(false);
  /** Restaurar acontece no máximo uma vez por sessão, com ou sem pose guardada. */
  const restoreDoneRef = useRef(false);

  const [metrics, setMetrics] = useState<FrameMetrics | null>(null);
  const [ambient, setAmbient] = useState(1);
  /** Superfície de parede realmente detectada sob o dedo — pinta o contorno de verde. */
  const [onSurface, setOnSurface] = useState(false);
  // Par ref+state: a ref é lida no `useFrame`, o state é o que a interface vê.
  // Só com o state a opacidade sai de 0.85 e o cadeado aparece.
  const [placed, setPlaced] = useState(false);
  const [locked, setLocked] = useState(false);

  const [anchor, createAnchor] = useXRAnchor();

  // Valores de render lidos de dentro de handlers imperativos (o `select` da
  // sessão e os gestos), que rodam fora do ciclo de render do React. Mutado no
  // lugar em vez de substituído: o objeto é lido a cada `pointermove`, e trocá-lo
  // por um novo a cada render é lixo que não paga nada.
  const latest = useRef({ camera, size, metrics });
  latest.current.camera = camera;
  latest.current.size = size;
  latest.current.metrics = metrics;

  const touch = useTouchHitTest({
    assumedWallDistanceM: options.assumedWallDistanceM,
    wallToleranceDeg: options.wallToleranceDeg,
    enabled: !placed,
  });

  const scanHintAtRef = useRef(0);

  const handleScanHint = useCallback(
    (hint: ARHint) => {
      // Quem está com o dedo na tela já recebeu 'hold-to-aim': a varredura não
      // atropela a dica do gesto em andamento. Ancorado, ela não tem mais assunto.
      if (placedRef.current || touch.activeRef.current) return;

      // 'tap-to-place' é o estado BOM e passa direto. Ele é reemitido a cada
      // frame estável e o `setHint` deduplica valor igual, então não há nada a
      // segurar — segurá-lo é que deixaria o texto pedindo para mover o celular
      // com o retículo já verde na parede. Marcar o instante mesmo assim faz o
      // piso valer na volta: perder o alvo por um piscar não traz a reclamação de
      // imediato.
      const now = performance.now();
      if (hint !== 'tap-to-place' && now - scanHintAtRef.current < SCAN_HINT_MS) return;
      scanHintAtRef.current = now;
      api.setHint(hint);
    },
    [api, touch],
  );

  /**
   * Varredura do centro da tela, só para o retículo aparecer ANTES do primeiro
   * toque. Declarada logo depois do `useTouchHitTest` de propósito: ela registra
   * o próprio `useFrame`, e como os dois vivem neste mesmo componente a ordem de
   * declaração é a ordem de inscrição — o loop abaixo lê refs deste frame, não do
   * anterior.
   *
   * `manualMode: true` apesar de não haver modo manual nenhum aqui: é o que
   * impede `progressHint` de escalar até 'no-wall-found', que no `useAR` não é
   * dica — grava `status: 'error'` e abre painel modal. Neste fluxo o toque nunca
   * é recusado, então oferecer "posicionar manualmente" seria oferecer o que já
   * está ligado.
   */
  const scan = useHitTest({
    wallToleranceDeg: options.wallToleranceDeg,
    noHitTimeoutMs: options.noHitTimeoutMs,
    enabled: !placed,
    manualMode: true,
    onHint: handleScanHint,
  });

  const stats = useFrameStats(options.debug);
  const lastDebugAtRef = useRef(0);

  // A sessão XR está no ar: só agora o overlay pode sair de 'loading'.
  // `canCapture: false` — dentro de uma XRSession o render vai para o
  // framebuffer do compositor e a imagem da câmera nunca esteve no nosso.
  useEffect(() => {
    if (session) api.reportEngineReady('webxr', false);
  }, [session, api]);

  // O HUD em si é emitido de dentro do loop, a 4 Hz — aqui só fica a limpeza.
  useEffect(() => {
    if (!options.debug) return;
    return () => api.setDebug(null);
  }, [api, options.debug]);

  // Light probe: opcional, pode não ter sido concedida.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    void (session as SessionWithProbe)
      .requestLightProbe?.()
      .then((probe) => {
        if (!cancelled) lightProbeRef.current = probe;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      lightProbeRef.current = null;
    };
  }, [session]);

  const place = useCallback(() => {
    const group = groupRef.current;
    if (!group || !touch.activeRef.current) return;

    placedRef.current = true;
    setPlaced(true);
    // Ancorar não trava: o cadeado começa aberto para o ajuste fino.
    lockedRef.current = false;
    setLocked(false);
    dragOffsetRef.current.set(0, 0, 0);
    basePositionRef.current.copy(touch.position);
    baseQuaternionRef.current.copy(touch.quaternion);

    // Anchors reduzem materialmente o drift depois de 30 s parado — e o usuário
    // fica bastante tempo olhando para o quadro. Falha é aceitável: a feature
    // pode não ter sido concedida.
    void createAnchor({
      relativeTo: 'world',
      worldPosition: touch.position.clone(),
      worldQuaternion: touch.quaternion.clone(),
    }).catch(() => undefined);

    const cameraPosition = new THREE.Vector3();
    camera.getWorldPosition(cameraPosition);

    api.reportPlaced({
      distanceMeters: touch.position.distanceTo(cameraPosition),
      // A profundidade só é medida quando havia superfície de parede sob o dedo;
      // caso contrário foi a distância assumida, que é o mesmo que 'manual'.
      source: touch.qualityRef.current === 'plane' ? 'hit-test' : 'manual',
      position: { x: touch.position.x, y: touch.position.y, z: touch.position.z },
    });
  }, [api, camera, createAnchor, touch]);

  /**
   * Recoloca o quadro guardado ao sair da sessão anterior.
   *
   * A pose retida é relativa ao observador porque coordenada de mundo não
   * atravessa sessões: cada `local-floor` novo tem a própria origem. O que volta
   * fiel é a distância até a parede e o ângulo relativo a para onde o usuário
   * olha AGORA; o que não volta é o vínculo com o cômodo — se ele andou dois
   * passos entre sair e voltar, o quadro reaparece deslocado por esse tanto.
   */
  const restore = useCallback(
    (pose: RelativeFramePose, viewer: XRRigidTransform) => {
      const next = absoluteFramePose(pose, viewer.position, viewer.orientation);

      basePositionRef.current.set(next.x, next.y, next.z);
      baseQuaternionRef.current.setFromAxisAngle(UP, next.yaw);
      dragOffsetRef.current.set(0, 0, 0);
      placedRef.current = true;
      setPlaced(true);
      // Volta DESTRAVADO: travar afirmaria uma precisão que uma estimativa não
      // tem. O estado de ajuste já é, ele próprio, o convite a corrigir.
      lockedRef.current = false;
      setLocked(false);

      // A âncora tem de nascer aqui, e só aqui: `requestXRAnchor` espera um frame
      // da sessão para resolver, então precisa da sessão viva — e esta é a nova.
      void createAnchor({
        relativeTo: 'world',
        worldPosition: basePositionRef.current.clone(),
        worldQuaternion: baseQuaternionRef.current.clone(),
      }).catch(() => undefined);

      api.reportPlaced({
        distanceMeters: Math.hypot(
          next.x - viewer.position.x,
          next.y - viewer.position.y,
          next.z - viewer.position.z,
        ),
        // 'auto' é o que distingue "o usuário posicionou" de "nós restauramos" —
        // para o integrador no `onPlace`, e para o toast que avisa da estimativa.
        source: 'auto',
        position: { x: next.x, y: next.y, z: next.z },
      });
    },
    [api, createAnchor],
  );

  const reset = useCallback(() => {
    placedRef.current = false;
    setPlaced(false);
    lockedRef.current = false;
    setLocked(false);
    setOnSurface(false);
    dragOffsetRef.current.set(0, 0, 0);
    touch.restart();
    // Obrigatório: com `enabled: false` o callback da varredura sai antes de
    // `evaluate`, então `outcomeRef`/`hasCandidateRef` CONGELAM no último valor —
    // eles não voltam a 'lost' sozinhos, e o retículo reapareceria na pose antiga.
    scan.restart();
    api.reportUnplaced();
  }, [api, touch, scan]);

  /**
   * Travar recria a âncora onde o quadro realmente está. Sem isso, a correção de
   * drift do ARCore continuaria puxando o quadro para o ponto do toque original
   * e o ajuste fino escorreria de volta ao longo dos minutos.
   */
  const applyLock = useCallback(
    (next: boolean) => {
      if (next) {
        // A base absorve o ajuste e o offset zera. Isso vale mesmo se a âncora
        // não for concedida: a pose final é a mesma, só sem correção de drift.
        basePositionRef.current.add(dragOffsetRef.current);
        dragOffsetRef.current.set(0, 0, 0);
        void createAnchor({
          relativeTo: 'world',
          worldPosition: basePositionRef.current.clone(),
          worldQuaternion: baseQuaternionRef.current.clone(),
        }).catch(() => undefined);
      }
      lockedRef.current = next;
      setLocked(next);
      api.setLocked(next);
    },
    [api, createAnchor],
  );

  /**
   * O toque acertou o quadro já ancorado?
   *
   * A pose corrente é `base + ajuste`, e o plano testado é o da FACE FRONTAL: o
   * pivô do grupo fica no centro da face de trás e a geometria só começa em
   * `WALL_OFFSET`, então mirar o plano do pivô deslocaria o acerto alguns
   * centímetros — sempre para o mesmo lado.
   */
  const tapHitsFrame = useCallback((origin: THREE.Vector3, direction: THREE.Vector3): boolean => {
    const { camera, size, metrics } = latest.current;
    if (!metrics) return false;

    const normal = scratchVecA.set(0, 0, 1).applyQuaternion(baseQuaternionRef.current);
    const center = scratchVecB
      .copy(basePositionRef.current)
      .add(dragOffsetRef.current)
      .addScaledVector(normal, WALL_OFFSET + metrics.outer.d);

    const cameraPosition = scratchVecC;
    camera.getWorldPosition(cameraPosition);
    const pad =
      TAP_PAD_PX * wallMetersPerPixel(camera, cameraPosition.distanceTo(center), size.height || 1);

    return rayHitsRect(
      THREE,
      origin,
      direction,
      center,
      baseQuaternionRef.current,
      metrics.outer.w / 2 + pad,
      metrics.outer.h / 2 + pad,
    );
  }, []);

  /**
   * O gesto foi um toque, e não um arraste?
   *
   * O desvio angular do raio vira pixels de tela pelo mesmo fator da matriz de
   * projeção que o ajuste fino usa. A distância se cancela na conta, então o
   * limiar de 12 px vale igual a 50 cm e a 6 m da parede.
   */
  const isTap = useCallback((direction: THREE.Vector3): boolean => {
    if (!selectStartValidRef.current) return false;
    if (performance.now() - selectStartAtRef.current > TAP_MAX_MS) return false;

    const angle = selectStartDirRef.current.angleTo(direction);
    // 45° de desvio já é arraste em qualquer definição, e o corte mantém `tan` no
    // ramo positivo: passando de 90° ela vira negativa e o teste abaixo passaria
    // a aceitar justamente os gestos mais largos.
    if (angle >= Math.PI / 4) return false;

    const { camera, size } = latest.current;
    const focal = camera.projectionMatrix.elements[5] ?? 0;
    if (focal <= 0) return true;
    return (Math.tan(angle) * focal * (size.height || 1)) / 2 <= TAP_MAX_MOVE_PX;
  }, []);

  /**
   * O dedo encostado mira; soltar ancora.
   *
   * `selectstart` reinicia a suavização — sem isso o quadro escorregaria desde o
   * ponto do toque anterior até o novo.
   *
   * Depois de ancorado, o único toque que faz alguma coisa é o que acerta o
   * PRÓPRIO quadro com o cadeado fechado, e ele apenas reabre o ajuste — não move
   * nada. Tocar fora continua sendo nada: realocar num toque perdido era o que
   * devolvia o quadro a seguir a câmera, que é exatamente a sensação de "o quadro
   * não trava". Destravado o toque também é nada, porque arrastar já ajusta — e
   * esse guard é o que evita um toast a cada fim de arraste sobre o quadro.
   */
  useEffect(() => {
    if (!session) return;

    const origin = new THREE.Vector3();
    const direction = new THREE.Vector3();

    const onSelectStart = (event: XRInputSourceEvent): void => {
      const referenceSpace = referenceSpaceRef.current;
      if (placedRef.current) {
        // Só há o que medir com o cadeado fechado: é a única janela em que um
        // toque volta a significar alguma coisa.
        selectStartAtRef.current = performance.now();
        selectStartValidRef.current =
          lockedRef.current &&
          referenceSpace != null &&
          readEventRay(event, referenceSpace, origin, selectStartDirRef.current);
        return;
      }
      selectStartValidRef.current = false;
      touch.begin();
      api.setHint('hold-to-aim');
    };

    const onSelect = (event: XRInputSourceEvent): void => {
      const referenceSpace = referenceSpaceRef.current;

      if (placedRef.current) {
        if (!(lockedRef.current && referenceSpace)) return;
        if (!readEventRay(event, referenceSpace, origin, direction)) return;
        if (isTap(direction) && tapHitsFrame(origin, direction)) applyLock(false);
        return;
      }

      if (!touch.activeRef.current && referenceSpace) {
        touch.resolveFromEvent(event, referenceSpace);
      }
      if (touch.activeRef.current) place();
      else api.setHint('tap-to-place');
    };

    session.addEventListener('selectstart', onSelectStart);
    session.addEventListener('select', onSelect);
    return () => {
      session.removeEventListener('selectstart', onSelectStart);
      session.removeEventListener('select', onSelect);
    };
  }, [session, place, touch, api, applyLock, isTap, tapHitsFrame]);

  /**
   * Guarda a pose ao desmontar — e desmontar, agora, É o fim da sessão: o
   * `<XRSessionGate>` derruba esta cena junto com ela.
   *
   * Dependências vazias e `api` lido por ref de propósito. O `api` troca de
   * identidade quando as capacidades resolvem, pouco depois da montagem; com ele
   * nas dependências o efeito reanexaria e gravaria a pose fora de hora, com o
   * usuário ainda dentro da sessão.
   */
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    return () => {
      if (!placedRef.current || !hasViewerPoseRef.current) return;
      const world = basePositionRef.current.clone().add(dragOffsetRef.current);
      apiRef.current.retainPose(
        relativeFramePose(
          world,
          baseQuaternionRef.current,
          viewerPositionRef.current,
          viewerQuaternionRef.current,
        ),
      );
    };
  }, []);

  useEffect(() => {
    api.registerReposition(reset);
    return () => api.registerReposition(null);
  }, [api, reset]);

  useEffect(() => {
    api.registerLock(applyLock);
    return () => api.registerLock(null);
  }, [api, applyLock]);

  /**
   * Ajuste fino: arrastar o dedo desliza o quadro NO PLANO DA PAREDE.
   *
   * Os eixos vêm do quaternion do próprio grupo (X e Y locais são o plano da
   * parede, +Z é a normal), e não da câmera como no passthrough: assim uma
   * diagonal escorrega pela parede em vez de descolar o quadro dela.
   *
   * Só existe entre ancorar e travar — fora dessa janela o controlador nem é
   * anexado, então nenhum toque perdido move nada.
   */
  useEffect(() => {
    if (!stage || !placed || locked) return;

    const gestures = new GestureController(
      stage,
      {
        onPan(dxPx, dyPx) {
          const group = groupRef.current;
          if (!group) return;

          const cameraPosition = scratchVecA;
          latest.current.camera.getWorldPosition(cameraPosition);
          const worldPosition = scratchVecB;
          group.getWorldPosition(worldPosition);

          const perPixel = wallMetersPerPixel(
            latest.current.camera,
            cameraPosition.distanceTo(worldPosition),
            latest.current.size.height || 1,
          );

          // `right` e `up` reusam escrachos, então o acumulado tem de ser aplicado
          // um de cada vez: montar os dois antes de somar sobrescreveria o
          // primeiro.
          dragOffsetRef.current.addScaledVector(
            scratchVecC.set(1, 0, 0).applyQuaternion(group.quaternion),
            dxPx * perPixel,
          );
          dragOffsetRef.current.addScaledVector(
            scratchVecC.set(0, 1, 0).applyQuaternion(group.quaternion),
            -dyPx * perPixel,
          );
        },
      },
      // Pinça e rotação ficam de fora: no WebXR a distância é medida de verdade
      // pelo hit-test e o prumo vem da parede. Mexer neles aqui seria mentir.
      { move: true, scale: false, rotate: false },
    );

    gestures.attach();
    return () => gestures.detach();
  }, [stage, placed, locked]);

  useFrame((_state, _delta, xrFrame) => {
    // --- HUD de diagnóstico, a 4 Hz ---------------------------------------
    // Antes do early-return do grupo de propósito: um HUD que some justamente
    // quando a cena não montou esconde o caso que mais interessa diagnosticar.
    if (options.debug) {
      const now = performance.now();
      if (now - lastDebugAtRef.current >= DEBUG_INTERVAL_MS) {
        lastDebugAtRef.current = now;
        api.setDebug({
          engine: 'webxr',
          // O WebXR não usa o giroscópio da página: o rastreamento é 6-DoF do
          // runtime, então a sessão viva já é a resposta.
          hasOrientation: session != null,
          angles: null,
          yaw: 'ok',
          ...stats.current,
        });
      }
    }

    const group = groupRef.current;
    if (!group) return;

    // --- luz ambiente -----------------------------------------------------
    const probe = lightProbeRef.current;
    if (xrFrame && probe) {
      const intensity = (xrFrame as FrameWithEstimate).getLightEstimate?.(
        probe,
      )?.primaryLightIntensity;
      if (intensity) {
        const next = ambientFromLightEstimate(intensity.x, intensity.y, intensity.z);
        // Só re-renderiza em mudança perceptível; o probe atualiza a cada frame.
        if (Math.abs(next - ambient) > 0.01) setAmbient(next);
      }
    }

    const referenceSpace = (
      _state.gl.xr as THREE.WebXRManager & {
        getReferenceSpace(): XRReferenceSpace | null;
      }
    ).getReferenceSpace();
    referenceSpaceRef.current = referenceSpace;

    // --- pose do observador: amostrar e, na primeira vez, restaurar ---------
    // Só se houver o que fazer com ela: restaurar (uma vez por sessão) ou guardar
    // para a próxima entrada, o que só interessa com algo ancorado.
    const needsViewer = !restoreDoneRef.current || placedRef.current;
    const viewer =
      needsViewer && xrFrame && referenceSpace ? xrFrame.getViewerPose(referenceSpace) : null;

    if (viewer) {
      const { position, orientation } = viewer.transform;
      viewerPositionRef.current.set(position.x, position.y, position.z);
      viewerQuaternionRef.current.set(orientation.x, orientation.y, orientation.z, orientation.w);
      hasViewerPoseRef.current = true;

      // No primeiro frame COM pose, não no primeiro frame: nos primeiros o
      // runtime ainda pode não ter uma, e restaurar contra a origem poria o
      // quadro no chão, aos pés do usuário.
      if (!restoreDoneRef.current) {
        restoreDoneRef.current = true;
        const retained = api.takeRetainedPose();
        if (retained) restore(retained, viewer.transform);
      }
    }

    // --- já ancorado: a âncora manda, o ajuste fino soma -------------------
    if (placedRef.current) {
      if (anchor && xrFrame) {
        const pose = referenceSpace ? xrFrame.getPose(anchor.anchorSpace, referenceSpace) : null;
        if (pose) {
          const { position, orientation } = pose.transform;
          basePositionRef.current.set(position.x, position.y, position.z);
          baseQuaternionRef.current.set(orientation.x, orientation.y, orientation.z, orientation.w);
        }
      }
      // Sempre base + offset, nunca soma no grupo: o grupo é recomposto todo
      // frame, então acumular nele cresceria sem limite quando a âncora não
      // existe. Ao travar o offset é absorvido pela base e zerado.
      group.position.copy(basePositionRef.current).add(dragOffsetRef.current);
      group.quaternion.copy(baseQuaternionRef.current);
      group.visible = true;
      // O contorno era o feedback da mira; fixado o quadro, ele só polui.
      if (reticleRef.current) reticleRef.current.visible = false;
      return;
    }

    // --- mira: duas fontes, uma precedência --------------------------------
    // O dedo SEMPRE ganha do centro da tela. A varredura existe só para antecipar
    // o retículo enquanto ninguém tocou; se tivesse voto depois disso, o lugar do
    // quadro voltaria a ser escolhido pela ferramenta e não pelo usuário.
    if (xrFrame && referenceSpace) touch.update(xrFrame, referenceSpace);

    const aiming = touch.activeRef.current;
    // `hasCandidateRef` e não `outcomeRef.kind`: ele já carrega a histerese
    // inteira (5 quadros válidos + 200 ms de carência), enquanto `kind` cai para
    // 'grace' a cada buraco de um frame do ARCore e faria o retículo piscar. De
    // quebra, com este gate fechado nunca se lê a pose do tracker nos dois
    // estados em que ela mente: antes do primeiro hit, quando vale (0,0,0), e em
    // 'lost', quando é a última pose válida congelada.
    const scanning = !aiming && scan.hasCandidateRef.current;
    const reticle = reticleRef.current;

    // O QUADRO só com o dedo na tela. Um quadro translúcido seguindo a cabeça do
    // usuário é exatamente a sensação de "não fica onde eu quero" descrita no
    // comentário do `select`; o contorno já responde "cabe entre a porta e a
    // estante?", que é a pergunta do preview. Inverter é uma linha, se o teste em
    // aparelho contrariar: `group.visible = aiming || scanning`.
    group.visible = aiming;
    if (reticle) reticle.visible = aiming || scanning;
    if (!(aiming || scanning)) return;

    if (aiming) {
      group.position.copy(touch.position);
      group.quaternion.copy(touch.quaternion);
    }
    if (reticle) {
      // As duas fontes expõem `position`/`quaternion` com os mesmos nomes, e a
      // união dá acesso de LEITURA a ambos — que é tudo o que se usa aqui. Não
      // chamar métodos por `pose`: o tracker tem `reset()`, o hook tem
      // `restart()`. Nenhuma das duas poses precisa de WALL_GAP: `HitTestTracker`
      // e `resolveTouchCandidate` já afastam os 5 mm da parede.
      const pose = aiming ? touch : scan.tracker;
      reticle.position.copy(pose.position);
      reticle.quaternion.copy(pose.quaternion);
    }

    // Verde = profundidade medida. Sob o dedo é o hit daquele ponto; na varredura
    // o retículo só existe tendo havido plano, então ali ele nasce verde. Âmbar
    // fica reservado a "profundidade assumida", que só acontece no modo dedo.
    const detected = aiming ? touch.qualityRef.current === 'plane' : true;
    if (detected !== onSurface) setOnSurface(detected);
  });

  return (
    <>
      <KitModel
        ref={groupRef}
        items={items}
        arts={arts}
        style={style}
        ambient={ambient}
        // 0.85 sob o dedo deixa claro que ainda não está fixado.
        opacity={placed ? 1 : 0.85}
        visible={false}
        onMetrics={setMetrics}
      />
      {metrics && (
        <Reticle
          ref={reticleRef}
          width={metrics.outer.w}
          height={metrics.outer.h}
          stable={onSurface}
          visible={false}
        />
      )}
    </>
  );
}

/**
 * Memo: o elemento é filho do `<Canvas>`, e o layout effect do R3F reconcilia a
 * árvore inteira a cada render de quem hospeda o canvas. Sem isto, uma dica de
 * texto ou um toast fariam este componente — o mais caro da aplicação —
 * re-renderizar no meio da sessão de AR.
 */
export const XRScene = memo(XRSceneImpl);
