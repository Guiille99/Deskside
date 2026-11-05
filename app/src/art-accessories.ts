// Accesorio sobre la cabeza según el tipo de agente, para distinguirlos sin pasar el ratón. Puro, sin Phaser.
// Mismo formato que art.ts (16 de ancho, claves de PALETTE). La fila LIFT de cada sprite coincide con la fila 0 de la
// cabeza (HEAD); las de arriba sobresalen por encima. Sirve igual sentado, de pie y caminando (la cabeza es la misma).
export const LIFT = 2;

export const ACCESSORIES: Record<string, string[]> = {
  cap: [ // Explore: gorra verde con visera
    '................', '....oooooooo....', '...olllllllyo...', '..olllllllllyo..',
    '..olLlllllllLo..', '.oLLLLLLLLLLLLo.', '.oooooooooooooo.',
  ],
  glasses: [ // Plan: gafas rojas sobre los ojos (filas 5-8 de la cabeza), sin tapar los ojos
    ...Array(7).fill('.'.repeat(16)),
    '...XXXX..XXXX...', '...X..XXXX..X...', '...X..X..X..X...', '...XXXX..XXXX...',
  ],
  headphones: [ // general-purpose: diadema y cascos a los lados
    '.....oooooo.....', '...oonnnnnnoo...', '..onno....onno..', '.ono........ono.', '.ono........ono.',
    '.ono........ono.', '.ono........ono.', 'oooo........oooo', 'ozvo........ovzo', 'ozvo........ovzo',
    'ozvo........ovzo', 'oooo........oooo',
  ],
  crown: [ // sesión principal (MAIN): corona pequeña
    '....o..oo..o....', '...oYooYYooYo...', '...oYYYYYYYYo...', '...oooooooooo...',
  ],
};

// Map y no objeto: un tipo arbitrario como 'toString' no debe encontrar nada.
const BY_TYPE = new Map([['Explore', 'cap'], ['Plan', 'glasses'], ['general-purpose', 'headphones']]);

// MAIN → corona; agente → según su primer tipo; tipo desconocido o sin tipo → ninguno (null).
export function accessory(r: { kind: 'session' } | { kind: 'agent'; agent_types: string[] }): string | null {
  return r.kind === 'session' ? 'crown' : BY_TYPE.get(r.agent_types[0]) ?? null;
}
