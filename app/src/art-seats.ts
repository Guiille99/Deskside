// Sentarse en las salas: poses sin mesa delante y la silla de perfil. Mismo formato y paleta que art.ts (puro, sin Phaser).
import { CHAR } from './art.ts';

// Cabeza y torso del personaje sentado de art.ts (cabeza 16×12, cuello, cuerpo y brazos).
const HEAD = CHAR[0].slice(0, 12), [COLLAR, BODY, ARMS] = CHAR[0].slice(12, 15);

// Por personaje (se generan con charPalette). front: de frente, manos en el regazo y piernas dobladas (16×19), para el sofá.
// back: de espaldas, sin piernas (16×18); la silla de delante tapa de la fila 16 hacia abajo.
// side: de perfil mirando a la derecha (16×22), muslos hacia delante; mirando a la izquierda con flipX.
export const SEATED: Record<'front' | 'back' | 'side', string[]> = {
  front: [...HEAD, COLLAR, BODY, ARMS, '..oSccccccccSo..', '..oppppppppppo..', '...oppo..oppo...', '...oooo..oooo...'],
  back: [
    '....oooooooo....', '...ohhhhhhhho...', ...Array(6).fill('..ohhhhhhhhhho..'), '..oShhhhhhhhSo..', '..oSHhhhhhhHSo..',
    '...oHHHHHHHHo...', '....oSSSSSSo....', COLLAR.replace(/w/g, 'c'), BODY, ARMS, ARMS, ARMS, ARMS,
  ],
  side: [
    '....oooooooo....', '...ohhhhhhhho...', '..ohhhhhhhhhho..', '..ohhhhhhhhhho..', '..ohhhhhhhssso..', '..ohhhhhssssso..',
    '..ohhhhSssowso..', '..ohhhhSssooso..', '..ohhhhssssmso..', '..ohhhSssssmso..', '...oHSSsssSSo...', '....oooooooo....',
    '.....occcwo.....', '....occcccco....', '....oCccccco....', '....oCcccsSo....', '....oppppppppo..', '....oPPPPPPppo..',
    '....oooooooppo..', '..........oppo..', '..........oPPPo.', '..........ooooo.',
  ],
};

// Silla de perfil (10×11) con el respaldo a la izquierda, para quien se sienta mirando a la derecha.
export const SEAT_SPRITES: Record<string, string[]> = {
  'chair-side': [
    'oo........', ...Array(5).fill('obo.......'), 'oboooooooo', 'oBbbbbbbbo', 'oooooooooo', '.o......o.', '.o......o.',
  ],
};
