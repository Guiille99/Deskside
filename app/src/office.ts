// Fase 5: oficina en Phaser 3 con placeholders. Cada sesión es una isla de mesas (layout.ts); los personajes
// se mueven con tweens. Todo el texto de la escena se pinta en canvas y el del HUD entra con textContent.
import Phaser from 'phaser';
import type { Row, State } from './types.ts';
import { layout, POD_W, SEAT, type Layout } from './layout.ts';

export const LABEL: Record<State, string> = {
  WORKING: 'Trabajando', PERMISSION: 'Esperando permiso', IDLE: 'Inactivo', ENDED: 'Terminado', STALE: 'Caducado',
};
// Categoría de herramienta → icono placeholder (texto) y color.
const ICON: [RegExp, string, string][] = [
  [/^(Read|Grep|Glob|LS|NotebookRead)$/, 'R', '#60a5fa'],
  [/^(Write|Edit|MultiEdit|NotebookEdit)$/, 'E', '#4ade80'],
  [/^(Bash|PowerShell|BashOutput|KillShell)$/, '>_', '#e5e7eb'],
  [/^Web/, '@', '#22d3ee'],
  [/^(Agent|Task)$/, 'A', '#c084fc'],
  [/^mcp__/, 'M', '#f472b6'],
];
const TINT = { main: 0xf59e0b, child: 0x38bdf8, visitor: 0xa78bfa };
const MOVE_MS = 600;

function bubble(r: Row): [string, string] {
  if (r.state === 'PERMISSION') return ['?', '#fbbf24'];
  if (r.state === 'IDLE') return ['zzz', '#94a3b8'];
  if (r.state === 'STALE') return ['…', '#64748b'];
  if (!r.tool) return ['', ''];
  const i = ICON.find(([re]) => re.test(r.tool!));
  return i ? [i[1], i[2]] : ['*', '#e5e7eb'];
}

const short = (id: string) => id.slice(0, 8);
function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min` : s < 86400 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 86400)} d`;
}

type Actor = { row: Row; body: Phaser.GameObjects.Image; label: Phaser.GameObjects.Text; tx: number; ty: number;
  typing: Phaser.Tweens.Tween | null; moves: Phaser.Tweens.Tween[] };

class Office extends Phaser.Scene {
  private rows: Record<string, Row> = {};
  private actors = new Map<string, Actor>();
  private podLabels = new Map<string, Phaser.GameObjects.Text>();
  private floor!: Phaser.GameObjects.Graphics;
  private desks!: Phaser.GameObjects.Graphics;
  private links!: Phaser.GameObjects.Graphics;
  private linksUntil = 0; // las líneas solo se repintan mientras hay personajes moviéndose
  private ready = false;
  private hovered: { a: Actor; p: Phaser.Input.Pointer } | null = null;

  constructor(private hud: HTMLElement, private sessionName: (sid: string) => string) { super('office'); }

  create() {
    // Personaje 16×16 en blanco: se tiñe según el rol (MAIN, hijo inferido, visitante).
    const g = this.make.graphics({}, false);
    g.fillStyle(0xffffff).fillRect(3, 0, 10, 8).fillRect(2, 8, 12, 8);
    g.fillStyle(0x000000).fillRect(5, 3, 2, 2).fillRect(9, 3, 2, 2);
    g.generateTexture('char', 16, 16);
    g.destroy();
    this.floor = this.add.graphics().setDepth(0);
    this.desks = this.add.graphics().setDepth(2); // por delante del personaje: tapa las piernas
    this.links = this.add.graphics().setDepth(4);
    this.scale.on('resize', () => this.relayout());
    this.input.on('wheel', (_p: unknown, _o: unknown, _dx: number, dy: number) => { this.cameras.main.scrollY += dy * 0.5; });
    this.ready = true;
    this.relayout();
  }

  setRows(rows: Record<string, Row>) {
    this.rows = rows;
    if (this.ready) this.relayout();
  }

  private relayout() {
    const L: Layout = layout(this.rows, this.scale.width);
    this.cameras.main.setBounds(0, 0, this.scale.width, Math.max(L.height, this.scale.height));
    this.floor.clear().fillStyle(0x1e293b);
    for (const p of L.pods) this.floor.fillRoundedRect(p.x, p.y, POD_W, p.h, 6);
    this.desks.clear();
    for (const s of L.seats.values()) {
      this.desks.fillStyle(0x7c5a3a).fillRect(s.x + 8, s.y + 40, 48, 16);
      this.desks.fillStyle(0x0f172a).fillRect(s.x + 40, s.y + 34, 12, 8); // pantalla
    }

    const seen = new Set<string>();
    for (const p of L.pods) {
      seen.add(p.session_id);
      let t = this.podLabels.get(p.session_id);
      if (!t) this.podLabels.set(p.session_id, (t = this.add.text(0, 0, '', { fontFamily: 'monospace', fontSize: '12px', color: '#94a3b8' }).setDepth(1)));
      t.setPosition(p.x + 12, p.y + 4).setText(`${this.sessionName(p.session_id).slice(0, 26)} · ${short(p.session_id)}`);
    }
    for (const [sid, t] of this.podLabels) if (!seen.has(sid)) { t.destroy(); this.podLabels.delete(sid); }

    for (const [k, a] of this.actors) if (!L.seats.has(k)) this.leave(k, a);
    for (const [k, s] of L.seats) {
      const r = this.rows[k];
      const x = s.x + SEAT / 2, y = s.y + 44;
      let a = this.actors.get(k);
      if (!a) {
        // Un hijo nuevo sale de la mesa de su padre y camina hasta la suya.
        const from = r.kind === 'agent' && r.parent ? this.actors.get(r.parent) : undefined;
        const body = this.add.image(from?.tx ?? x, from?.ty ?? y, 'char').setOrigin(0.5, 1).setScale(2).setDepth(1).setInteractive();
        const label = this.add.text(body.x, body.y - 34, '', { fontFamily: 'monospace', fontSize: '12px', fontStyle: 'bold',
          backgroundColor: '#0f172a', padding: { x: 3, y: 1 } }).setOrigin(0.5, 1).setDepth(3);
        a = { row: r, body, label, tx: body.x, ty: body.y, typing: null, moves: [] };
        const actor = a;
        body.on('pointerover', (p: Phaser.Input.Pointer) => this.showHud(actor, p));
        body.on('pointermove', (p: Phaser.Input.Pointer) => this.placeHud(p));
        body.on('pointerout', () => { this.hovered = null; this.hud.hidden = true; });
        this.actors.set(k, a);
      }
      this.paint(a, r);
      if (a.tx !== x || a.ty !== y) {
        a.moves.forEach((t) => t.stop());
        a.moves = [
          this.tweens.add({ targets: a.body, x, y, duration: MOVE_MS, ease: 'Sine.inOut' }),
          this.tweens.add({ targets: a.label, x, y: y - 34, duration: MOVE_MS, ease: 'Sine.inOut' }),
        ];
        a.tx = x; a.ty = y;
      }
    }
    this.linksUntil = this.time.now + MOVE_MS + 50;
  }

  private paint(a: Actor, r: Row) {
    a.row = r;
    a.body.setTint(r.kind === 'session' ? TINT.main : r.evidence === 'INFERRED' ? TINT.child : TINT.visitor).setAlpha(r.state === 'STALE' ? 0.35 : 1);
    const [text, color] = bubble(r);
    if (a.label.text !== text) a.label.setText(text).setColor(color);
    a.label.setVisible(text !== '');
    // Tecleando: aplastamiento vertical (no choca con el tween de posición).
    if (r.state === 'WORKING' && !a.typing) {
      a.typing = this.tweens.add({ targets: a.body, scaleY: 1.8, duration: 140, yoyo: true, repeat: -1, delay: Math.random() * 300 });
    }
    if (r.state !== 'WORKING' && a.typing) { a.typing.stop(); a.typing = null; a.body.setScale(2); }
    if (this.hovered?.a === a) this.showHud(a, this.hovered.p);
  }

  // Al terminar desaparece (desvanecido).
  private leave(k: string, a: Actor) {
    this.actors.delete(k);
    a.typing?.stop();
    a.moves.forEach((t) => t.stop());
    a.body.disableInteractive();
    if (this.hovered?.a === a) { this.hovered = null; this.hud.hidden = true; }
    this.tweens.add({ targets: [a.body, a.label], alpha: 0, duration: 400, onComplete: () => { a.body.destroy(); a.label.destroy(); } });
  }

  update() {
    if (this.time.now > this.linksUntil) return;
    // PARENT_CHILD solo es INFERRED (nunca OBSERVED): siempre línea discontinua. Los visitantes no tienen línea.
    const g = this.links.clear().lineStyle(2, 0xffffff, 0.4);
    for (const a of this.actors.values()) {
      const r = a.row;
      const p = r.kind === 'agent' && r.parent ? this.actors.get(r.parent) : undefined;
      if (p) dashed(g, p.body.x, p.body.y - 16, a.body.x, a.body.y - 16);
    }
  }

  private showHud(a: Actor, p: Phaser.Input.Pointer) {
    const r = a.row;
    const lines: [string, string][] = r.kind === 'session'
      ? [['Tipo', 'Sesión principal (MAIN)'], ['Proyecto', this.sessionName(r.session_id)], ['Sesión', short(r.session_id)]]
      : [['Tipo', r.agent_types.join(', ') || 'Agente'], ['Agente', short(r.agent_id)],
          ['Padre', r.evidence === 'INFERRED' ? 'Inferido (línea discontinua)' : 'Desconocido: visitante']];
    lines.push(['Estado', LABEL[r.state]], ['Herramienta', r.tool ?? '—'],
      ['Duración', r.first === null ? '—' : dur(Date.now() - r.first)], ['Eventos', String(r.events)], ['Herramientas usadas', String(r.tools)]);
    this.hud.replaceChildren(...lines.map(([k, v]) => {
      const d = document.createElement('div');
      const b = document.createElement('span');
      b.className = 'text-slate-400';
      b.textContent = `${k}: `;
      d.append(b, v);
      return d;
    }));
    this.hovered = { a, p };
    this.hud.hidden = false;
    this.placeHud(p);
  }

  private placeHud(p: Phaser.Input.Pointer) {
    const e = p.event as MouseEvent;
    this.hud.style.left = `${e.clientX + 14}px`;
    this.hud.style.top = `${e.clientY + 14}px`;
  }
}

function dashed(g: Phaser.GameObjects.Graphics, x1: number, y1: number, x2: number, y2: number, on = 6, off = 4) {
  const d = Math.hypot(x2 - x1, y2 - y1);
  if (!d) return;
  const ux = (x2 - x1) / d, uy = (y2 - y1) / d;
  g.beginPath();
  for (let s = 0; s < d; s += on + off) {
    const e = Math.min(s + on, d);
    g.moveTo(x1 + ux * s, y1 + uy * s);
    g.lineTo(x1 + ux * e, y1 + uy * e);
  }
  g.strokePath();
}

export function createOffice(parent: HTMLElement, hud: HTMLElement, sessionName: (sid: string) => string) {
  const scene = new Office(hud, sessionName);
  new Phaser.Game({
    type: Phaser.AUTO, parent, backgroundColor: '#0b1120', pixelArt: true, banner: false, audio: { noAudio: true },
    scale: { mode: Phaser.Scale.RESIZE, width: parent.clientWidth, height: parent.clientHeight },
    scene,
  });
  return scene;
}
