import type { Locale } from '../core/errors';

export type StringKey =
  | 'start'
  | 'close'
  | 'photo'
  | 'retry'
  | 'lock'
  | 'unlock'
  | 'toast.locked'
  | 'toast.unlocked'
  | 'reposition'
  | 'manual'
  | 'keepTrying'
  | 'loading'
  | 'privacy'
  | 'hint.scan'
  | 'hint.move-slower'
  | 'hint.aim-wall'
  | 'hint.tap-to-place'
  | 'hint.no-wall-found'
  | 'hint.drag-to-move'
  | 'hint.no-yaw'
  | 'hint.adjust'
  | 'hint.placed';

const PT: Record<StringKey, string> = {
  start: 'Ver na minha parede',
  close: 'Fechar',
  photo: 'Tirar foto',
  retry: 'Tentar novamente',
  lock: 'Travar posição',
  unlock: 'Destravar posição',
  'toast.locked': 'Posição travada',
  'toast.unlocked': 'Posição liberada para ajuste',
  reposition: 'Reposicionar',
  manual: 'Posicionar manualmente',
  keepTrying: 'Continuar tentando',
  loading: 'Carregando…',
  privacy: 'Nenhuma imagem é enviada para servidores. Tudo acontece no seu aparelho.',
  'hint.scan': 'Aponte a câmera para a parede',
  // A paralaxe é o que constrói o plano; usuário parado nunca detecta nada.
  'hint.move-slower': 'Mova o celular lentamente de um lado para o outro',
  'hint.aim-wall': 'Isso parece o chão — aponte para a parede',
  'hint.tap-to-place': 'Toque na parede para posicionar',
  // O ARCore agarra em bordas quase instantaneamente. Uma linha de texto que
  // melhora a taxa de sucesso mais do que qualquer código.
  'hint.no-wall-found':
    'Não encontramos a parede. Tente apontar perto de um canto, um interruptor ou o batente da porta.',
  'hint.drag-to-move': 'Arraste para mover · pince para ajustar a distância',
  // Sem giroscópio/bússola não há rastreamento horizontal. Dizer isso é melhor do
  // que deixar o usuário achar que o quadro está escorregando.
  'hint.no-yaw':
    'Seu aparelho não rastreia giros na horizontal. Mantenha o celular parado, arraste o quadro e toque para fixar.',
  // Passo 3 do fluxo: já ancorado, ainda ajustável. O emoji repete o ícone do
  // botão porque é o que liga a frase ao controle sem uma seta apontando.
  'hint.adjust': 'Arraste para ajustar · 🔒 trava',
  'hint.placed': 'Quadro travado',
};

const EN: Record<StringKey, string> = {
  start: 'View on my wall',
  close: 'Close',
  photo: 'Take a photo',
  retry: 'Try again',
  lock: 'Lock position',
  unlock: 'Unlock position',
  'toast.locked': 'Position locked',
  'toast.unlocked': 'Free to adjust',
  reposition: 'Reposition',
  manual: 'Place manually',
  keepTrying: 'Keep trying',
  loading: 'Loading…',
  privacy: 'No image is sent to any server. Everything happens on your device.',
  'hint.scan': 'Point the camera at the wall',
  'hint.move-slower': 'Move the phone slowly from side to side',
  'hint.aim-wall': 'That looks like the floor — aim at the wall',
  'hint.tap-to-place': 'Tap the wall to place',
  'hint.no-wall-found':
    'We could not find the wall. Try aiming near a corner, a light switch or a door frame.',
  'hint.drag-to-move': 'Drag to move · pinch to adjust the distance',
  'hint.no-yaw':
    'Your device does not track horizontal rotation. Hold the phone still, drag the frame and tap to lock it.',
  'hint.adjust': 'Drag to adjust · 🔒 locks',
  'hint.placed': 'Frame locked',
};

export function createStrings(
  locale: Locale,
  overrides: Partial<Record<string, string>> = {},
): (key: StringKey) => string {
  const base = locale === 'en' ? EN : PT;
  return (key) => overrides[key] ?? base[key];
}
