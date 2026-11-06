# audit-log.ps1 - valida el registro sin imprimir valores.
# -Schema Nuevo: bloqueante (exit 0 conforme, 1 incidencias, 2 ilegible).
# -Schema Historico: informativo (exit 0 conforme, 3 no conforme, 2 ilegible); nunca bloquea la captura nueva.
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][ValidateSet('Nuevo', 'Historico')][string]$Schema
)
$ErrorActionPreference = 'Stop'
try { $Path = (Resolve-Path -LiteralPath $Path).ProviderPath } catch { 'No se puede leer el registro.'; exit 2 }

$forbidden = 'prompt','last_assistant_message','tool_input','tool_response','message','title','transcript_path',
  'agent_transcript_path','scratchpad_dir','error_details','cwd','session_title','permission_suggestions','mcp_server',
  'background_tasks','session_crons','custom_instructions','compact_summary'
$forbiddenRx = '"(' + ($forbidden -join '|') + ')"\s*:'
$common = 'timestamp','event','session_id','project_id','agent_id','agent_type','permission_mode'
$extra = @{
  SessionStart = @('source','model'); SessionEnd = @('reason'); UserPromptSubmit = @()
  Stop = @('stop_hook_active','background_tasks_count','session_crons_count')
  StopFailure = @('error'); Notification = @('notification_type'); PermissionRequest = @('tool_name')
  PreToolUse = @('tool_name','tool_use_id'); PostToolUse = @('tool_name','tool_use_id','duration_ms')
  PostToolUseFailure = @('tool_name','tool_use_id','is_interrupt')
  SubagentStart = @(); SubagentStop = @('stop_hook_active')
}
$histKeys = 'timestamp','event','session_id','agent_id','agent_type','tool_name','tool_use_id','duration_ms','is_interrupt','source','reason'
$knownKeys = @($common) + @($extra.Values | ForEach-Object { $_ }) + @($histKeys)
$builtinAgents = 'general-purpose','Explore','Plan','claude-code-guide','statusline-setup'

$re = @{
  ts    = '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{7}\+00:00\z'
  sid   = '^[A-Za-z0-9-]{8,64}\z'
  pid   = '^[0-9a-f]{32}\z'
  id    = '^[A-Za-z0-9_-]{1,64}\z'
  model = '^(claude-[a-z0-9-]{1,40}(\[1m\])?|other)\z'
  raw0  = '^[A-Za-z0-9_.:-]{0,128}\z'
}
$enums = @{
  event_new = 'SessionStart','SessionEnd','UserPromptSubmit','Stop','StopFailure','Notification','PermissionRequest',
    'PreToolUse','PostToolUse','PostToolUseFailure','SubagentStart','SubagentStop'
  event_hist = 'SessionStart','SessionEnd','SubagentStart','SubagentStop','PreToolUse','PostToolUse','PostToolUseFailure','PermissionRequest'
  source = 'startup','resume','clear','compact','fork','unknown'
  source_hist = 'startup','resume','clear','compact','fork'
  reason = 'clear','resume','logout','prompt_input_exit','other','unknown'
  reason_hist = 'clear','resume','logout','prompt_input_exit','other'
  permission_mode = 'default','plan','acceptEdits','auto','dontAsk','bypassPermissions','unknown'
  notification_type = 'permission_prompt','idle_prompt','auth_success','elicitation_dialog','elicitation_url_dialog',
    'elicitation_complete','elicitation_response','agent_needs_input','agent_completed','quota_auto_resume_fired',
    'quota_auto_resume_stale','quota_auto_resume_disabled','plugin_notification','unknown'
  error = 'rate_limit','overloaded','authentication_failed','oauth_org_not_allowed','account_on_hold','billing_error',
    'invalid_request','model_not_found','server_error','max_output_tokens','cloud_credential_error','unknown'
  agent_type = 'general-purpose','Explore','Plan','claude-code-guide','statusline-setup','custom','plugin','none'
  tool_name = 'Agent','AskUserQuestion','Bash','PowerShell','Read','Write','Edit','NotebookEdit','Glob','Grep',
    'WebFetch','WebSearch','TodoWrite','Skill','ToolSearch','EnterPlanMode','ExitPlanMode','Monitor','TaskStop','mcp','other'
}
$rulesNew = @{
  timestamp = 'ts'; event = 'enum:event_new'; session_id = 're:sid'; project_id = 're:pid'; agent_id = 're:id'; agent_type = 'enum:agent_type'
  permission_mode = 'enum:permission_mode'; source = 'enum:source'; model = 're:model'; reason = 'enum:reason'
  stop_hook_active = 'bool'; background_tasks_count = 'int:1000'; session_crons_count = 'int:1000'
  error = 'enum:error'; notification_type = 'enum:notification_type'; tool_name = 'enum:tool_name'
  tool_use_id = 're:id'; duration_ms = 'int:86400000'; is_interrupt = 'bool'
}
$rulesHist = @{
  timestamp = 'ts'; event = 'enum:event_hist'; session_id = 're:sid'; agent_id = 're:id'; agent_type = 're:raw0'
  tool_name = 're:raw0'; tool_use_id = 're:id'; duration_ms = 'int:86400000'; is_interrupt = 'bool'
  source = 'enum:source_hist'; reason = 'enum:reason_hist'
}
function Test-Value([string]$Rule, $Value) {
  if ($Rule -ceq 'ts') {
    if (-not (($Value -is [string]) -and [regex]::IsMatch($Value, $re['ts']))) { return $false }
    try { [void][DateTimeOffset]::ParseExact($Value, 'o', [Globalization.CultureInfo]::InvariantCulture); return $true } catch { return $false }
  }
  if ($Rule.StartsWith('enum:')) { return ($Value -is [string]) -and ($enums[$Rule.Substring(5)] -ccontains $Value) }
  if ($Rule.StartsWith('re:'))   { return ($Value -is [string]) -and [regex]::IsMatch($Value, $re[$Rule.Substring(3)]) }
  if ($Rule -ceq 'bool')         { return $Value -is [bool] }
  if ($Rule.StartsWith('int:'))  { return ($Value -is [int] -or $Value -is [long]) -and $Value -ge 0 -and $Value -le [long]$Rule.Substring(4) }
  return $false
}

$n = 0; $bad = 0; $mcp = 0; $customAgent = 0
$perEvent = New-Object 'System.Collections.Generic.SortedDictionary[string,int]' ([StringComparer]::Ordinal)
foreach ($line in [System.IO.File]::ReadLines($Path)) {
  $n++
  if ($line.Trim().Length -eq 0) { continue }
  if ($line -match $forbiddenRx) { 'L{0} | nombre de campo prohibido en el texto de la linea' -f $n; $bad++ }
  try { $o = $line | ConvertFrom-Json } catch { 'L{0} | JSON no valido o con claves que solo difieren en mayusculas' -f $n; $bad++; continue }
  if ($o -isnot [System.Management.Automation.PSCustomObject]) { 'L{0} | la linea no es un objeto JSON' -f $n; $bad++; continue }
  $props = @($o.PSObject.Properties)
  if ([regex]::Matches($line, '"(?:[^"\\]|\\.)*"\s*:').Count -ne $props.Count) { 'L{0} | posible clave duplicada' -f $n; $bad++ }
  $names = @($props | ForEach-Object { $_.Name })
  foreach ($req in 'timestamp','event','session_id') { if ($names -cnotcontains $req) { 'L{0} | falta {1}' -f $n, $req; $bad++ } }
  $ev = $o.event
  $evEnum = if ($Schema -eq 'Nuevo') { $enums['event_new'] } else { $enums['event_hist'] }
  if (-not (($ev -is [string]) -and ($evEnum -ccontains $ev))) { 'L{0} | event ausente o fuera de la enumeracion' -f $n; $bad++; continue }
  if ($perEvent.ContainsKey($ev)) { $perEvent[$ev] = $perEvent[$ev] + 1 } else { $perEvent[$ev] = 1 }
  if ($Schema -eq 'Nuevo') { $allowed = @($common) + @($extra[$ev]); $rules = $rulesNew } else { $allowed = $histKeys; $rules = $rulesHist }
  foreach ($p in $props) {
    $k = $p.Name; $v = $p.Value
    if ($forbidden -contains $k) { 'L{0} | {1} | {2} | CAMPO PROHIBIDO' -f $n, $ev, $k; $bad++; continue }
    if ($allowed -cnotcontains $k) {
      $label = if ($knownKeys -ccontains $k) { $k } else { 'clave desconocida de {0} caracteres' -f $k.Length }
      'L{0} | {1} | {2} | clave no permitida en este evento' -f $n, $ev, $label; $bad++; continue
    }
    if ($null -eq $v) {
      if ($Schema -eq 'Nuevo') { 'L{0} | {1} | {2} | valor nulo (el esquema nuevo omite campos vacios)' -f $n, $ev, $k; $bad++ }
      continue
    }
    if (-not (Test-Value $rules[$k] $v)) { 'L{0} | {1} | {2} | tipo, enumeracion, patron o rango no valido' -f $n, $ev, $k; $bad++; continue }
    if ($Schema -eq 'Historico') {
      if ($k -ceq 'tool_name' -and $v.StartsWith('mcp__', [StringComparison]::Ordinal)) { $mcp++ }
      if ($k -ceq 'agent_type' -and $v -ne '' -and $builtinAgents -cnotcontains $v) { $customAgent++ }
    }
  }
}
'ESQUEMA={0} lineas={1} incidencias={2}' -f $Schema, $n, $bad
foreach ($kv in $perEvent.GetEnumerator()) { '  {0}={1}' -f $kv.Key, $kv.Value }
if ($Schema -eq 'Historico') {
  'tool_name con prefijo MCP (se normalizarian a mcp): {0}' -f $mcp
  'agent_type no integrados (se normalizarian a custom o plugin): {0}' -f $customAgent
  if ($bad -gt 0) { exit 3 } else { exit 0 }
}
if ($bad -gt 0) { exit 1 } else { exit 0 }
