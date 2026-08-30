# Cleanup of Remaining "Alice" References

Te comento lo que encontré al revisar el repositorio con respecto a los archivos y directorios que aún contienen "alice", y cómo afectan el proyecto:

1. **Directorios y cachés huérfanos/sin trackear (`alice_cli`, `plugins/alice-achievements`, `.alice`, `alice_agent.egg-info`, `__pycache__`)**
   - **Efecto:** Ninguno a nivel de código fuente. Son remanentes de compilación o de ejecuciones anteriores (el IDE los detecta porque busca en todo el disco, pero Git ya no los sigue).
   - **Acción:** Los eliminaré para limpiar el entorno y que dejen de aparecer en tu IDE.

2. **Error de Git en el renombrado de `ui-tui/packages/alice-ink`**
   - **Efecto:** Hubo un error durante un renombrado masivo reciente (`git mv`), lo que provocó que el directorio `alice-ink` terminara **anidado** dentro de `alice-ink` (es decir, `ui-tui/packages/alice-ink/alice-ink/...`). Esto sí está trackeado por Git y puede romper el build de la interfaz TUI.
   - **Acción:** Usaré comandos de git para mover el contenido a su lugar correcto (`ui-tui/packages/alice-ink`) y borrar el directorio `alice-ink` que quedó como contenedor.

3. **Referencias en código (`alice_constants.py`)**
   - **Efecto:** Hay algunas referencias a `~/.alice` que se dejaron a propósito para asegurar compatibilidad hacia atrás (por ejemplo, detectar la ruta antigua y migrar su contenido a `~/.alice`).
   - **Acción:** No las tocaré, ya que son intencionales y necesarias para no romper instalaciones existentes de usuarios.

4. **Archivos de los Skills (Gitea, Gitlab, Remote SSH, etc.)**
   - **Efecto:** Múltiples skills aún intentan leer variables como `_alice_env`, `ALICE_HOME_LEGACY` o usan nombres como `alice-agent`. Esto afectaría su ejecución si el usuario usa un entorno de Alice limpio, ya que buscarían configuraciones en rutas incorrectas.
   - **Acción:** Modificaré los `.md` y `.sh` de estos skills para usar los nombres correctos (`alice_env`, `ALICE_HOME`, `alice-agent`), tal y como solicitaste ("sí o sí").

5. **Pruebas y Documentación (`tests/website/...`)**
   - **Efecto:** Algunos tests y documentaciones generadas apuntan al comando antiguo `alice skills reset`.
   - **Acción:** Se actualizarán para usar `alice`.

## User Review Required
Por favor, revisa el plan. Si estás de acuerdo en que modifique los skills y mueva/borre los directorios basura que causan ruido en el IDE, aprobalo y procederé.

## Proposed Changes

### Limpieza de Directorios Basura
- **[DELETE]** `alice_cli/`
- **[DELETE]** `plugins/alice-achievements/`
- **[DELETE]** `alice_agent.egg-info/`
- **[DELETE]** `alice_find.txt` y `alice_grep.txt`

### Arreglo de TUI (alice-ink -> alice-ink)
- Se ejecutará `git mv ui-tui/packages/alice-ink/alice-ink ui-tui/packages/alice-ink_temp` y luego se reemplazará la carpeta correctamente para solucionar el error de anidación.

### Skills
- **[MODIFY]** `skills/gitea/codebase-inspection/SKILL.md`
- **[MODIFY]** `skills/gitea/gitea-auth/SKILL.md` (y su script `tea-env.sh`)
- **[MODIFY]** `skills/gitea/gitea-code-review/SKILL.md`
- **[MODIFY]** `skills/gitea/gitea-issues/SKILL.md`
- **[MODIFY]** `skills/gitea/gitea-pr-workflow/SKILL.md`
- **[MODIFY]** `skills/gitea/gitea-repo-management/SKILL.md`
- **[MODIFY]** `skills/gitlab/...` (y scripts equivalentes)
- **[MODIFY]** `skills/software-development/remote-vm-ssh/remote-vm-ssh.md`

### Pruebas
- **[MODIFY]** `tests/website/test_generate_skill_docs.py`

## Verification Plan
1. Ejecutar `git status` para asegurar que el cambio de `ui-tui/packages/alice-ink` se haya reflejado como renombrado limpio.
2. Hacer un último `grep -i alice` (ignorando `.git` y variables intencionales) para validar que el IDE dejará de mostrar ruido innecesario y que los skills quedaron actualizados.
