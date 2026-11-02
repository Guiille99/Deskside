// Casos sintéticos del validador. code: null = la línea es válida; si no, código fijo de rechazo esperado.
// Los usan validator.test.js (códigos) y parity.test.js (aceptar/rechazar frente a audit-log.ps1).
// Ningún dato procede de Claude Code: identificadores y marcas son inventados.

export const MARK = 'ZZSECRETO7Q';

const TS = '2026-10-31T10:00:00.0000000+00:00';
const T = `"timestamp":"${TS}"`;
const S = '"session_id":"fixture-0001"';
const L = (ev, extra = '') => `{${T},"event":"${ev}",${S}${extra}}`;
const at = (ts) => `{"timestamp":"${ts}","event":"Stop",${S}}`;
const dur = (raw) => L('PostToolUse', `,"tool_name":"Read","tool_use_id":"u1","duration_ms":${raw}`);
const c = (name, line, code) => ({ name, line, code });

export const CASES = [
  // Válidos
  c('stop-minimo', L('Stop'), null),
  c('comunes-completos', `{${T},"event":"PreToolUse",${S},"agent_id":"a_1-B","agent_type":"Explore","permission_mode":"default","tool_name":"Bash","tool_use_id":"toolu_01"}`, null),
  c('sessionstart', L('SessionStart', ',"source":"startup","model":"claude-opus-5-5"'), null),
  c('modelo-1m', L('SessionStart', ',"source":"resume","model":"claude-opus-5-5[1m]"'), null),
  c('modelo-other', L('SessionStart', ',"model":"other"'), null),
  c('sessionend', L('SessionEnd', ',"reason":"prompt_input_exit"'), null),
  c('userpromptsubmit', L('UserPromptSubmit'), null),
  c('stop-contadores', L('Stop', ',"stop_hook_active":false,"background_tasks_count":0,"session_crons_count":1000'), null),
  c('stopfailure', L('StopFailure', ',"error":"rate_limit"'), null),
  c('notification', L('Notification', ',"notification_type":"idle_prompt"'), null),
  c('permissionrequest', L('PermissionRequest', ',"tool_name":"mcp","permission_mode":"bypassPermissions"'), null),
  c('posttooluse-max', dur('86400000'), null),
  c('posttooluse-cero', dur('0'), null),
  c('posttoolusefailure', L('PostToolUseFailure', ',"tool_name":"other","tool_use_id":"u1","is_interrupt":true'), null),
  c('subagentstart', L('SubagentStart', ',"agent_id":"a1","agent_type":"custom"'), null),
  c('subagentstop', L('SubagentStop', ',"stop_hook_active":true,"agent_type":"plugin"'), null),
  c('bisiesto-2028', at('2028-02-29T23:59:59.9999999+00:00'), null),
  c('bisiesto-2000', at('2000-02-29T00:00:00.0000000+00:00'), null),
  c('anio-1', at('0001-01-01T00:00:00.0000000+00:00'), null),
  c('anio-9999', at('9999-12-31T23:59:59.9999999+00:00'), null),
  c('sid-8', `{${T},"event":"Stop","session_id":"abcdefgh"}`, null),
  c('sid-64', `{${T},"event":"Stop","session_id":"${'a'.repeat(64)}"}`, null),
  c('id-64', L('Stop', `,"agent_id":"${'b'.repeat(64)}"`), null),
  c('project-id', L('UserPromptSubmit', `,"project_id":"${'0123456789abcdef'.repeat(2)}"`), null),
  c('espacios-alrededor', `  ${L('Stop')}\t `, null),
  c('espacios-entre-tokens', `{ ${T.replace(':', ' : ')} ,\t"event":"Stop" , ${S} }`, null),
  c('clave-escapada', `{${T},"\\u0065vent":"Stop",${S}}`, null),
  c('valor-escapado', `{${T},"event":"Sto\\u0070",${S}}`, null),

  // Evento
  c('evento-minusculas', L('stop'), 'invalid_event'),
  c('evento-desconocido', L('Foo'), 'invalid_event'),
  c('evento-no-texto', `{${T},"event":true,${S}}`, 'invalid_event'),
  c('evento-hex-mayus', `{${T},"event":"Sto\\u0050",${S}}`, 'invalid_event'),
  c('evento-guion-blando-escapado', `{${T},"event":"Sto\\u00ADp",${S}}`, 'invalid_event'),
  c('evento-guion-blando-literal', `{${T},"event":"Sto\u00ADp",${S}}`, 'invalid_event'),
  c('evento-zwj-escapado', `{${T},"event":"Sto\\u200Dp",${S}}`, 'invalid_event'),

  // Obligatorios
  c('falta-session', `{${T},"event":"Stop"}`, 'missing_required'),
  c('falta-timestamp', `{"event":"Stop",${S}}`, 'missing_required'),
  c('falta-event', `{${T},${S}}`, 'missing_required'),
  c('objeto-vacio', '{}', 'missing_required'),
  c('obligatorio-mayusculas', `{${T},"Event":"Stop",${S}}`, 'missing_required'),

  // Prohibidos (con marca sintética en el valor)
  c('prohibido-prompt', L('UserPromptSubmit', `,"prompt":"${MARK}"`), 'forbidden_field'),
  c('prohibido-mayusculas', L('Stop', `,"CWD":"C:\\\\${MARK}"`), 'forbidden_field'),
  c('prohibido-escapado', L('Stop', `,"\\u0063wd":"${MARK}"`), 'forbidden_field'),
  c('prohibido-anidado', L('PreToolUse', `,"tool_input":{"command":"${MARK}"}`), 'forbidden_field'),
  c('prohibido-array', L('PermissionRequest', `,"permission_suggestions":["${MARK}"]`), 'forbidden_field'),
  c('prohibido-json-roto', `{"prompt":"${MARK}`, 'forbidden_field'),
  c('prohibido-message', L('Notification', `,"message":"${MARK}","notification_type":"idle_prompt"`), 'forbidden_field'),

  // Campos no permitidos
  c('error-en-posttoolusefailure', L('PostToolUseFailure', `,"error":"${MARK}"`), 'field_not_allowed'),
  c('campo-de-otro-evento', L('Stop', ',"tool_name":"Bash"'), 'field_not_allowed'),
  c('modelo-en-stop', L('Stop', ',"model":"other"'), 'field_not_allowed'),
  c('clave-desconocida', L('Stop', `,"${MARK}":1`), 'field_not_allowed'),
  c('clave-con-espacio', L('Stop', ',"agent_id ":"a"'), 'field_not_allowed'),
  c('clave-mayusculas', L('SessionEnd', ',"Reason":"other"'), 'field_not_allowed'),

  // Duplicados
  c('clave-duplicada', `{${T},"event":"Stop","event":"Stop",${S}}`, 'duplicate_key'),
  c('clave-duplicada-mayusculas', L('Stop', ',"agent_id":"a","Agent_id":"a"'), 'case_duplicate_key'),
  c('desconocida-duplicada-mayusculas', L('Stop', `,"${MARK}":1,"${MARK.toLowerCase()}":2`), 'case_duplicate_key'),

  // Nulos
  c('nulo-agent-id', L('Stop', ',"agent_id":null'), 'null_value'),
  c('nulo-bool', L('Stop', ',"stop_hook_active":null'), 'null_value'),
  c('nulo-obligatorio', `{${T},"event":"Stop","session_id":null}`, 'null_value'),

  // Enteros
  c('decimal', dur('1.5'), 'invalid_value'),
  c('decimal-entero', dur('1.0'), 'invalid_value'),
  c('exponente', dur('1e3'), 'invalid_value'),
  c('exponente-mayus', dur('1E3'), 'invalid_value'),
  c('exponente-signo', dur('1e+3'), 'invalid_value'),
  c('exponente-cero', dur('0e0'), 'invalid_value'),
  c('negativo', dur('-1'), 'invalid_value'),
  c('menos-cero', dur('-0'), null),
  c('fuera-rango', dur('86400001'), 'invalid_value'),
  c('contador-1001', L('Stop', ',"background_tasks_count":1001'), 'invalid_value'),
  c('int64-max', dur('9223372036854775807'), 'invalid_value'),
  c('mayor-int64', dur('9223372036854775808'), 'invalid_value'),
  c('entero-texto', dur('"5"'), 'invalid_value'),
  c('entero-bool', dur('true'), 'invalid_value'),

  // Booleanos
  c('bool-texto', L('Stop', ',"stop_hook_active":"true"'), 'invalid_value'),
  c('bool-numero', L('Stop', ',"stop_hook_active":1'), 'invalid_value'),

  // Enumeraciones y patrones
  c('tool-mcp-crudo', L('PreToolUse', ',"tool_name":"mcp__srv__t","tool_use_id":"u1"'), 'invalid_value'),
  c('tool-minusculas', L('PreToolUse', ',"tool_name":"bash"'), 'invalid_value'),
  c('agent-type-propio', L('Stop', `,"agent_type":"${MARK}"`), 'invalid_value'),
  c('agent-type-vacio', L('Stop', ',"agent_type":""'), 'invalid_value'),
  c('permission-desconocido', L('Stop', ',"permission_mode":"yolo"'), 'invalid_value'),
  c('source-desconocido', L('SessionStart', ',"source":"boot"'), 'invalid_value'),
  c('modelo-mayus', L('SessionStart', ',"model":"Claude-opus"'), 'invalid_value'),
  c('modelo-arn', L('SessionStart', `,"model":"arn:aws:bedrock:${MARK}"`), 'invalid_value'),
  c('modelo-41', L('SessionStart', `,"model":"claude-${'x'.repeat(41)}"`), 'invalid_value'),
  c('sid-7', `{${T},"event":"Stop","session_id":"abcdefg"}`, 'invalid_value'),
  c('sid-65', `{${T},"event":"Stop","session_id":"${'a'.repeat(65)}"}`, 'invalid_value'),
  c('sid-guion-bajo', `{${T},"event":"Stop","session_id":"fixture_0001"}`, 'invalid_value'),
  c('sid-salto-final', `{${T},"event":"Stop","session_id":"fixture-0001\\n"}`, 'invalid_value'),
  c('id-vacio', L('Stop', ',"agent_id":""'), 'invalid_value'),
  c('id-65', L('Stop', `,"agent_id":"${'b'.repeat(65)}"`), 'invalid_value'),
  c('project-id-mayus', L('Stop', `,"project_id":"${'0123456789ABCDEF'.repeat(2)}"`), 'invalid_value'),
  c('project-id-31', L('Stop', `,"project_id":"${'a'.repeat(31)}"`), 'invalid_value'),
  c('project-id-33', L('Stop', `,"project_id":"${'a'.repeat(33)}"`), 'invalid_value'),
  c('project-id-ruta', L('Stop', `,"project_id":"C:\\\\${MARK}"`), 'invalid_value'),
  c('id-barra-escapada', L('PreToolUse', ',"tool_use_id":"u\\/1"'), 'invalid_value'),
  c('id-salto-final', L('Stop', ',"agent_id":"a1\\n"'), 'invalid_value'),
  c('id-cr-final', L('Stop', ',"agent_id":"a1\\r"'), 'invalid_value'),
  c('id-u2028-final', L('Stop', ',"agent_id":"a1\\u2028"'), 'invalid_value'),

  // Fechas
  c('29-feb-2026', at('2026-02-29T10:00:00.0000000+00:00'), 'invalid_value'),
  c('29-feb-1900', at('1900-02-29T10:00:00.0000000+00:00'), 'invalid_value'),
  c('mes-13', at('2026-13-01T10:00:00.0000000+00:00'), 'invalid_value'),
  c('mes-00', at('2026-00-01T10:00:00.0000000+00:00'), 'invalid_value'),
  c('31-abril', at('2026-04-31T10:00:00.0000000+00:00'), 'invalid_value'),
  c('dia-00', at('2026-04-00T10:00:00.0000000+00:00'), 'invalid_value'),
  c('hora-24', at('2026-10-31T24:00:00.0000000+00:00'), 'invalid_value'),
  c('minuto-60', at('2026-10-31T10:60:00.0000000+00:00'), 'invalid_value'),
  c('segundo-60', at('2026-10-31T10:00:60.0000000+00:00'), 'invalid_value'),
  c('anio-0', at('0000-01-01T00:00:00.0000000+00:00'), 'invalid_value'),
  c('seis-decimales', at('2026-10-31T10:00:00.000000+00:00'), 'invalid_value'),
  c('zona-mas-1', at('2026-10-31T10:00:00.0000000+01:00'), 'invalid_value'),
  c('zona-z', at('2026-10-31T10:00:00.0000000Z'), 'invalid_value'),
  c('ts-salto-final', at(`${TS}\\n`), 'invalid_value'),
  c('ts-digitos-arabes', at('\u0662\u0660\u0662\u0666-10-31T10:00:00.0000000+00:00'), 'invalid_value'),
  c('ts-numero', `{"timestamp":1,"event":"Stop",${S}}`, 'invalid_value'),
  c('ts-date-ms', at('\\/Date(0)\\/'), 'invalid_value'),

  // Estructura
  c('valor-objeto', L('SessionStart', ',"source":{}'), 'invalid_value'),
  c('valor-array', L('Stop', ',"agent_id":[]'), 'invalid_value'),
  c('raiz-array', '[1]', 'not_object'),
  c('raiz-cadena', '"x"', 'not_object'),
  c('raiz-numero', '5', 'not_object'),
  c('raiz-null', 'null', 'not_object'),

  // Sintaxis JSON
  c('no-json', `hola ${MARK}`, 'invalid_json'),
  c('truncado', L('Stop').slice(0, -1), 'invalid_json'),
  c('coma-final', `{${T},"event":"Stop",${S},}`, 'invalid_json'),
  c('comillas-simples-valor', `{${T},"event":'Stop',${S}}`, 'invalid_json'),
  c('clave-sin-comillas', `{${T},event:"Stop",${S}}`, 'invalid_json'),
  c('comentario', `${L('Stop')} /*x*/`, 'invalid_json'),
  c('basura-final', `${L('Stop')}x`, 'invalid_json'),
  c('dos-objetos', `${L('Stop')}${L('Stop')}`, 'invalid_json'),
  c('nbsp-inicial', `\u00A0${L('Stop')}`, 'invalid_json'),
  c('bom-interior', `\uFEFF${L('Stop')}`, 'invalid_json'),
  c('nel-entre-tokens', `{${T},\u0085"event":"Stop",${S}}`, 'invalid_json'),
  c('ceros-izquierda', dur('01'), 'invalid_json'),
  c('mas-inicial', dur('+1'), 'invalid_json'),
  c('nan', dur('NaN'), 'invalid_json'),
  c('infinito', dur('Infinity'), 'invalid_json'),
  c('punto-final', dur('1.'), 'invalid_json'),
  c('tab-en-cadena', `{${T},"event":"St\top",${S}}`, 'invalid_json'),
  c('escape-invalido', `{${T},"event":"St\\xop",${S}}`, 'invalid_json'),
  c('profundidad-excesiva', L('Stop', `,"agent_id":${'['.repeat(200)}${']'.repeat(200)}`), 'invalid_json'),
];

// Líneas vacías o solo con espacios (según Char.IsWhiteSpace de .NET): se ignoran, ni evento ni rechazo.
export const BLANK = ['', '   ', '\t', '\u00A0', '\u3000 '];

// T0-F tal cual en la sección T0 de la rev3 (L1..L9) y el código que debe dar el validador.
export const T0F_CODES = [null, 'invalid_event', 'forbidden_field', 'invalid_value', 'field_not_allowed',
  'invalid_value', 'duplicate_key', 'invalid_value', 'null_value'];
