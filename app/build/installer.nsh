; Desinstalación en Windows (electron-builder la incluye con nsis.include). Se ejecuta antes de borrar $INSTDIR,
; con la aplicación ya cerrada. En las actualizaciones (isUpdated) no se toca nada.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; La propia aplicación quita sus entradas de settings.json, sus copias .bak y el hook instalado (main.js, --uninstall-hook).
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --uninstall-hook' $0
    ${if} $0 != 0
      ; Sin el hook quitado no se borran los datos: el script debe seguir existiendo mientras settings.json lo llame.
      MessageBox MB_OK|MB_ICONEXCLAMATION "No se pudo quitar el hook de Claude Code de settings.json. Quita a mano las entradas que apuntan a ClaudeOffice\hook, o reinstala Claude Office y pulsa «Desinstalar» en Panel → Hook global." /SD IDOK
    ${else}
      ; En una desinstalación silenciosa (/S) se conservan los datos.
      MessageBox MB_YESNO|MB_ICONQUESTION "¿Borrar también los datos de Claude Office (registro de eventos, proyectos y base de datos)?" /SD IDNO IDNO co_keep_data
        RMDir /r "$APPDATA\ClaudeOffice"
        ; Carpeta userData de Electron (base de datos): los mismos nombres que borra la plantilla con --delete-app-data.
        RMDir /r "$APPDATA\${APP_FILENAME}"
        !ifdef APP_PRODUCT_FILENAME
          RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
        !endif
        !ifdef APP_PACKAGE_NAME
          RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
        !endif
      co_keep_data:
    ${endif}
  ${endif}
!macroend
