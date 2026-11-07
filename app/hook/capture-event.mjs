// Hook de Claude Code para macOS y Linux. Equivale a capture-event.ps1, que solo se usa en Windows.
// Lo ejecuta el binario de la aplicación con ELECTRON_RUN_AS_NODE=1, por lo que no requiere Node instalado.
// Se instala en <appData>/Deskside/hook/; la política de proyectos está en la carpeta superior.
import { readFileSync, writeFileSync, linkSync, unlinkSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

// Lista blanca de campos y valores. Se mantiene en sincronía con capture-event.ps1, backend/tools/audit-log.ps1 y backend/src/validator.js.
const EXTRA = {
  SessionStart: ['source', 'model'], SessionEnd: ['reason'], UserPromptSubmit: [],
  Stop: ['stop_hook_active', 'background_tasks_count', 'session_crons_count'],
  StopFailure: ['error'], Notification: ['notification_type'], PermissionRequest: ['tool_name'],
  PreToolUse: ['tool_name', 'tool_use_id'], PostToolUse: ['tool_name', 'tool_use_id', 'duration_ms'],
  PostToolUseFailure: ['tool_name', 'tool_use_id', 'is_interrupt'],
  SubagentStart: [], SubagentStop: ['stop_hook_active'],
};
const ENUMS = {
  source: ['startup', 'resume', 'clear', 'compact', 'fork'],
  reason: ['clear', 'resume', 'logout', 'prompt_input_exit', 'other'],
  permission_mode: ['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'],
  notification_type: ['permission_prompt', 'idle_prompt', 'auth_success', 'elicitation_dialog', 'elicitation_url_dialog',
    'elicitation_complete', 'elicitation_response', 'agent_needs_input', 'agent_completed', 'quota_auto_resume_fired',
    'quota_auto_resume_stale', 'quota_auto_resume_disabled', 'plugin_notification'],
  error: ['rate_limit', 'overloaded', 'authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'billing_error',
    'invalid_request', 'model_not_found', 'server_error', 'max_output_tokens', 'cloud_credential_error'],
};
const TOOLS = ['Agent', 'AskUserQuestion', 'Bash', 'PowerShell', 'Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'TodoWrite', 'Skill', 'ToolSearch', 'EnterPlanMode', 'ExitPlanMode', 'Monitor', 'TaskStop'];
const AGENTS = ['general-purpose', 'Explore', 'Plan', 'claude-code-guide', 'statusline-setup'];

const isStr = (v) => typeof v === 'string';
const getEnum = (v, name) => (isStr(v) && ENUMS[name].includes(v) ? v : 'unknown');
const testId = (v, re) => isStr(v) && re.test(v); // sin el indicador m, $ solo casa al final absoluto de la cadena
const count = (v) => (Array.isArray(v) && v.length <= 1000 ? v.length : null);
// Crea el archivo solo si no existe (temporal + link atómico). Si otro proceso se adelanta, no hace nada.
function createOnce(path, bytes) {
  if (existsSync(path)) return;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, bytes, { mode: 0o600 });
  try { linkSync(tmp, path); } catch (e) { if (e.code !== 'EEXIST') throw e; } finally { unlinkSync(tmp); }
}

function main() {
  const data = JSON.parse(readFileSync(0, 'utf8'));
  const ev = data?.hook_event_name;
  // Se ignoran los eventos no soportados o sin session_id válido.
  if (!(isStr(ev) && Object.hasOwn(EXTRA, ev) && testId(data.session_id, /^[A-Za-z0-9-]{8,64}$/))) return;

  // Identidad del proyecto: HMAC-SHA256 (clave local, ruta canónica) truncado a 16 bytes. La ruta nunca se almacena.
  const projectDir = process.env.CLAUDE_PROJECT_DIR || data.cwd;
  if (!isStr(projectDir) || projectDir === '') return;
  // Limitación: no se resuelven enlaces simbólicos, así que rutas distintas al mismo proyecto generan project_id distintos.
  const fullDir = resolve(projectDir).replace(/[\\/]+$/, '');
  // Windows y macOS (por defecto) no distinguen mayúsculas y minúsculas en las rutas; Linux sí.
  const canonical = process.platform === 'linux' ? fullDir : fullDir.toLowerCase();
  const policyDir = dirname(import.meta.dirname);
  // Solo el usuario: los nombres de carpeta y la actividad no deben verlos otros usuarios del equipo.
  for (const d of ['enabled', 'excluded', 'pending']) mkdirSync(join(policyDir, d), { recursive: true, mode: 0o700 });
  const keyPath = join(policyDir, 'install.key');
  createOnce(keyPath, randomBytes(32));
  const projectId = createHmac('sha256', readFileSync(keyPath)).update(canonical, 'utf8').digest('hex').slice(0, 32);

  // Registro por consentimiento: «excluido» prevalece sobre «activado». Sin política se crea una solicitud pendiente (solo el nombre de la carpeta) y no se registra nada.
  if (existsSync(join(policyDir, 'excluded', `${projectId}.json`))) return;
  if (!existsSync(join(policyDir, 'enabled', `${projectId}.json`))) {
    createOnce(join(policyDir, 'pending', `${projectId}.json`), JSON.stringify({ name: basename(fullDir) }));
    return;
  }

  // Formato de marca de tiempo que exige el validador (7 decimales y desfase +00:00), igual que el hook de Windows.
  const event = { timestamp: new Date().toISOString().replace(/Z$/, '0000+00:00'), event: ev, session_id: data.session_id, project_id: projectId };
  if (testId(data.agent_id, /^[A-Za-z0-9_-]{1,64}$/)) event.agent_id = data.agent_id;
  const at = data.agent_type;
  event.agent_type = !isStr(at) || at === '' ? 'none' : at.includes(':') ? 'plugin' : AGENTS.includes(at) ? at : 'custom';
  if (data.permission_mode != null) event.permission_mode = getEnum(data.permission_mode, 'permission_mode');

  for (const f of EXTRA[ev]) {
    const v = data[f];
    switch (f) {
      case 'source': case 'reason': case 'error': case 'notification_type': if (v != null) event[f] = getEnum(v, f); break;
      case 'model': if (v != null) event.model = testId(v, /^claude-[a-z0-9-]{1,40}(\[1m\])?$/) ? v : 'other'; break;
      case 'tool_name':
        if (isStr(v) && v !== '') event.tool_name = v.startsWith('mcp__') ? 'mcp' : TOOLS.includes(v) ? v : 'other';
        break;
      case 'tool_use_id': if (testId(v, /^[A-Za-z0-9_-]{1,64}$/)) event.tool_use_id = v; break;
      case 'duration_ms': if (Number.isInteger(v) && v >= 0 && v <= 86400000) event.duration_ms = v; break;
      case 'stop_hook_active': case 'is_interrupt': if (typeof v === 'boolean') event[f] = v; break;
      case 'background_tasks_count': { const c = count(data.background_tasks); if (c !== null) event[f] = c; break; }
      case 'session_crons_count': { const c = count(data.session_crons); if (c !== null) event[f] = c; break; }
    }
  }

  // Una escritura en modo append por línea evita mezclar líneas entre procesos en discos locales.
  // Limitación: en sistemas de archivos de red no está garantizado y sería necesario un bloqueo explícito.
  appendFileSync(join(policyDir, 'hooks-events.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 });
}

try { main(); } catch {
  // Mensaje fijo: no se propaga la excepción original para no exponer contenido.
  process.stderr.write('capture-event: error al registrar el evento\n');
  process.exitCode = 1;
}
