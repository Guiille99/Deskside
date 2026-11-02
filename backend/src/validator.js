// Validador estricto del esquema Nuevo. Referencia normativa: pruebas/audit-log.ps1 -Schema Nuevo
// y la sección 2 del protocolo (rev3). No normaliza: un valor que no encaja rechaza la línea.
// Nunca devuelve ni registra contenido de la línea: solo { ok: true, event } o { ok: false, code }.

export const FORBIDDEN = ['prompt', 'last_assistant_message', 'tool_input', 'tool_response', 'message', 'title',
  'transcript_path', 'agent_transcript_path', 'scratchpad_dir', 'error_details', 'cwd', 'session_title',
  'permission_suggestions', 'mcp_server', 'background_tasks', 'session_crons', 'custom_instructions', 'compact_summary'];

export const COMMON = ['timestamp', 'event', 'session_id', 'agent_id', 'agent_type', 'permission_mode'];

export const EXTRA = {
  SessionStart: ['source', 'model'], SessionEnd: ['reason'], UserPromptSubmit: [],
  Stop: ['stop_hook_active', 'background_tasks_count', 'session_crons_count'],
  StopFailure: ['error'], Notification: ['notification_type'], PermissionRequest: ['tool_name'],
  PreToolUse: ['tool_name', 'tool_use_id'], PostToolUse: ['tool_name', 'tool_use_id', 'duration_ms'],
  PostToolUseFailure: ['tool_name', 'tool_use_id', 'is_interrupt'],
  SubagentStart: [], SubagentStop: ['stop_hook_active'],
};

// Todos los campos que pueden llegar a guardarse, en orden estable (columnas de la tabla event).
export const ALL_FIELDS = [...new Set([...COMMON, ...Object.values(EXTRA).flat()])];

// Códigos fijos de rechazo. Los dos últimos los emite el ingestor (nivel de bytes).
export const REJECT_CODES = ['line_break', 'forbidden_field', 'invalid_json', 'case_duplicate_key', 'not_object',
  'duplicate_key', 'missing_required', 'invalid_event', 'field_not_allowed', 'null_value', 'invalid_value',
  'invalid_utf8', 'line_too_long'];

const ENUMS = {
  event: Object.keys(EXTRA),
  source: ['startup', 'resume', 'clear', 'compact', 'fork', 'unknown'],
  reason: ['clear', 'resume', 'logout', 'prompt_input_exit', 'other', 'unknown'],
  permission_mode: ['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'unknown'],
  notification_type: ['permission_prompt', 'idle_prompt', 'auth_success', 'elicitation_dialog', 'elicitation_url_dialog',
    'elicitation_complete', 'elicitation_response', 'agent_needs_input', 'agent_completed', 'quota_auto_resume_fired',
    'quota_auto_resume_stale', 'quota_auto_resume_disabled', 'plugin_notification', 'unknown'],
  error: ['rate_limit', 'overloaded', 'authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'billing_error',
    'invalid_request', 'model_not_found', 'server_error', 'max_output_tokens', 'cloud_credential_error', 'unknown'],
  agent_type: ['general-purpose', 'Explore', 'Plan', 'claude-code-guide', 'statusline-setup', 'custom', 'plugin', 'none'],
  tool_name: ['Agent', 'AskUserQuestion', 'Bash', 'PowerShell', 'Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep',
    'WebFetch', 'WebSearch', 'TodoWrite', 'Skill', 'ToolSearch', 'EnterPlanMode', 'ExitPlanMode', 'Monitor', 'TaskStop', 'mcp', 'other'],
};

// Sin flag m, `$` en JavaScript solo casa al final absoluto de la entrada, como `\z` en .NET
// (el `$` de .NET también casaría antes de un \n final). Lo comprueban los tests con "\n", "\r" y U+2028.
export const RE = {
  ts: /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{7}\+00:00$/,
  sid: /^[A-Za-z0-9-]{8,64}$/,
  id: /^[A-Za-z0-9_-]{1,64}$/,
  model: /^(claude-[a-z0-9-]{1,40}(\[1m\])?|other)$/,
};

const RULES = {
  timestamp: 'ts', event: 'enum', session_id: 'sid', agent_id: 'id', agent_type: 'enum', permission_mode: 'enum',
  source: 'enum', model: 'model', reason: 'enum', stop_hook_active: 'bool', background_tasks_count: 1000,
  session_crons_count: 1000, error: 'enum', notification_type: 'enum', tool_name: 'enum', tool_use_id: 'id',
  duration_ms: 86400000, is_interrupt: 'bool',
};

// Mismo patrón que $forbiddenRx del auditor (-match no distingue mayúsculas); se aplica al texto crudo.
const FORBIDDEN_TEXT = new RegExp('"(' + FORBIDDEN.join('|') + ')"\\s*:', 'i');

// Equivale a String.Trim().Length -eq 0 de .NET (Char.IsWhiteSpace), que no coincide con trim() de JavaScript.
const NET_BLANK = /^[\u{9}\u{a}\u{b}\u{c}\u{d}\u{20}\u{85}\u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}]*$/u;
export const isBlankLine = (s) => NET_BLANK.test(s);

const reject = (code) => ({ ok: false, code });

export function validateLine(line) {
  if (typeof line !== 'string' || /[\r\n]/.test(line)) return reject('line_break');
  if (FORBIDDEN_TEXT.test(line)) return reject('forbidden_field');
  const members = parseTopLevel(line);
  if (members === INVALID) return reject('invalid_json');
  if (members === NOT_OBJECT) return reject('not_object');

  const keys = members.map(([k]) => k);
  if (new Set(keys).size !== keys.length) return reject('duplicate_key');
  if (new Set(keys.map((k) => k.toLowerCase())).size !== keys.length) return reject('case_duplicate_key');
  if (keys.some((k) => FORBIDDEN.includes(k.toLowerCase()))) return reject('forbidden_field');
  if (!['timestamp', 'event', 'session_id'].every((k) => keys.includes(k))) return reject('missing_required');

  const evNode = members.find(([k]) => k === 'event')[1];
  if (evNode.t !== 'str' || !ENUMS.event.includes(evNode.v)) return reject('invalid_event');
  const allowed = [...COMMON, ...EXTRA[evNode.v]];

  const event = {};
  for (const [k, node] of members) {
    if (!allowed.includes(k)) return reject('field_not_allowed');
    if (node.t === 'null') return reject('null_value');
    const value = checkValue(RULES[k], k, node);
    if (value === undefined) return reject('invalid_value');
    event[k] = value;
  }
  return { ok: true, event };
}

function checkValue(rule, key, node) {
  if (typeof rule === 'number') {
    // Solo enteros JSON reales: el token no lleva parte decimal ni exponente (1.0 y 1e3 se rechazan).
    if (node.t !== 'num' || !node.int) return undefined;
    const n = BigInt(node.raw);
    return n >= 0n && n <= BigInt(rule) ? Number(n) : undefined;
  }
  if (rule === 'bool') return node.t === 'bool' ? node.v : undefined;
  if (node.t !== 'str') return undefined;
  const v = node.v;
  if (rule === 'enum') return ENUMS[key].includes(v) ? v : undefined;
  if (rule === 'ts') return RE.ts.test(v) && isRealDate(v) ? v : undefined;
  return RE[rule].test(v) ? v : undefined;
}

// Lo que DateTimeOffset.ParseExact(v, 'o') acepta una vez superada la regex: año 1..9999 y fecha/hora reales.
function isRealDate(v) {
  const [y, mo, d, h, mi, s] = [v.slice(0, 4), v.slice(5, 7), v.slice(8, 10), v.slice(11, 13), v.slice(14, 16), v.slice(17, 19)].map(Number);
  if (y < 1 || mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return d >= 1 && d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
}

// Parser JSON estricto (RFC 8259). JSON.parse no sirve: pierde claves duplicadas y la forma del número.
// Devuelve los miembros del objeto raíz como [clave, nodo]; los valores anidados solo se comprueban.
const INVALID = Symbol('invalid');
const NOT_OBJECT = Symbol('not_object');
const MAX_DEPTH = 100;
const NUMBER = /-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;

function parseTopLevel(s) {
  let i = 0;
  const fail = () => { throw INVALID; };
  const ws = () => { while (s[i] === ' ' || s[i] === '\t') i++; };
  const expect = (c) => { if (s[i] !== c) fail(); i++; };

  function str() {
    expect('"');
    let out = '';
    for (;;) {
      const c = s[i++];
      if (c === undefined || c < ' ') fail();
      if (c === '"') return out;
      if (c !== '\\') { out += c; continue; }
      const e = s[i++];
      if (e === 'u') {
        const hex = s.slice(i, i + 4);
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) fail();
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
      } else {
        const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (!(e in map)) fail();
        out += map[e];
      }
    }
  }

  function value(depth) {
    if (depth > MAX_DEPTH) fail();
    ws();
    const c = s[i];
    if (c === '"') return { t: 'str', v: str() };
    if (c === '{') { object(depth); return { t: 'obj' }; }
    if (c === '[') {
      i++; ws();
      if (s[i] === ']') { i++; return { t: 'arr' }; }
      for (;;) { value(depth + 1); ws(); if (s[i] === ',') { i++; continue; } expect(']'); return { t: 'arr' }; }
    }
    for (const [lit, node] of [['true', { t: 'bool', v: true }], ['false', { t: 'bool', v: false }], ['null', { t: 'null' }]]) {
      if (s.startsWith(lit, i)) { i += lit.length; return node; }
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(s);
    if (!m) fail();
    i += m[0].length;
    return { t: 'num', raw: m[0], int: m[2] === undefined && m[3] === undefined };
  }

  function object(depth) {
    expect('{');
    const members = [];
    ws();
    if (s[i] === '}') { i++; return members; }
    for (;;) {
      ws();
      const k = str();
      ws(); expect(':');
      members.push([k, value(depth + 1)]);
      ws();
      if (s[i] === ',') { i++; continue; }
      expect('}');
      return members;
    }
  }

  try {
    ws();
    const isObject = s[i] === '{';
    const members = isObject ? object(1) : (value(1), null);
    ws();
    if (i !== s.length) fail();
    return isObject ? members : NOT_OBJECT;
  } catch (e) {
    if (e === INVALID) return INVALID;
    throw e;
  }
}
