# Claude Office

Aplicación de escritorio que muestra la actividad de Claude Code (sesiones, agentes y subagentes) como una oficina virtual en pixel art 2D. Solo usa los **hooks** oficiales de Claude Code: no llama a la API de Anthropic ni consume tokens adicionales.

La privacidad es el requisito principal. Los hooks escriben un registro JSONL con una lista blanca estricta de campos por evento y el backend rechaza cualquier línea con campos fuera de esa lista. No se guardan prompts, entradas ni salidas de herramientas, y la ruta de cada proyecto no se guarda en la base de datos ni en el registro: solo un identificador derivado (`project_id`).

## Cómo funciona

```
hook → registro JSONL → ingesta (validación) → SQLite → modelo de jerarquía → estado (presence) → IPC → escena Phaser
```

1. Un hook global de Claude Code añade una línea por evento al registro `hooks-events.jsonl`.
2. El proceso de servicio de Electron valida cada línea, guarda en SQLite solo las válidas y calcula el modelo (sesiones, agente principal, subagentes, herramientas, anomalías).
3. El proceso principal envía el estado al renderer por IPC (sin puerto local ni WebSocket) y la escena lo dibuja.

## Estructura del repositorio

| Ruta | Contenido |
|---|---|
| [app/](app/) | Aplicación Electron: proceso principal (`main/`), renderer en TypeScript con Phaser 3 y Tailwind 4 vía Vite (`src/`), y los hooks (`hook/`). |
| [backend/](backend/) | Núcleo sin dependencias en Node.js: validador, ingesta SQLite, modelo de jerarquía, `presence`, servicio y CLI de diagnóstico. Detalle técnico en [backend/README.md](backend/README.md). |
| [app/hook/](app/hook/) | Hook global: `capture-event.ps1` (Windows, PowerShell 5.1) y `capture-event.mjs` (macOS y Linux). |
| [backend/tools/audit-log.ps1](backend/tools/audit-log.ps1) | Auditor del registro con la lista blanca de referencia (PowerShell 5.1). Lo usan los tests de paridad. |
| [.github/workflows/ci.yml](.github/workflows/ci.yml) | CI: tests del backend y de la app y comprobación de tipos en Windows, Ubuntu y macOS. |

## Requisitos

- **Node.js 26 o superior** para el backend y los tests (`engines` de [backend/package.json](backend/package.json)). El backend usa `node:sqlite`, `node:test` y `node:fs`.
- **Windows PowerShell 5.1** para el hook en Windows y para los tests de paridad del backend (sin él, esos tests se omiten).
- Dependencias de la app (Electron, Vite, Phaser, Tailwind, TypeScript): se instalan con `npm ci` en `app/`.

## Puesta en marcha

Desde la carpeta `app/`:

```powershell
cd app
npm ci
npm start          # vite build && electron .
```

Después, en la ventana, abre el botón **Panel**:

1. **Hook global**: instala el hook en la configuración de Claude Code (`settings.json`, en `CLAUDE_CONFIG_DIR` si está definida; si no, en `.claude` del directorio personal). La app hace una copia `.bak` antes de escribir y solo toca las entradas que apuntan a su propio hook.
2. **Proyectos**: cada proyecto nuevo aparece como pendiente. Hasta que lo actives, el hook no registra nada de él; si lo excluyes, tampoco.

Cada proyecto se elige con el desplegable de la cabecera: hay una oficina por proyecto.

**Dónde se guardan los datos**

| Qué | Dónde |
|---|---|
| Política por proyecto (`pending`, `enabled`, `excluded`), hook instalado y registro JSONL | `ClaudeOffice` dentro del directorio de datos de aplicación del sistema (`%APPDATA%\ClaudeOffice` en Windows) |
| Base de datos SQLite | `claude-office.db` en la carpeta `userData` de Electron |

La retención por defecto es de 30 días: el servicio borra las sesiones completas cuyo último evento es anterior.

**Aviso:** si `ELECTRON_RUN_AS_NODE=1` está definida en el entorno, `Claude Office.exe` sale con código 9 sin abrir ventana. Elimina la variable antes de ejecutar la aplicación.

### Instalar la aplicación (Windows)

Si tienes el instalador `Claude Office Setup <versión>.exe`:

1. Ejecútalo. Es un instalador NSIS, no de un solo clic, y se instala solo para el usuario actual (sin permisos de administrador).
2. Abre **Claude Office**.
3. Pulsa **Panel** y, en **Hook global**, pulsa **Instalar**. Así se añaden las entradas del hook a `settings.json` de Claude Code.
4. Abre Claude Code en un proyecto. Ese proyecto aparece en **Proyectos** como pendiente: actívalo para que empiece a mostrarse.

**Desinstalar:** desinstala la aplicación desde la configuración de Windows. El desinstalador:

- quita las entradas del hook de `settings.json`, su copia `settings.json.claude-office.bak` y el script instalado;
- pregunta si quieres borrar también los datos (registro de eventos, proyectos, `install.key` y base de datos). En una desinstalación silenciosa (`/S`) se conservan;
- si no puede quitar el hook (por ejemplo, porque `settings.json` no es JSON válido), avisa y no borra los datos.

Al actualizar a una versión nueva no se toca nada de esto.

Si solo quieres dejar de registrar actividad sin desinstalar la app, pulsa **Desinstalar** en **Panel → Hook global**.

La app guarda una sola copia de seguridad de `settings.json` (`settings.json.claude-office.bak`) con el estado anterior al último cambio. Al escribir, borra las copias con fecha que dejaban las versiones anteriores.

### macOS y Linux

No hay desinstalador que quite el hook. Antes de borrar la aplicación, pulsa **Desinstalar** en **Panel → Hook global**. Si no, `settings.json` seguirá llamando al hook. Los datos están en `ClaudeOffice` y en la carpeta `userData` de la app, dentro del directorio de datos de aplicación del sistema.

### Generar el instalador (desarrollo)

Desde `app/`:

```powershell
npm run dist        # empaqueta sin instalador (electron-builder --dir)
npm run installer   # genera el instalador; la salida va a app/release/
```

La configuración de `electron-builder` ([app/package.json](app/package.json)) declara NSIS para Windows, `dmg` para macOS y `deb` para Linux. El backend se copia como recurso extra (`backend/src`). Solo se ha probado el instalador de Windows.

## Pruebas

```powershell
cd backend; npm test     # 106 tests (3 de paridad requieren powershell.exe)
cd app; npm test         # tests de la app
cd app; npm run typecheck
```

Los tests usan solo fixtures sintéticos, con una marca (`ZZSECRETO7Q`) que no debe aparecer en ninguna salida. Nunca leen el registro real.

## Estado y limitaciones

- Probado de forma manual en Windows 11 con NTFS local. Hay hook y CI para macOS y Linux, pero no se ha probado la aplicación completa ni su empaquetado en esos sistemas.
- La detección de sustitución y truncamiento del archivo de origen es parcial. En una única medición en CI, ext4 no detectó el borrado y recreado del registro (el inodo se reutilizó) y APFS sí. Detalle en [backend/README.md](backend/README.md).
- La relación padre-hijo entre agentes es una inferencia por tiempo (ventana de 5 s sin calibrar), nunca una observación. Varios subagentes lanzados con menos de 5 s de diferencia quedan sin atribuir.
- El hook de macOS y Linux no usa mutex y no es adecuado para discos de red.
- Los tiempos de caducidad de los estados (`presence`) están fijados pero no calibrados con uso real.
- `node:sqlite` sigue evolucionando; el backend se ha probado con Node 26.13.0 y con el Node que trae Electron 45.

## Licencia

Código y arte bajo licencia [MIT](LICENSE). Los avisos de las dependencias están en [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Claude Office es un proyecto independiente, no afiliado, patrocinado ni respaldado por Anthropic. Claude y Claude Code son marcas de Anthropic, PBC. Su interfaz es de creación propia, inspirada en el concepto de Pixel Agents, sin código ni arte suyo.
