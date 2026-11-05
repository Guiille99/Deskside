// Iconos de herramienta en pixel art (8×8) dentro de un bocadillo (12×14), mismo estilo que art.ts: contorno oscuro y
// colores planos. Puro, sin Phaser, para probarlo con node --test. Paleta propia para no tocar la de art.ts.
export const ICON_PALETTE: Record<string, string> = {
  o: '#2b2233', w: '#f6f2ea', // contorno y fondo del bocadillo
  b: '#3d7fd9', B: '#a8dcec', k: '#6b4426', // azul, cristal, mango
  y: '#f2c94c', p: '#e0889a', e: '#e8d49a', // lápiz: cuerpo, goma, madera
  v: '#1f2a3a', g: '#4ade80', G: '#3f9a4a', n: '#9aa0b0', N: '#6b7080', // pantalla, verde, gris
  s: '#f3c9a4', u: '#8b5cf6', m: '#d9467a', // piel, violeta, magenta
};

export type ToolIcon = 'read' | 'edit' | 'shell' | 'web' | 'agent' | 'mcp' | 'other';

const ICONS: Record<ToolIcon, string[]> = {
  read: [ // lupa
    '.oooo...', 'oBwBBo..', 'oBBBBo..', 'oBBBBo..', '.ooooo..', '....okk.', '.....okk', '......ok',
  ],
  edit: [ // lápiz en diagonal
    '.....oo.', '....oppo', '...oyyo.', '..oyyo..', '.oyyo...', 'oeeo....', 'oko.....', 'oo......',
  ],
  shell: [ // terminal con «>_»
    'oooooooo', 'onnnnnno', 'ogvvvvvo', 'ovgvvvvo', 'ogvvvvvo', 'ovvvggvo', 'ovvvvvvo', 'oooooooo',
  ],
  web: [ // globo terráqueo
    '..oooo..', '.obGGbo.', 'obbGbbbo', 'oGGbbGbo', 'obGbbGGo', 'obbbbGbo', '.obbGbo.', '..oooo..',
  ],
  agent: [ // personita
    '...oo...', '..osso..', '..osso..', '...oo...', '.ouuuuo.', 'ouuuuuuo', 'ouuuuuuo', 'oooooooo',
  ],
  mcp: [ // enchufe
    '..o..o..', '..o..o..', '.oooooo.', '.ommmmo.', '.ommmmo.', '..ommo..', '...oo...', '....oo..',
  ],
  other: [ // engranaje
    '...oo...', '.oonnoo.', '.onNNno.', 'onNooNno', 'onNooNno', '.onNNno.', '.oonnoo.', '...oo...',
  ],
};

// Bocadillo redondeado con el icono a 2 px del borde y la cola centrada abajo.
const TOP = '.oooooooooo.', SIDE = 'owwwwwwwwwwo';
const bubbled = (icon: string[]) => [TOP, SIDE, ...icon.map((r) => `ow${r}wo`), SIDE, '.oooowwoooo.', '....owwo....', '.....oo.....'];
export const ICON_SPRITES = Object.fromEntries(Object.entries(ICONS).map(([k, v]) => [k, bubbled(v)])) as Record<ToolIcon, string[]>;

// Categoría por nombre de herramienta; null sin herramienta en curso.
const CATEGORY: [RegExp, ToolIcon][] = [
  [/^(Read|Grep|Glob|LS|NotebookRead)$/, 'read'],
  [/^(Write|Edit|MultiEdit|NotebookEdit)$/, 'edit'],
  [/^(Bash|PowerShell|BashOutput|KillShell)$/, 'shell'],
  [/^Web/, 'web'],
  [/^(Agent|Task)$/, 'agent'],
  [/^mcp__/, 'mcp'],
];
export function toolIcon(tool: string | null | undefined): ToolIcon | null {
  if (!tool) return null;
  return CATEGORY.find(([re]) => re.test(tool))?.[1] ?? 'other';
}
