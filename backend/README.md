# Claude Office: backend H1 (validador e ingesta SQLite)

Primer núcleo del backend: valida cada línea del registro JSONL de los hooks con la lista blanca del esquema Nuevo y guarda en SQLite solo los eventos válidos, con avance transaccional del cursor.

## Requisitos

- Node.js 26 (probado con v26.13.0). Usa `node:sqlite` (clase `Database`), `node:test` y `node:fs`.
- Ninguna dependencia externa.
- Para los tests de paridad, Windows PowerShell 5.1 (`powershell.exe`). Sin él, esos tres tests se marcan como omitidos, con el motivo en el informe de `node:test`.

## Entorno validado

- **Validado:** Windows 11, Node.js v26.13.0, con el proyecto y `%TEMP%` en NTFS local (unidad C:). En ese entorno pasan los 33 tests.
- **No validado:** Linux, macOS y cualquier otro sistema operativo o sistema de archivos. **Los tests no se han ejecutado allí.** Todo lo que este documento dice sobre POSIX es razonamiento sobre cómo funcionan los inodes, no resultado de pruebas.

## Ejecutar los tests

```powershell
cd backend
npm test
```

Cada test crea su propia carpeta en `%TEMP%` (`co-h1-*`) y la borra al terminar. Los tests de paridad ejecutan `pruebas/audit-log.ps1 -Schema Nuevo` solo sobre fixtures sintéticos: `test/fixtures/t0f.jsonl` y archivos generados en esas carpetas temporales. Nunca leen el registro real.

### Inventario de tests

Total esperado: **33** (8 + 22 + 3). Resultado esperado en el entorno validado: 33 aprobados, 0 fallidos, 0 omitidos. Sin `powershell.exe`: 30 aprobados y 3 omitidos.

| Archivo | Tests | Clasificación |
|---|---|---|
| `test/validator.test.js` | 8 | Portables por diseño: no hacen E/S. Ejecutados solo en Windows. |
| `test/ingest.test.js` | 22 | Portables por diseño: usan solo `node:fs` y `node:sqlite`. Ejecutados solo en Windows. Cinco dependen de la semántica del sistema de archivos (ver abajo). |
| `test/parity.test.js` | 3 | **Específicos de Windows**: ejecutan `powershell.exe` y el auditor `.ps1`. Se omiten si no está. |

Tests de `ingest.test.js` que dependen del sistema de archivos:

| Test | Qué asume | Fuera de Windows |
|---|---|---|
| Borrado y recreado | Que el FileId cambia al recrear el archivo. Es una propiedad de NTFS. | **No se exige.** Acepta que no se detecte o `SOURCE_REPLACED`, y emite un diagnóstico (`t.diagnostic`) que dice cuál de los dos ocurrió. Cualquier otro error falla. |
| Renombrado encima | Que el archivo nuevo existe antes de liberarse el antiguo, así que no comparte identidad. | Se exige igual. Por POSIX debería cumplirse, pero no se ha ejecutado. |
| Mover el archivo | Que `rename` en el mismo volumen conserva la identidad. | Se exige igual. Sin verificar fuera de Windows. |
| Truncamiento (dos tests) | Solo tamaño y byte en `offset-1`, sin identidad. | Se exigen igual. |

Los demás tests de `ingest.test.js` (esquema, T0-F, BOM, CRLF, líneas incompletas, reanudación, idempotencia, lotes, rollbacks, UTF-8, errores fijos y privacidad) no dependen del sistema de archivos más allá de crear y borrar archivos en un directorio temporal.

## Estructura

| Archivo | Responsabilidad |
|---|---|
| `src/validator.js` | `validateLine(texto)` devuelve `{ ok: true, event }` o `{ ok: false, code }`. Incluye un parser JSON estricto propio, porque `JSON.parse` pierde las claves duplicadas y la forma del número. No hace E/S. |
| `src/schema.js` | DDL de las tres tablas y `openDatabase(ruta)`. |
| `src/ingest.js` | `ingest(db, { sourceId, path, batchLines, batchBytes })`: lectura incremental por bytes, lotes transaccionales y control de la identidad de la fuente. |
| `test/fixtures/cases.js` | Unos 135 casos sintéticos con el código esperado de cada uno, y la marca `ZZSECRETO7Q` en campos prohibidos y claves desconocidas. |
| `test/fixtures/t0f.jsonl` | T0-F literal de la rev3. |

## Esquema SQLite

Tres tablas, todas `STRICT`:

```sql
ingest_cursor (source_id TEXT PRIMARY KEY, file_identity TEXT NOT NULL, byte_offset INTEGER NOT NULL)
ingest_reject (source_id TEXT NOT NULL, byte_offset INTEGER NOT NULL, code TEXT NOT NULL CHECK (code IN (...)),
               UNIQUE (source_id, byte_offset))
event (source_id, byte_offset,            -- procedencia
       timestamp, event, session_id,      -- NOT NULL
       project_id, agent_id, agent_type, permission_mode, source, model, reason,
       stop_hook_active, background_tasks_count, session_crons_count, error,
       notification_type, tool_name, tool_use_id, duration_ms, is_interrupt,
       UNIQUE (source_id, byte_offset))
```

La definición exacta está en `src/schema.js`. Detalles:

- Booleanos: `INTEGER` con `CHECK IN (0,1)`. Enteros: `INTEGER`.
- `agent_id`, `agent_type`, `tool_use_id` y los demás campos opcionales quedan en `NULL` cuando faltan. No se sustituyen por ningún valor.
- `ingest_reject` guarda una fila por línea rechazada: offset y código fijo, nunca contenido. Los contadores salen de `SELECT code, count(*) ... GROUP BY code`.
- No se guarda ninguna ruta de archivo.

## Ingesta

Cada lote (por defecto 1000 líneas o 1 MiB) es una transacción `BEGIN IMMEDIATE … COMMIT`, con `ROLLBACK` si algo falla:

1. Se lee el cursor dentro de la transacción y se comprueba la fuente.
2. Se leen y validan las líneas completas, las que terminan en `\n`.
3. Se insertan los eventos y los rechazos y se avanza el cursor, todo junto.

Comportamiento con casos especiales:

- **Línea sin `\n` final:** no se toca hasta que se completa.
- **Fin de línea:** se aceptan LF y CRLF. Un CR suelto dentro de la línea da `line_break`.
- **BOM:** se acepta solo en el byte 0. En cualquier otra posición da `invalid_json`.
- **Líneas en blanco:** se ignoran con el criterio de `Trim()` de .NET.
- **UTF-8 inválido:** da `invalid_utf8`.
- **Línea más larga que el lote:** da `line_too_long`, pero solo cuando está completa.

**Identidad de la fuente.** `sourceId` es el identificador lógico estable que elige quien llama, con el patrón `^[A-Za-z0-9_-]{1,64}$`. La identidad física es `dev:ino` del archivo (detalles y límites en la sección siguiente). Al primer contacto se guarda la identidad física, y la ingesta se detiene con un error fijo en estos casos:

| Error | Cuándo |
|---|---|
| `SOURCE_REPLACED` | Cambia `dev:ino`: por ejemplo, el archivo se ha renombrado encima o, en NTFS, borrado y recreado. No detecta todas las sustituciones. |
| `SOURCE_TRUNCATED` | El tamaño es menor que el cursor, o el byte anterior al cursor ya no es `\n`. No detecta todos los truncamientos. |
| `INGEST_FAILED` | Cualquier otra excepción, por ejemplo de SQLite. Se descarta el error original. |
| `INVALID_SOURCE_ID` | El `sourceId` no cumple el patrón. |
| `SOURCE_UNREADABLE` | No se puede abrir el archivo. |

No hay recuperación ni rotación automática.

## Identidad física del archivo y portabilidad

**Cómo se obtiene.** En cada lote, dentro de la transacción, `fstatSync(fd, { bigint: true })` sobre el descriptor abierto, y la identidad es la cadena `dev:ino`. Se usa `bigint` porque el `ino` de NTFS puede superar 2^53. La comparación es por igualdad exacta con la guardada en `ingest_cursor.file_identity`. **No se usan** la ruta, `mtime`, `birthtime` ni un hash del contenido como identidad. El descriptor se abre y se cierra en cada llamada a `ingest()`.

**Qué está comprobado.** En Windows con NTFS local, en el entorno de desarrollo, los tests detectan la sustitución por renombrado encima y por borrado y recreado.

**Qué no está comprobado.**

- En sistemas POSIX, un inode puede reutilizarse después de eliminar el archivo. Por tanto `dev:ino` **no garantiza detectar todas las sustituciones** después de borrar y recrear.
- `dev` puede cambiar por características del almacenamiento o del montaje, y provocar `SOURCE_REPLACED` sin que el archivo haya cambiado.
- El código no comprueba que `ino` sea distinto de 0. Con un sistema de archivos que no dé una identidad estable, la comparación no detectaría nada, o fallaría sin motivo.
- No se ha validado experimentalmente el comportamiento en ext4, XFS, Btrfs, tmpfs, FAT/exFAT, ReFS, SMB, NFS ni FUSE. No debe leerse nada de lo anterior como resultado de pruebas.

**Truncamiento.** La detección actual comprueba dos cosas: que el tamaño no sea menor que el cursor, y que el byte anterior al cursor siga siendo `\n`. Si el archivo se trunca y se reescribe antes de la siguiente ingesta, puede volver a superar el cursor. Si además la identidad es la misma y en esa posición hay un `\n`, **no se detecta**. No se afirma que se detecte cualquier truncamiento ni cualquier sustitución. El test de truncamiento y reescritura pasa porque el byte de comprobación cambia, no porque el diseño lo garantice.

**Movimiento y copia.**

- Un movimiento dentro del mismo volumen que conserve la identidad física puede mantener la ingesta.
- Un movimiento entre volúmenes equivale normalmente a una copia y puede producir `SOURCE_REPLACED`. Una copia a otro sistema de archivos, o a otra máquina junto con la base de datos, tiene identidad nueva.
- No se promete que todos los sistemas de archivos se comporten igual.

**`sourceId`.**

- Cada archivo físico de origen debe usar **un único `sourceId`** durante su ciclo de ingesta.
- No se debe ingerir deliberadamente el mismo archivo con varios `sourceId`. El esquema lo permite y duplicaría los eventos, porque no hay unicidad sobre `file_identity`.
- Un `sourceId` queda asociado a una única identidad física. Si cambia, la ingesta se detiene.
- El primer contacto no se verifica: se adopta el archivo que esté en la ruta en ese momento. Elegir la ruta correcta es responsabilidad de quien llama.

**Mejora futura (no implementada).** Mantener abierto el descriptor entre llamadas y comparar `fstat(fd)` con `stat(ruta)`, como hace `tail -F`, mejoraría la detección de sustituciones mientras el proceso esté vivo, porque el sistema no puede reutilizar el inode de un archivo abierto. **No elimina las limitaciones tras reiniciar el proceso**: entonces se vuelve a depender de `dev:ino` y de las dos comprobaciones de truncamiento.

## Códigos de rechazo

| Código | Motivo |
|---|---|
| `line_break` | CR o LF crudo dentro de la línea. |
| `forbidden_field` | Nombre prohibido en el texto (`"nombre"\s*:`, sin distinguir mayúsculas) o como clave. |
| `invalid_json` | No es JSON estricto (RFC 8259) o tiene más de 100 niveles de anidamiento. |
| `not_object` | La raíz no es un objeto. |
| `duplicate_key` | Clave repetida. |
| `case_duplicate_key` | Claves que solo difieren en mayúsculas. |
| `missing_required` | Falta `timestamp`, `event` o `session_id`. |
| `invalid_event` | `event` no es una cadena de la enumeración (comparación exacta). |
| `field_not_allowed` | Clave no permitida para ese evento. |
| `null_value` | Valor `null`. |
| `invalid_value` | Tipo, enumeración, patrón, rango o fecha no válidos. Los enteros deben ser tokens JSON sin parte decimal ni exponente. |
| `invalid_utf8` | Bytes UTF-8 no válidos. Lo emite el ingestor. |
| `line_too_long` | Línea más larga que el lote. Lo emite el ingestor. |

## Diferencias con `audit-log.ps1 -Schema Nuevo`

Medidas ejecutando el auditor sobre `test/fixtures/cases.js`. Las fija `test/parity.test.js`: si aparece una diferencia nueva, o desaparece una de las documentadas, el test falla.

**Decisión de aceptar o rechazar.** En 127 de los 135 casos el auditor y el validador deciden lo mismo. En los 8 restantes el auditor **acepta** y el validador **rechaza**. Es un **endurecimiento deliberado del validador JS**: se rechazan a propósito y el validador no se modifica para aceptarlos.

| Caso | Por qué acepta el auditor |
|---|---|
| `event` con guion blando U+00AD (escapado o literal) o ZWJ U+200D escapado | `-ccontains` compara con reglas de cultura e ignora los caracteres ignorables. Como `$extra[$ev]` no existe, el auditor deja pasar el evento solo con los campos comunes. |
| Valor entre comillas simples (`'Stop'`) | `ConvertFrom-Json` de PowerShell 5.1 (JavaScriptSerializer) admite JSON no estándar. |
| NBSP antes del objeto, NEL (U+0085) entre tokens | Lo mismo: el parser admite espacios Unicode fuera del JSON estricto. |
| Entero con ceros a la izquierda (`01`) o con `+` (`+1`) | Lo mismo: los convierte en enteros. |

**Coincidencias que no son obvias:** `-0` se acepta en los dos y se guarda como `0`. `1.0`, `1e3` y `0e0` se rechazan en los dos.

**Diferencias de formato, no de decisión:**

- El auditor cuenta incidencias. El validador devuelve un único código por línea. En T0-F, L3 da dos incidencias en el auditor (`incidencias=9`) y un solo rechazo en el validador (8 rechazos).
- El auditor cuenta líneas según `ReadLines`, que también corta en un CR suelto. El ingestor solo corta en `\n` y rechaza la línea con `line_break`. La decisión es la misma, pero cambian la numeración y el recuento.
- El auditor no limita la longitud de línea ni el anidamiento. El validador rechaza a partir de 1 MiB (configurable) y de 100 niveles. Una línea válida no se acerca a esos límites salvo que lleve espacios de relleno.
- UTF-8 inválido: el ingestor lo rechaza con `invalid_utf8`. Se supone que el auditor lo sustituye por U+FFFD (comportamiento por defecto de .NET), pero no se ha medido.

**Consecuencia de las diferencias:** un hook podría escribir una línea que pase T0-N y que el backend rechace. Eso no expone información sensible, pero el evento se pierde y queda contado en `ingest_reject`.

## Riesgos conocidos

- Identidad física, truncamiento, movimiento y `sourceId`: ver «Identidad física del archivo y portabilidad». En resumen, la detección de sustituciones y truncamientos es parcial, y solo está comprobada en Windows NTFS local. No se guarda ningún hash del contenido para no almacenar datos derivados del registro.
- Linux, macOS y los demás sistemas de archivos no están validados: los tests no se han ejecutado allí.
- `node:sqlite` en Node 26 sigue evolucionando. Se ha probado con v26.13.0.
- La paridad se ha medido con Windows PowerShell 5.1. PowerShell 7 (`pwsh`) usa otro parser JSON y podría comportarse distinto.

## Deuda técnica

- Las listas de la lista blanca están duplicadas entre `src/validator.js` y `pruebas/audit-log.ps1`. Un test compara la lista blanca con la sección 2, pero no lee el `.ps1`.
- No hay ningún punto de entrada (CLI o servicio) que llame a `ingest`. Queda para H2 o después.
- `journal_mode` es el que trae SQLite por defecto. Cuando haya lectores concurrentes (API, H2+), conviene valorar WAL.
- El texto de las incidencias del auditor se interpreta con una regex sobre `L<n> |` en `parity.test.js`. Si cambia ese formato, el test falla.

---

# H2-B: modelo de identidad y jerarquía (`src/hierarchy.js`)

Deriva sesiones, MAIN, agentes, invocaciones de herramientas, relaciones y anomalías a partir de los eventos que H1 guarda en `event`. No persiste nada, no lee contenido y no modifica H1.

## API pública

```js
import { buildModel, loadModel, LAUNCH_WINDOW_MS } from './src/hierarchy.js';
const model = loadModel(db);        // solo lectura sobre la tabla event
const model2 = buildModel(rows);    // constructor puro: sin SQLite, sin hora, sin azar; no modifica `rows`
```

- `buildModel(events)`: ordena una copia por `(timestamp, source_id, byte_offset)`, así que el resultado no depende del orden de entrada ni de inserción.
- `loadModel(db)`: `SELECT * FROM event ORDER BY timestamp, source_id, byte_offset` y llama a `buildModel`.
- Filas con la misma tripleta de orden (imposible desde SQLite por su `UNIQUE`, posible al llamar a `buildModel` directamente) se desempatan por contenido, así que el resultado tampoco depende del orden de entrada en ese caso.
- `LAUNCH_WINDOW_MS = 5000`: ventana de lanzamiento. **Provisional y no calibrada.**

## Evidencia

| Valor | Significado |
|---|---|
| OBSERVED | Lo demuestra un evento: p. ej. un `agent_id` presente, o `session_id` y `agent_id` juntos. |
| INFERRED | Deducido por reglas. MAIN es siempre INFERRED. |
| UNKNOWN | La evidencia no permite atribuir. Nunca se convierte en MAIN. |

## Identidad

| Entidad | Sin colisión de fuentes | `session_id` en varias fuentes |
|---|---|---|
| Sesión | `session_id` | `session_id` (una sola, con `sources[]` y `SOURCE_COLLISION`) |
| MAIN | por sesión | uno por `(session_id, source_id)` |
| AGENT | `(session_id, agent_id)` | `(session_id, source_id, agent_id)` |
| Invocación | `(session_id, tool_use_id)` | `(session_id, source_id, tool_use_id)` |

- En una sesión colisionada cada fuente es una partición aislada: ninguna regla (agentes, invocaciones, `CONTEXT_CONFLICT`, anomalías, relaciones) lee eventos de otra fuente.
- La clave de invocación no incluye el contexto del agente.
- `agent_type` es un atributo, no un identificador. `none` no significa MAIN.

## Atribución de cada evento (exactamente una categoría)

- `SessionStart` / `SessionEnd`: la sesión (`starts[]`, `ends[]`, todos conservados, nunca anomalía).
- Evento de una invocación con `CONTEXT_CONFLICT`: UNKNOWN. Estos eventos no aportan nada al agente: ni `agent_type`, ni contador, ni primera evidencia, ni `ATTR_CONFLICT`. Un `agent_id` que solo aparece en eventos conflictivos no crea agente ni `SESSION_AGENT`.
- `SubagentStart` / `SubagentStop` sin `agent_id`: UNKNOWN.
- Evento con `agent_id`: AGENT (OBSERVED).
- Resto sin `agent_id`: MAIN (INFERRED). `SessionStart` por sí solo no crea MAIN.

## Relaciones

- `SESSION_AGENT`: OBSERVED, con el primer evento como evidencia y el número de eventos.
- `PARENT_CHILD`: INFERRED o UNKNOWN, nunca OBSERVED. Es INFERRED solo si, dentro de la misma partición, hay un único `PreToolUse(Agent)` a ≤ 5 s del `SubagentStart` (comparación en BigInt exacto, unidades de 100 ns) y un único `SubagentStart` a ≤ 5 s de ese lanzador, y el lanzador no está afectado por `CONTEXT_CONFLICT`.
  - Los autolanzamientos (lanzador cuyo contexto es el propio hijo) se excluyen antes de contar.
  - Los candidatos en conflicto, y los `SubagentStart` sin `agent_id`, sí cuentan para bloquear.
  - Un lanzador sin `tool_use_id` es válido. Si el lanzador es MAIN, la relación tiene doble inferencia.
  - La relación guarda: lanzador, inicio del hijo, contexto del lanzador, `delta_ticks` (cadena), `delta_ms`, `window_ms`, `candidates {launchers, children}` y `causes[]`.
  - Causas de UNKNOWN: `NO_CANDIDATE`, `MULTIPLE_LAUNCHERS`, `MULTIPLE_CHILDREN`, `CONTEXT_CONFLICT`, `LAUNCHER_CONTEXT_UNKNOWN`, `REPEATED_START`.

## Anomalías

`SOLO_START`, `SOLO_STOP`, `REPEATED`, `NEGATIVE_INTERVAL`, `CONTEXT_CONFLICT` (C4), `ATTR_CONFLICT` (`agent_type` en un agente, `tool_name` en una invocación, `project_id` en una sesión) y `SOURCE_COLLISION`. Se aplican a agentes (`SubagentStart`/`SubagentStop`) y a invocaciones (`PreToolUse` frente a `PostToolUse`/`PostToolUseFailure`). Cada anomalía lleva las referencias `{source_id, byte_offset, event, timestamp}` de todas sus evidencias. Los eventos sin `tool_use_id` no se emparejan y no son anomalía. La ausencia de `SessionStart`/`SessionEnd` se ve como lista vacía, sin anomalía. Un intervalo negativo no produce duración.

- `NEGATIVE_INTERVAL`: existe algún Stop (o cierre) anterior a algún Start (o `Pre`) de la misma entidad y partición, comparado en ticks exactos de 100 ns. Timestamps iguales no son negativos. La anomalía lleva todos los eventos de la entidad. No se empareja nada, así que una secuencia Start, Stop, Start, Stop también se marca (no se puede distinguir un reinicio de un Stop anómalo). La duración solo existe con un Start y un Stop no negativos.
- `REPEATED` tiene tres ámbitos: `event` (duplicado exacto: mismo contenido salvo `source_id` y `byte_offset`, en la misma partición; no se elimina ninguno), `agent` e `invocation` (varios Start/Stop o varios Pre/cierres). Si el REPEATED de agente o de invocación solo repite ese mismo evento duplicado, no se emite aparte: queda anotado en `detail.entities` del REPEATED de evento. Con eventos distintos se emite además el suyo. Dos eventos iguales en otro instante no son duplicados.

## C4

`model.counts.context_conflicts` es el número de invocaciones (dentro de su partición) con más de un contexto. Cero significa que no hay ninguno. Los conflictos aparecen en `anomalies` con `code: 'CONTEXT_CONFLICT'`.

## Forma de la salida (resumida)

```js
{ sessions: [{ session_id, project_id, sources, collision, starts, ends, mains: [{ source_id, evidence: 'INFERRED', events }] }],
  agents: [{ session_id, source_id, agent_id, evidence: 'OBSERVED', agent_types, starts, stops, events, duration_ms }],
  invocations: [{ session_id, source_id, tool_use_id, tool_names, pre, closes, contexts, conflict }],
  relations: [{ kind: 'PARENT_CHILD', evidence: 'INFERRED', parent: { kind: 'MAIN', evidence: 'INFERRED' },
                child: { agent_id }, delta_ms: 1000, delta_ticks: '10000000', window_ms: 5000,
                candidates: { launchers: 1, children: 1 }, causes: [] }],
  unknown: [{ source_id, byte_offset, causes }], anomalies: [{ code, scope, detail, refs }],
  counts: { events, context_conflicts, attributed: { SESSION, MAIN, AGENT, UNKNOWN }, anomalies: { SOLO_START: 0 /* ... */ } } }
```

## Limitaciones

- No hay evidencia en el esquema para declarar OBSERVED una relación padre-hijo; la inferencia por tiempo puede fallar (ventana no calibrada).
- No se declara que un agente haya terminado o siga en ejecución. La ausencia de un evento no demuestra que no ocurriera.
- Una reanudación registrada en otra fuente no se enlaza con la sesión original más allá de compartir `session_id`.
- El cruce lanzador/hijo es cuadrático por partición.
- `NEGATIVE_INTERVAL` marca cualquier orden Stop-antes-que-Start sin emparejar, por lo que un reinicio legítimo del mismo `agent_id` también se señala.
- No hay API HTTP, WebSocket, interfaz ni persistencia del modelo; el modelo se recalcula en cada cambio (ver Fase 3).

# Fase 3: servicio, `presence` y diagnóstico

## `src/presence.js`

`presence(model, nowMs, ttl = TTL_MS)` → `{ sessions: [{ session_id, project_id, state, since }], agents: [{ session_id, source_id, agent_id, agent_types, state, since }] }`. Función pura sobre el modelo de H2-B; `since` es el timestamp del evento que decide el estado (o `null`).

El estado sale del último evento significativo de cada actor (MAIN junto con `SessionStart`/`SessionEnd` de la sesión; cada agente con sus propios eventos). `Notification` se ignora.

| Último evento | Estado | Caduca a `STALE` tras |
|---|---|---|
| `SessionEnd` (sesión), `SubagentStop` (agente) | `ENDED` | nunca |
| `PermissionRequest` | `PERMISSION` | 10 min |
| `StopFailure` (turno cerrado con error, p. ej. de la API) | `ERROR` | 24 h |
| `SessionStart`, `Stop`, ninguno | `IDLE` | 24 h |
| Cualquier otro (`UserPromptSubmit`, herramientas, `SubagentStart`…) | `WORKING` | 30 min |

- Un agente de una sesión `ENDED` también queda `ENDED`. El `Stop` del padre no afecta a sus agentes (llega antes que sus `SubagentStop`).
- Las caducidades (`TTL_MS`) están aprobadas, pero no calibradas con uso real. Un permiso rechazado y uno todavía pendiente son indistinguibles: ambos pasan a `STALE`.

## `src/service.js`

`startService({ dbPath, sourceId, path, onModel, onError, pollMs = 500, retentionDays = 30 })` → `{ stop() }`.

- Activa WAL. Vigila `path` con `fs.watch` y además sondea cada `pollMs` (cubre un archivo aún sin crear o un vigilante caído).
- Llama a `onModel(loadModel(db))` al arrancar y cada vez que la ingesta o la retención cambian algo. `onError(code)` recibe solo códigos fijos (`IngestError` o `SERVICE_FAILED`), una vez por cambio de código; el servicio sigue sondeando.
- Retención `prune(db, nowMs, days)`: al arrancar y cada hora borra las **sesiones completas** cuyo último evento es anterior al corte. Los rechazos se conservan. `RETENTION_DAYS = 30` (aprobado).
- Medido en los tests: 1–4 ms entre añadir la línea y recibir el modelo. Con el hook real: ≤ ~10 ms (21 eventos).

## `src/cli.js` (diagnóstico)

```powershell
node src/cli.js --db <ruta.db> [--source <ruta.jsonl> [--watch]]
```

Imprime en JSON solo recuentos: eventos, rechazos por código, sesiones, agentes, anomalías y estados de `presence`. Con `--source` ingiere antes (`sourceId` = `hooks`); con `--watch` arranca el servicio (que **aplica la retención**) e imprime una línea por cambio. Los errores salen como código fijo.
