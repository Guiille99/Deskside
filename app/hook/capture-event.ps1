
$ErrorActionPreference = "Stop"

# Lista blanca y valores documentados: duplicados de pruebas\audit-log.ps1 (referencia normativa) y backend\src\validator.js. Cambiar las tres a la vez
$extraFields = @{
    SessionStart = @('source', 'model'); SessionEnd = @('reason'); UserPromptSubmit = @()
    Stop = @('stop_hook_active', 'background_tasks_count', 'session_crons_count')
    StopFailure = @('error'); Notification = @('notification_type'); PermissionRequest = @('tool_name')
    PreToolUse = @('tool_name', 'tool_use_id'); PostToolUse = @('tool_name', 'tool_use_id', 'duration_ms')
    PostToolUseFailure = @('tool_name', 'tool_use_id', 'is_interrupt')
    SubagentStart = @(); SubagentStop = @('stop_hook_active')
}
$enums = @{
    source = 'startup', 'resume', 'clear', 'compact', 'fork'
    reason = 'clear', 'resume', 'logout', 'prompt_input_exit', 'other'
    permission_mode = 'default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'
    notification_type = 'permission_prompt', 'idle_prompt', 'auth_success', 'elicitation_dialog', 'elicitation_url_dialog',
        'elicitation_complete', 'elicitation_response', 'agent_needs_input', 'agent_completed', 'quota_auto_resume_fired',
        'quota_auto_resume_stale', 'quota_auto_resume_disabled', 'plugin_notification'
    error = 'rate_limit', 'overloaded', 'authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'billing_error',
        'invalid_request', 'model_not_found', 'server_error', 'max_output_tokens', 'cloud_credential_error'
}
$builtinTools = 'Agent', 'AskUserQuestion', 'Bash', 'PowerShell', 'Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep',
    'WebFetch', 'WebSearch', 'TodoWrite', 'Skill', 'ToolSearch', 'EnterPlanMode', 'ExitPlanMode', 'Monitor', 'TaskStop'
$builtinAgents = 'general-purpose', 'Explore', 'Plan', 'claude-code-guide', 'statusline-setup'

function Get-Enum($Value, [string]$Name) {
    if (($Value -is [string]) -and ($enums[$Name] -ccontains $Value)) { $Value } else { 'unknown' }
}
function Test-Id($Value, [string]$Pattern) { ($Value -is [string]) -and [regex]::IsMatch($Value, $Pattern) }
function Get-Count($Value) {
    if (($Value -is [array]) -and $Value.Count -le 1000) { $Value.Count }
}
# Crea el archivo solo si no existe (temporal + Move, que falla si otro proceso se adelanto); el perdedor no hace nada
function New-FileOnce([string]$Path, [byte[]]$Bytes) {
    if (Test-Path -LiteralPath $Path) { return }
    $tmp = $Path + '.' + $PID + '.tmp'
    [System.IO.File]::WriteAllBytes($tmp, $Bytes)
    try { [System.IO.File]::Move($tmp, $Path) } catch [System.IO.IOException] { Remove-Item -LiteralPath $tmp -Force }
}

try {
    $rawInput = [Console]::In.ReadToEnd()
    $data = $rawInput | ConvertFrom-Json

    $ev = $data.hook_event_name
    # Evento fuera de la lista o sin session_id valido: no se escribe nada
    if (-not (($ev -is [string]) -and $extraFields.ContainsKey($ev) -and (Test-Id $data.session_id '^[A-Za-z0-9-]{8,64}\z'))) { exit 0 }

    # Identidad del proyecto: HMAC-SHA256(clave local, ruta canonica) truncado a 16 bytes. La ruta no sale de este proceso
    $projectDir = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { $data.cwd }
    if (-not (($projectDir -is [string]) -and $projectDir -ne '') -or -not $env:APPDATA) { exit 0 }
    # shortcut: no resuelve enlaces simbolicos, uniones ni nombres 8.3; dos rutas al mismo proyecto dan dos project_id
    $fullDir = [System.IO.Path]::GetFullPath($projectDir).TrimEnd('\', '/')
    $canonical = $fullDir.ToLowerInvariant()
    $policyDir = Join-Path $env:APPDATA 'ClaudeOffice'
    foreach ($d in 'enabled', 'excluded', 'pending') { [void][System.IO.Directory]::CreateDirectory((Join-Path $policyDir $d)) }
    $keyPath = Join-Path $policyDir 'install.key'
    if (-not (Test-Path -LiteralPath $keyPath)) {
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $newKey = New-Object byte[] 32; $rng.GetBytes($newKey) } finally { $rng.Dispose() }
        New-FileOnce $keyPath $newKey
    }
    $hmac = [System.Security.Cryptography.HMACSHA256]::new([System.IO.File]::ReadAllBytes($keyPath))
    try { $mac = $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($canonical)) } finally { $hmac.Dispose() }
    $projectId = [BitConverter]::ToString($mac, 0, 16).Replace('-', '').ToLowerInvariant()

    # Opt-in: excluido gana sobre activado; sin politica se crea la solicitud pendiente (solo el nombre de la carpeta) y no se registra nada
    if (Test-Path -LiteralPath (Join-Path $policyDir "excluded\$projectId.json")) { exit 0 }
    if (-not (Test-Path -LiteralPath (Join-Path $policyDir "enabled\$projectId.json"))) {
        $pending = ([ordered]@{ name = [System.IO.Path]::GetFileName($fullDir) } | ConvertTo-Json -Compress)
        New-FileOnce (Join-Path $policyDir "pending\$projectId.json") (New-Object System.Text.UTF8Encoding($false)).GetBytes($pending)
        exit 0
    }

    $event = [ordered]@{
        timestamp  = [DateTimeOffset]::UtcNow.ToString("o")
        event      = $ev
        session_id = $data.session_id
        project_id = $projectId
    }
    if (Test-Id $data.agent_id '^[A-Za-z0-9_-]{1,64}\z') { $event.agent_id = $data.agent_id }

    $at = $data.agent_type
    $event.agent_type = if (($at -isnot [string]) -or $at -eq '') { 'none' }
        elseif ($at.Contains(':')) { 'plugin' }
        elseif ($builtinAgents -ccontains $at) { $at }
        else { 'custom' }

    if ($null -ne $data.permission_mode) { $event.permission_mode = Get-Enum $data.permission_mode 'permission_mode' }

    foreach ($f in $extraFields[$ev]) {
        $v = $data.$f
        switch ($f) {
            { $_ -in 'source', 'reason', 'error', 'notification_type' } { if ($null -ne $v) { $event[$f] = Get-Enum $v $f } }
            'model' { if ($null -ne $v) { $event.model = if (($v -is [string]) -and [regex]::IsMatch($v, '^claude-[a-z0-9-]{1,40}(\[1m\])?\z')) { $v } else { 'other' } } }
            'tool_name' {
                if (($v -is [string]) -and $v -ne '') {
                    $event.tool_name = if ($v.StartsWith('mcp__', [StringComparison]::Ordinal)) { 'mcp' } elseif ($builtinTools -ccontains $v) { $v } else { 'other' }
                }
            }
            'tool_use_id' { if (Test-Id $v '^[A-Za-z0-9_-]{1,64}\z') { $event.tool_use_id = $v } }
            'duration_ms' { if ((($v -is [int]) -or ($v -is [long])) -and $v -ge 0 -and $v -le 86400000) { $event.duration_ms = $v } }
            { $_ -in 'stop_hook_active', 'is_interrupt' } { if ($v -is [bool]) { $event[$f] = $v } }
            'background_tasks_count' { $c = Get-Count $data.background_tasks; if ($null -ne $c) { $event[$f] = $c } }
            'session_crons_count' { $c = Get-Count $data.session_crons; if ($null -ne $c) { $event[$f] = $c } }
        }
    }

    $logPath = Join-Path $policyDir "hooks-events.jsonl"
    $line = $event | ConvertTo-Json -Compress
    $encoding = New-Object System.Text.UTF8Encoding($false)

    # Un mutex por destino serializa las escrituras de procesos concurrentes. El nombre sale de un hash de la ruta del registro (ruta en minusculas, hash en hex mayusculas)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $pathHash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes([System.IO.Path]::GetFullPath($logPath).ToLowerInvariant())) }
    finally { $sha.Dispose() }
    $mutex = New-Object System.Threading.Mutex($false, ('Local\ClaudeOfficeHooksLog-' + [BitConverter]::ToString($pathHash, 0, 16).Replace('-', '')))
    $locked = $false
    try {
        # shortcut: espera maxima 2 s; la seccion critica dura milisegundos y el hook dispone de 5 s en total, arranque de PowerShell incluido. Si se agota no se escribe sin bloqueo
        try { $locked = $mutex.WaitOne(2000) }
        catch [System.Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked) { throw 'Tiempo de espera agotado al obtener el bloqueo del registro' }

        [System.IO.File]::AppendAllText(
            $logPath,
            $line + [Environment]::NewLine,
            $encoding
        )
    }
    finally {
        try { if ($locked) { $mutex.ReleaseMutex() } }
        finally { $mutex.Dispose() }
    }
}
catch {
    # Mensaje fijo: la excepcion original no se propaga (podria arrastrar contenido)
    [Console]::Error.WriteLine('capture-event: error al registrar el evento')
    exit 1
}
