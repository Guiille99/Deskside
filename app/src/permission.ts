// Texto del globo «esperando permiso» y formato de duraciones. Puro (sin Phaser) para probarlo con node --test.
export function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min` : s < 86400 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 86400)} d`;
}

// `since` = ms epoch del último cambio de estado; sin él no se sabe cuánto lleva esperando.
export const permissionText = (since: number | null, now: number) => (since === null ? '?' : `? ${dur(now - since)}`);
