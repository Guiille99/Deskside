// Arte propio en pixel art, sin assets externos (nada que licenciar). Puro, sin Phaser, para probarlo con node --test.
// Píxel base dibujado a escala ×2. Cada sprite es una lista de filas; cada carácter es una clave de la paleta y '.' es
// transparente (formato de Phaser textures.generate, que admite cualquier carácter como clave).
// Estilo: contorno oscuro, vista de 3/4, personajes cabezones (chibi) y madera cálida.
export const SCALE = 2;

// Paleta única con claves mnemotécnicas. s/S, h/H y c/C cambian por personaje (piel, pelo y camisa, con su sombra).
export const PALETTE: Record<string, string> = {
  o: '#2b2233', w: '#f6f2ea', m: '#e07f74', // contorno y ojos, blanco, mejillas y boca
  s: '#f3c9a4', S: '#d99f7c', h: '#3a2a24', H: '#241915', c: '#e0a33a', C: '#b37a22', // por personaje
  p: '#3c4a6e', P: '#2b3552', // pantalón
  f: '#b07a48', F: '#a06c3e', g: '#85552f', // tarima
  d: '#a85f30', D: '#8a4a24', u: '#c27a42', q: '#5c3219', // mesas: tablero, frente, canto y oscuro
  n: '#e9e6df', N: '#b5b0a6', v: '#3d425c', // aparatos: claro, sombra, panel
  b: '#4a4f63', B: '#343849', // silla
  l: '#63b84c', L: '#3f8a3b', y: '#9ad46c', // hojas
  r: '#d9b27c', R: '#b8874e', // estantería y mueble claro
  x: '#b8403a', X: '#82292a', z: '#3d63ad', Z: '#2b467d', e: '#e8d49a', // libros y bebidas
  i: '#efe7dc', I: '#ddd2c3', j: '#c9bcaa', // baldosa de la cafetería
  a: '#3f6c9c', A: '#375f8a', E: '#4b7cb2', // moqueta
  G: '#a8dcec', K: '#6fb3cf', Y: '#f2c94c', // cristal y agua, sol
  M: '#c95d72', Q: '#9c4357', U: '#e0889a', // sofá
};
// Camisa por rol: MAIN ámbar, hijo inferido celeste, visitante violeta.
export const ROLES = { main: ['#e0a33a', '#b37a22'], child: ['#4fb3e8', '#2f80b8'], visitor: ['#a78bfa', '#7656d6'] } as const;
export type Role = keyof typeof ROLES;
export const SKINS = [['#f3c9a4', '#d99f7c'], ['#d4a373', '#b0805a'], ['#8d5a3b', '#6e4329']];
export const HAIRS = [['#3a2a24', '#241915'], ['#a0522d', '#7a3c1f'], ['#e8c872', '#c4a250'], ['#2f3b52', '#1f283a']];

// Cabeza grande con flequillo, ojos con brillo y mejillas (16×12).
const HEAD = [
  '....oooooooo....', '...ohhhhhhhho...', '..ohhhhhhhhhho..', '..ohhhhhhhhhho..',
  '..ohhhssshhhho..', '..ohssssssssho..', '..osowssssowso..', '..osoossssooso..',
  '..omssssssssmo..', '..oSsssmmsssSo..', '...oSSssssSSo...', '....oooooooo....',
];
const COLLAR = '...occcwwccco...', BODY = '..occcccccccco..', ARMS = '..ocCccccccCco..';
// Sentado de frente (16×18); el portátil tapa el pecho y la mesa, de la fila 16 hacia abajo. Marco 1 (tecleando): la cabeza baja 1 px.
export const CHAR = [
  [...HEAD, COLLAR, BODY, ARMS, ARMS, ARMS, ARMS],
  ['.'.repeat(16), ...HEAD, COLLAR, BODY, ARMS, ARMS, ARMS],
];
// De pie (16×21): parado y dos pasos.
const TOP = [...HEAD, COLLAR, BODY, ARMS, '..osCccccccCso..', '..oSoppppppoSo..', '...opppPPpppo...'];
export const STAND = [
  [...TOP, '...opppoopppo...', '...opppoopppo...', '...oooo..oooo...'],
  [...TOP, '...opppoopppo...', '...opppo.oooo...', '...oooo.........'],
  [...TOP, '...opppoopppo...', '...oooo.opppo...', '.........oooo...'],
];

const wide = (edge: string, fill: string, w: number, edge2 = edge) => edge + fill.repeat(w - edge.length - edge2.length) + edge2;
const books = (top: string, row: string) => ['oR' + 'q'.repeat(20) + 'Ro', 'oR' + top + 'Ro', 'oR' + row + 'Ro', 'oR' + row + 'Ro', wide('oR', 'r', 24, 'Ro')];
const DOOR = 'o' + ('R'.repeat(10) + 'q').repeat(3) + 'Ro';
const plain = wide('o', 'd', 56), papers = 'o' + 'd'.repeat(6) + 'wwww' + 'd'.repeat(34) + 'wwww' + 'd'.repeat(6) + 'o';
const lapEdge = 'o' + 'd'.repeat(22) + 'oooooooo' + 'd'.repeat(24) + 'o', lap = 'o' + 'd'.repeat(22) + 'onnnnnno' + 'd'.repeat(24) + 'o';
const papers2 = 'o' + 'd'.repeat(15) + 'www' + 'd'.repeat(20) + 'www' + 'd'.repeat(13) + 'o';
const board = (s: string) => 'oN' + s + 'No';

export const SPRITES: Record<string, string[]> = {
  desk: [ // 24×14 en 3/4: portátil de espaldas, taza, tablero, frente con cajón y patas
    '.......oooooooooo.......', '.......onnnNNnnno.......', '.......onnnnnnnno.......', 'o'.repeat(24),
    wide('o', 'u', 24), 'odwwN' + 'd'.repeat(18) + 'o', 'odNN' + 'd'.repeat(19) + 'o', wide('o', 'd', 24), 'o'.repeat(24),
    wide('o', 'D', 24), 'o' + 'D'.repeat(9) + 'qqqq' + 'D'.repeat(9) + 'o', wide('o', 'D', 24), 'o'.repeat(24), '.oqo' + '.'.repeat(16) + 'oqo.',
  ],
  chair: [ // 20×10: respaldo detrás del personaje
    '...' + 'o'.repeat(14) + '...', '..o' + 'b'.repeat(14) + 'o..', '.o' + 'b'.repeat(16) + 'o.',
    ...Array(7).fill('oB' + 'b'.repeat(16) + 'Bo'),
  ],
  plant: [ // 12×14, maceta blanca
    '.....l......', '..l..ly..l..', '..yl.ll.ly..', 'l.ylLlylLl.l', 'llyLlyLlylLl', '.lLlyLLlyLl.', '..lLLlLLLl..',
    '...LLLLLL...', '..oooooooo..', '..owwwwwwo..', '..owwwwwNo..', '...owwwNo...', '...owwwNo...', '....oooo....',
  ],
  // 16×16, tarima de tablas verticales (3 px y junta) con las juntas horizontales escalonadas
  floor: Array.from({ length: 16 }, (_, y) => [5, 13, 9, 1].map((seam, b) => (y === seam ? 'ggg' : b % 2 ? 'FFF' : 'fff') + 'g').join('')),
  bookshelf: [ // 24×19
    'o'.repeat(24), wide('o', 'r', 24), wide('o', 'R', 24),
    ...books('xXzZqqlLxzqZeeqXqzlq', 'xXzZeqlLxzzZeexXqzlL'), ...books('zZqeqxqlLqzxqeqzqlqe', 'zZeeqxXlLLzxXeqzZlxe'),
    'oR' + 'q'.repeat(20) + 'Ro', 'oRqqqqxXzlqqqqqqeeZzqqRo', 'oRqqqqxXzlqqqqqqeeZzqqRo', wide('o', 'R', 24), 'o'.repeat(24),
  ],
  vending: [ // 16×20
    'o'.repeat(16), wide('o', 'n', 16), 'on' + 'x'.repeat(12) + 'No', 'o' + 'n'.repeat(13) + 'No',
    'ono' + 'oooooo' + 'on' + 'vvv' + 'No',
    ...['xGzGlG|vwv', 'xGzGlG|vvv', 'GGGGGG|vYv', 'zGlGxG|vvv', 'zGlGxG|vYv', 'GGGGGG|vvv', 'lGxGzG|NNN', 'lGxGzG|NoN', 'GGGGGG|NNN']
      .map((t) => { const [g, p] = t.split('|'); return 'ono' + g + 'on' + p + 'No'; }),
    'ono' + 'oooooo' + 'on' + 'NNN' + 'No', 'o' + 'n'.repeat(13) + 'No', 'on' + 'o'.repeat(12) + 'No', 'o' + 'n'.repeat(13) + 'No',
    wide('o', 'N', 16), 'o'.repeat(16),
  ],
  cooler: [ // 10×15: garrafa y fuente
    '...oooo...', '..oGGGKo..', '..oGwGKo..', '..oGGGKo..', '..oKKKKo..', '...oooo...', '.oooooooo.',
    '.onnnnnNo.', '.onxnznNo.', '.onnnnnNo.', '.onnnnnNo.', '.onnnnnNo.', '.oNNNNNNo.', '.oooooooo.', '.oo....oo.',
  ],
  fridge: [ // 14×20
    'o'.repeat(14), 'o' + 'n'.repeat(11) + 'No', 'o' + 'n'.repeat(10) + 'oNo', 'o' + 'n'.repeat(10) + 'oNo', 'o' + 'n'.repeat(11) + 'No',
    wide('o', 'N', 14), 'o'.repeat(14), 'o' + 'n'.repeat(11) + 'No', ...Array(3).fill('o' + 'n'.repeat(10) + 'oNo'),
    ...Array(7).fill('o' + 'n'.repeat(11) + 'No'), wide('o', 'N', 14), 'o'.repeat(14),
  ],
  counter: [ // 36×15: barra con cafetera y tazas
    '....oooooo' + '.'.repeat(26), '....ovvvvo' + '.'.repeat(26), '....ovNNvo....ooo...ooo' + '.'.repeat(13),
    '....oooooo....owo...owo' + '.'.repeat(13), 'o'.repeat(36), wide('o', 'i', 36), wide('o', 'I', 36), 'o'.repeat(36),
    DOOR, DOOR, DOOR, DOOR, DOOR, 'o'.repeat(36), '.oqo' + '.'.repeat(28) + 'oqo.',
  ],
  clock: [ // 10×9
    '..oooooo..', '.owwwwwwo.', 'owwwowwwwo', 'owwwowwwwo', 'owwwoooowo', 'owwwwwwwwo', 'owwwwwwwwo', '.owwwwwwo.', '..oooooo..',
  ],
  whiteboard: [ // 32×13
    'o'.repeat(32), wide('o', 'N', 32), board('w'.repeat(28)), board('wxxxxxwwwzzzzzzzzww' + 'w'.repeat(9)), board('w'.repeat(28)),
    board('w' + 'z'.repeat(9) + 'w'.repeat(4) + 'l'.repeat(6) + 'w'.repeat(8)), board('w'.repeat(28)),
    board('w' + 'x'.repeat(4) + 'w'.repeat(6) + 'z'.repeat(7) + 'w'.repeat(10)), board('w'.repeat(28)), wide('o', 'N', 32), 'o'.repeat(32),
    '...' + 'N'.repeat(26) + '...',
  ],
  table: [ // 56×21: mesa de reuniones con papeles y portátil
    'o'.repeat(56), wide('o', 'u', 56), plain, papers, papers, papers, lapEdge, lap, lap, lap, lapEdge, papers2, papers2, plain,
    'o'.repeat(56), ...Array(3).fill(wide('o', 'D', 56)), 'o'.repeat(56), '.oqo' + '.'.repeat(48) + 'oqo.', '.oqo' + '.'.repeat(48) + 'oqo.',
  ],
  sofa: [ // 32×12
    '..' + 'o'.repeat(28) + '..', '.o' + 'U'.repeat(28) + 'o.', '.o' + 'M'.repeat(28) + 'o.', '.o' + 'M'.repeat(28) + 'o.',
    'oo' + 'Q'.repeat(28) + 'oo', 'oUUo' + 'U'.repeat(24) + 'oUUo', 'oMMo' + 'M'.repeat(24) + 'oMMo',
    'oMMo' + 'M'.repeat(11) + 'Q' + 'M'.repeat(12) + 'oMMo', 'oMMo' + 'M'.repeat(24) + 'oMMo', 'oQQo' + 'Q'.repeat(24) + 'oQQo',
    'o'.repeat(32), '.oqo' + '.'.repeat(24) + 'oqo.',
  ],
  picture: [ // 28×13: paisaje
    'o'.repeat(28), wide('o', 'r', 28), 'or' + 'G'.repeat(24) + 'ro', 'or' + 'GGGwwwGGGGGGGGGGGGGGGYYG' + 'ro',
    'or' + 'GGwwwwwGGGGGGGGGGGGGYYYY' + 'ro', 'or' + 'G'.repeat(24) + 'ro', 'or' + 'G'.repeat(8) + 'yy' + 'G'.repeat(14) + 'ro',
    'or' + 'GGGGGyyyyyGGGGGGGGyyyGGG' + 'ro', 'or' + 'yyyylllyyyyyyyyyylllyyyy' + 'ro',
    'or' + 'l'.repeat(6) + 'L'.repeat(3) + 'l'.repeat(9) + 'L'.repeat(2) + 'l'.repeat(4) + 'ro', 'or' + 'L'.repeat(24) + 'ro',
    wide('o', 'r', 28), 'o'.repeat(28),
  ],
  tile: [ // 16×16, baldosa con rombo
    'j'.repeat(16), ...Array(6).fill('j' + 'i'.repeat(15)), 'j' + 'i'.repeat(6) + 'I' + 'i'.repeat(8),
    'j' + 'i'.repeat(5) + 'III' + 'i'.repeat(7), 'j' + 'i'.repeat(6) + 'I' + 'i'.repeat(8), ...Array(6).fill('j' + 'i'.repeat(15)),
  ],
  carpet: ['aaaaaaaa', 'aEaaaaaa', 'aaaaaaaa', 'aaaaAaaa', 'aaaaaaaa', 'aaaaaEaa', 'aaaaaaaa', 'aAaaaaaa'],
};

// Variante estable por clave (piel × pelo), para que un personaje no cambie de aspecto entre refrescos.
export function variant(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return `${h % SKINS.length}${Math.floor(h / SKINS.length) % HAIRS.length}`;
}

export function charPalette(role: Role, v: string) {
  const [s, S] = SKINS[+v[0]], [h, H] = HAIRS[+v[1]], [c, C] = ROLES[role];
  return { ...PALETTE, s, S, h, H, c, C };
}
