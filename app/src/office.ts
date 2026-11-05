// Fase 6: la oficina de un proyecto en Phaser 3. Zona de mesas, pasillo y tres salas (layout.ts). Los personajes
// caminan por el pasillo entre su mesa y la sala que toca según su estado. Todo el texto de la escena se pinta en canvas
// y el del HUD entra con textContent.
import Phaser from 'phaser';
import type { Row, State } from './types.ts';
import { office, route, BLOCK, CORRIDOR, ROOM_H, ROOM_W, ROOM_WALL, ROOMS, SEATS, WALL, type Room, type Target, type World } from './layout.ts';
import { CHAR, PALETTE, ROLES, SCALE, SKINS, HAIRS, SPRITES, STAND, charPalette, variant, type Role } from './art.ts';
import { ACCESSORIES, LIFT, accessory } from './art-accessories.ts';
import { dur, permissionText } from './permission.ts';
import { ICON_PALETTE, ICON_SPRITES, toolIcon } from './art-icons.ts';
import { SEATED, SEAT_SPRITES } from './art-seats.ts';

export const LABEL: Record<State, string> = {
  WORKING: 'Trabajando', PERMISSION: 'Esperando permiso', IDLE: 'Inactivo', ERROR: 'Error', ENDED: 'Terminado', STALE: 'Caducado',
};
const SPEED = 160; // px/s al caminar
const ROOM_NAME: Record<Room, string> = { cafe: 'Cafetería', meeting: 'Sala de reuniones', lounge: 'Descanso' };
const role = (r: Row): Role => (r.kind === 'session' ? 'main' : r.evidence === 'INFERRED' ? 'child' : 'visitor');

// Globo de texto de los estados que no son de herramienta; la herramienta va como icono (art-icons.ts).
function bubble(r: Row): [string, string] {
  if (r.state === 'PERMISSION') return [permissionText(r.since, Date.now()), '#fbbf24'];
  if (r.state === 'ERROR') return ['!', '#ef4444'];
  if (r.state === 'IDLE') return ['zzz', '#94a3b8'];
  if (r.state === 'STALE') return ['…', '#64748b'];
  return ['', ''];
}

const short = (id: string) => id.slice(0, 8);

// look: texturas del personaje (rol + variante). hat: accesorio del tipo de agente (art-accessories.ts), oculto si no lleva.
// icon: bocadillo con la herramienta (art-icons.ts). at: adónde va o dónde está. pose: sentado, tecleando, de pie o caminando.
// pulse: latido del globo mientras espera permiso.
type Actor = { row: Row; body: Phaser.GameObjects.Sprite; hat: Phaser.GameObjects.Image; label: Phaser.GameObjects.Text;
  icon: Phaser.GameObjects.Image; look: string; pose: string;
  at: Target; walk: Phaser.Tweens.TweenChain | null; pulse: Phaser.Tweens.Tween | null };

class Office extends Phaser.Scene {
  private rows: Record<string, Row> = {};
  private actors = new Map<string, Actor>();
  private floor!: Phaser.GameObjects.TileSprite;
  private walls!: Phaser.GameObjects.Graphics;
  private furniture!: Record<'chair' | 'desk' | 'plant' | 'bookshelf', Phaser.GameObjects.Blitter>;
  private rooms!: Record<Room, Phaser.GameObjects.Container>;
  // Muebles de sala que tapan a quien está detrás (mesa de reuniones, sillas de espaldas): fuera del contenedor, con profundidad por y.
  private over: [Phaser.GameObjects.Image, Room, number, number][] = [];
  private door: Target = { x: 0, y: 0, zone: 'door', seated: false, exit: [] };
  private ready = false;
  private seatOf = new Map<string, number>(); // puesto fijo de cada uno (layout.ts)
  private started = false; // en la primera carga cada uno aparece en su sitio; después entran por la puerta
  private hovered: { a: Actor; p: Phaser.Input.Pointer } | null = null;
  private focus: string | null = null; // sesión resaltada al pasar el ratón; null = nadie atenuado

  constructor(private hud: HTMLElement, private sessionName: (sid: string) => string) { super('office'); }

  create() {
    // Texturas de art.ts, generadas ya a escala ×SCALE (los blitters no admiten escala).
    // La paleta usa claves mnemotécnicas (Phaser admite cualquier carácter), aunque su tipo solo declare 0-F.
    const gen = (k: string, data: string[], palette: Record<string, string>) =>
      this.textures.generate(k, { data, palette: palette as unknown as Phaser.Types.Create.Palette, pixelWidth: SCALE });
    for (const [k, data] of Object.entries(SPRITES)) gen(k, data, PALETTE);
    for (const [k, data] of Object.entries(ACCESSORIES)) gen(`acc-${k}`, data, PALETTE);
    for (const [k, data] of Object.entries(ICON_SPRITES)) gen(`icon-${k}`, data, ICON_PALETTE);
    for (const [k, data] of Object.entries(SEAT_SPRITES)) gen(k, data, PALETTE);
    // Por rol × piel × pelo: sentado (0, 1 = tecleando), de pie (s) y dos pasos (w1, w2).
    for (const r of Object.keys(ROLES) as Role[]) for (let s = 0; s < SKINS.length; s++) for (let h = 0; h < HAIRS.length; h++) {
      const look = `char-${r}-${s}${h}`, pal = charPalette(r, `${s}${h}`);
      CHAR.forEach((data, f) => gen(`${look}-${f}`, data, pal));
      STAND.forEach((data, f) => gen(`${look}-${f ? `w${f}` : 's'}`, data, pal));
      for (const [p, data] of Object.entries(SEATED)) gen(`${look}-${p}`, data, pal); // sentado en sala: front, back y side
      this.anims.create({ key: look, frames: [{ key: `${look}-0` }, { key: `${look}-1` }], frameRate: 5, repeat: -1 });
      this.anims.create({ key: `${look}-walk`, frames: [{ key: `${look}-w1` }, { key: `${look}-w2` }], frameRate: 6, repeat: -1 });
    }
    this.floor = this.add.tileSprite(0, WALL, 1, 1, 'floor').setOrigin(0).setDepth(0);
    this.walls = this.add.graphics().setDepth(0);
    // La silla va detrás del personaje y la mesa delante (tapa las piernas).
    const blit = (k: string, depth: number) => this.add.blitter(0, 0, k).setDepth(depth);
    this.furniture = { bookshelf: blit('bookshelf', 0.6), chair: blit('chair', 0.5), desk: blit('desk', 2), plant: blit('plant', 0.6) };
    this.rooms = Object.fromEntries(ROOMS.map((r) => [r, this.room(r)])) as Record<Room, Phaser.GameObjects.Container>;
    this.scale.on('resize', () => this.relayout());
    this.input.on('wheel', (_p: unknown, _o: unknown, dx: number, dy: number) => {
      this.cameras.main.scrollX += dx * 0.5;
      this.cameras.main.scrollY += dy * 0.5;
    });
    // Las filas solo llegan con cada delta (~15 s): el contador de espera se refresca aquí, solo en los globos de permiso.
    this.time.addEvent({ delay: 1000, loop: true, callback: () => {
      for (const a of this.actors.values()) {
        if (a.row.state !== 'PERMISSION') continue;
        const [text] = bubble(a.row);
        if (a.label.text !== text) a.label.setText(text);
      }
    } });
    this.ready = true;
    this.relayout();
  }

  // Una sala: suelo, pared, puerta a la izquierda (hacia el pasillo), nombre y muebles. Solo cambia de posición.
  private room(r: Room) {
    const c = this.add.container(0, 0).setDepth(0.6);
    const floor = { cafe: 'tile', meeting: 'carpet', lounge: 'floor' }[r];
    c.add(this.add.tileSprite(0, ROOM_WALL, ROOM_W, ROOM_H - ROOM_WALL, floor).setOrigin(0));
    const g = this.add.graphics();
    g.fillStyle(0x2a3f5f).fillRect(0, 0, ROOM_W, ROOM_WALL).fillStyle(0x1a2b44).fillRect(0, ROOM_WALL - 4, ROOM_W, 4);
    g.fillStyle(0x111827).fillRect(0, 0, ROOM_W, 4).fillRect(ROOM_W - 4, 0, 4, ROOM_H).fillRect(0, ROOM_H - 4, ROOM_W, 4)
      .fillRect(0, 0, 4, ROOM_H - 60).fillRect(0, ROOM_H - 12, 4, 12); // hueco de la puerta en la pared izquierda
    c.add([g, this.add.text(10, 8, ROOM_NAME[r], { fontFamily: 'monospace', fontSize: '12px', color: '#cbd5e1' })]);
    const m = BLOCK.meeting!, l = BLOCK.lounge!;
    const items: [string, number, number][] = {
      cafe: [['vending', 16, 24], ['cooler', 56, 34], ['clock', 92, 12], ['counter', 120, 34], ['fridge', 204, 24], ['plant', 264, 36]],
      meeting: [['whiteboard', 150, 18], ['plant', 12, 36], ['plant', 268, 36]],
      lounge: [['picture', 124, 16], ['bookshelf', 16, 26], ['bookshelf', 240, 26], ['sofa', l[0], l[1]], ['plant', 80, 36], ['plant', 196, 36]],
    }[r] as [string, number, number][];
    c.add(items.map(([k, x, y]) => this.add.image(x, y, k).setOrigin(0)));
    // Sillas: tras la mesa y de perfil, detrás del personaje; las de espaldas, delante (tapan el torso).
    const img = (k: string, x: number, y: number) => this.add.image(x, y, k).setOrigin(0);
    for (const s of SEATS[r]) {
      if (s.seat === 'behind') c.add(img('chair', s.x - 20, s.y - 24));
      else if (s.seat === 'right') c.add(img('chair-side', s.x - 14, s.y - 20));
      else if (s.seat === 'left') c.add(img('chair-side', s.x - 6, s.y - 20).setFlipX(true));
      else if (s.seat === 'back') this.over.push([img('chair', 0, 0), r, s.x - 20, s.y - 4]);
    }
    if (r === 'meeting') this.over.push([img('table', 0, 0), r, m[0], m[1]]);
    return c;
  }

  // reset: al cambiar de proyecto la oficina se vacía y cada uno aparece en su sitio, sin desfile por la puerta.
  setRows(rows: Record<string, Row>, reset = false) {
    this.rows = rows;
    if (reset) {
      for (const a of this.actors.values()) { a.walk?.stop(); a.pulse?.stop(); a.body.destroy(); a.hat.destroy(); a.label.destroy(); a.icon.destroy(); }
      this.actors.clear();
      this.hovered = null;
      this.hud.hidden = true;
      this.focus = null;
      this.started = false;
      this.seatOf.clear();
      if (this.ready) this.cameras.main.setScroll(0, 0);
    }
    if (this.ready) this.relayout();
  }

  private relayout() {
    const W: World = office(this.rows, this.scale.width, this.seatOf);
    this.seatOf = W.seatOf;
    const w = Math.max(W.width, this.scale.width), h = Math.max(W.height, this.scale.height), areaW = W.workW + CORRIDOR;
    this.cameras.main.setBounds(0, 0, w, h);
    this.floor.setSize(areaW, h - WALL);
    // Pared superior de la zona de mesas, con la puerta de entrada sobre el pasillo.
    this.walls.clear().fillStyle(0x2a3f5f).fillRect(0, 0, areaW, WALL).fillStyle(0x1a2b44).fillRect(0, WALL - 4, areaW, 4)
      .fillStyle(0x111827).fillRect(W.corridorX - 20, 8, 40, WALL - 8).fillStyle(0x7c5a3a).fillRect(W.corridorX - 16, 12, 32, WALL - 12);
    this.door = { x: W.door.x, y: W.door.y, zone: 'door', seated: false, exit: [W.door] };
    for (const [r, c] of Object.entries(this.rooms)) c.setPosition(W.rooms[r as Room].x, W.rooms[r as Room].y);
    for (const [img, r, x, y] of this.over) {
      img.setPosition(W.rooms[r].x + x, W.rooms[r].y + y).setDepth(1 + (img.y + img.height) / 1e5); // como follow(), por el borde de abajo
    }

    Object.values(this.furniture).forEach((b) => b.clear());
    // Pared: dos estanterías y una planta, repetido.
    for (let x = 16, i = 0; x + 48 <= W.corridorX - 24; x += 64, i++) {
      if (i % 3 === 2) this.furniture.plant.create(x + 12, WALL - 24);
      else this.furniture.bookshelf.create(x, WALL - 34);
    }
    for (const s of W.desks) {
      this.furniture.chair.create(s.x + 12, s.y + 20);
      this.furniture.desk.create(s.x + 8, s.y + 34);
    }

    for (const [k, a] of this.actors) if (!W.targets.has(k)) this.leave(k, a);
    for (const [k, t] of W.targets) {
      const r = this.rows[k];
      let a = this.actors.get(k);
      if (!a) {
        // Al cargar, cada uno en su sitio. Después, un hijo sale de donde está su padre y el resto entra por la puerta.
        const parent = r.kind === 'agent' && r.parent ? this.actors.get(r.parent) : undefined;
        const from = !this.started ? t : parent ? { ...parent.at, x: parent.body.x, y: parent.body.y } : this.door;
        const body = this.add.sprite(from.x, from.y, `char-${role(r)}-00-s`).setOrigin(0.5, 1).setInteractive(); // de pie: la caja más alta para el ratón
        const label = this.add.text(body.x, body.y, '', { fontFamily: 'monospace', fontSize: '12px', fontStyle: 'bold',
          backgroundColor: '#0f172a', padding: { x: 3, y: 1 } }).setOrigin(0.5, 1).setDepth(3);
        const hat = this.add.image(body.x, body.y, 'acc-crown').setOrigin(0.5, 0);
        const icon = this.add.image(body.x, body.y, 'icon-other').setOrigin(0.5, 1).setDepth(3).setVisible(false);
        a = { row: r, body, hat, label, icon, look: '', pose: '', at: from, walk: null, pulse: null };
        const actor = a;
        body.on('animationupdate', () => this.follow(actor)); // el accesorio baja con la cabeza al teclear
        body.on('pointerover', (p: Phaser.Input.Pointer) => { this.showHud(actor, p); this.highlight(actor.row.session_id); });
        body.on('pointermove', (p: Phaser.Input.Pointer) => this.placeHud(p));
        body.on('pointerout', () => { this.hovered = null; this.hud.hidden = true; this.highlight(null); });
        this.actors.set(k, a);
      }
      this.paint(a, r);
      if (a.at.x !== t.x || a.at.y !== t.y || a.at.zone !== t.zone) this.walkTo(a, t);
      else { a.at = t; this.pose(a); }
    }
    if (W.targets.size) this.started = true;
  }

  // Camina por la ruta de layout.ts (pasillo y puertas) a velocidad constante.
  private walkTo(a: Actor, t: Target, done?: () => void) {
    a.walk?.stop();
    const steps: Phaser.Types.Tweens.TweenBuilderConfig[] = [];
    let x = a.body.x, y = a.body.y;
    for (const p of route(a.at, t)) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < 1) continue;
      steps.push({ targets: a.body, x: p.x, y: p.y, duration: (d / SPEED) * 1000, onUpdate: () => this.follow(a) });
      x = p.x; y = p.y;
    }
    a.at = t;
    const end = () => { a.walk = null; this.pose(a); done?.(); };
    if (!steps.length) { a.body.setPosition(t.x, t.y); end(); return; }
    a.walk = this.tweens.chain({ tweens: steps, onComplete: end });
    this.pose(a);
  }

  private pose(a: Actor) {
    // Sentado en sala con mesa delante (behind) o en su mesa de trabajo: igual; si no, la pose de sala (art-seats.ts).
    const seat = a.at.seat ?? 'behind';
    const p = a.walk ? 'walk' : !a.at.seated ? 'stand' : seat !== 'behind' ? seat : a.row.state === 'WORKING' ? 'type' : 'sit';
    if (p !== a.pose) {
      a.pose = p;
      a.body.setFlipX(p === 'left');
      if (p === 'walk') a.body.play(`${a.look}-walk`);
      else if (p === 'type') a.body.play({ key: a.look, delay: Math.random() * 300 });
      else a.body.stop().setTexture(`${a.look}-${p === 'sit' ? 0 : p === 'stand' ? 's' : p === 'left' || p === 'right' ? 'side' : p}`);
    }
    this.follow(a);
  }

  // El globo sigue al personaje; los de más abajo se pintan delante.
  private follow(a: Actor) {
    a.body.setDepth(1 + a.body.y / 1e5);
    // Fila LIFT del accesorio = fila 0 de la cabeza; en el fotograma 1 de tecleo la cabeza baja 1 px. De perfil se voltea con el cuerpo.
    const down = a.pose === 'type' && a.body.frame.texture.key.endsWith('-1') ? SCALE : 0;
    a.hat.setPosition(a.body.x, a.body.y - a.body.height + down - LIFT * SCALE).setDepth(a.body.depth + 1e-6).setFlipX(a.body.flipX);
    a.label.setPosition(a.body.x, a.body.y - a.body.height - 2); // 2 px sobre la cabeza: 38 sentado, 44 de pie
    a.icon.setPosition(a.label.x, a.label.y);
  }

  private paint(a: Actor, r: Row) {
    a.row = r;
    const acc = accessory(r);
    if (acc) a.hat.setTexture(`acc-${acc}`);
    a.hat.setVisible(acc !== null);
    this.dim(a);
    const [text, color] = bubble(r);
    if (a.label.text !== text) a.label.setText(text).setColor(color);
    a.label.setVisible(text !== '');
    // Esperando permiso (el único estado en que el usuario tiene que actuar): el globo late. Solo toca alpha, no la posición de follow().
    if (r.state === 'PERMISSION' && !a.pulse) {
      a.pulse = this.tweens.add({ targets: a.label, alpha: 0.35, duration: 600, ease: 'Sine.inOut', yoyo: true, repeat: -1 });
    }
    if (r.state !== 'PERMISSION' && a.pulse) { a.pulse.stop(); a.pulse = null; this.dim(a); }
    const icon = text ? null : toolIcon(r.tool);
    if (icon) a.icon.setTexture(`icon-${icon}`);
    a.icon.setVisible(icon !== null);
    // El rol puede cambiar (visitante → hijo inferido); la variante de piel y pelo sale de la clave y no cambia.
    const look = `char-${role(r)}-${variant(r.kind === 'session' ? r.session_id : r.agent_id)}`;
    if (look !== a.look) { a.look = look; a.pose = ''; }
    if (this.hovered?.a === a) this.showHud(a, this.hovered.p);
  }

  // Resalta la sesión señalada (MAIN y sus agentes) atenuando al resto; null lo restaura todo.
  private highlight(sid: string | null) {
    this.focus = sid;
    for (const a of this.actors.values()) this.dim(a);
  }

  // Opacidad del estado (caducado = 0.5) por la del resaltado; el globo solo se atenúa por el resaltado.
  private dim(a: Actor) {
    const f = this.focus !== null && a.row.session_id !== this.focus ? 0.25 : 1;
    a.body.setAlpha((a.row.state === 'STALE' ? 0.5 : 1) * f);
    a.hat.setAlpha(a.body.alpha);
    a.icon.setAlpha(a.body.alpha);
    a.label.setAlpha(f);
  }

  // Al terminar sale por la puerta y desaparece.
  private leave(k: string, a: Actor) {
    this.actors.delete(k);
    a.body.disableInteractive();
    a.pulse?.stop();
    a.label.setVisible(false);
    a.icon.setVisible(false);
    if (this.hovered?.a === a) { this.hovered = null; this.hud.hidden = true; this.highlight(null); } // ya no llegará su pointerout
    this.walkTo(a, this.door, () => this.tweens.add({ targets: [a.body, a.hat], alpha: 0, duration: 300, onComplete: () => { a.body.destroy(); a.hat.destroy(); a.label.destroy(); a.icon.destroy(); } }));
  }

  private showHud(a: Actor, p: Phaser.Input.Pointer) {
    const r = a.row;
    const lines: [string, string][] = r.kind === 'session'
      ? [['Tipo', 'Sesión principal (MAIN)'], ['Proyecto', this.sessionName(r.session_id)], ['Sesión', short(r.session_id)]]
      : [['Tipo', r.agent_types.join(', ') || 'Agente'], ['Agente', short(r.agent_id)],
          ['Padre', r.evidence === 'INFERRED' ? 'Inferido' : 'Desconocido: visitante']];
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

export function createOffice(parent: HTMLElement, hud: HTMLElement, sessionName: (sid: string) => string) {
  const scene = new Office(hud, sessionName);
  new Phaser.Game({
    type: Phaser.AUTO, parent, backgroundColor: '#0b1120', pixelArt: true, banner: false, audio: { noAudio: true },
    scale: { mode: Phaser.Scale.RESIZE, width: parent.clientWidth, height: parent.clientHeight },
    scene,
  });
  return scene;
}
