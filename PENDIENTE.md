# PENDIENTE — Frasevo Code Intel

**Fecha:** 2026-10-27

**Rama de integración:** `develop`  
**Contrato de entregas:** una rama `feat/ci-XX-*` y un commit coherente por core; PR hacia `develop`; tras el merge, eliminar la rama local y remota. **Prohibido integrar en `main` hasta una nueva autorización expresa.**

## Cores

| Core | Estado | Entrega principal |
| --- | --- | --- |
| CI-01 | Terminado | Escaneo offline, snapshot `code-snapshot/v1`, importación de inventario genérico, validación y tests. |
| CI-02 | Terminado | Análisis AST TypeScript, grafo `code-graph/v1`, imports y consumidores inversos. |
| CI-03 | Terminado | Catálogo estático Next.js `api-catalog/v1`, métodos declarados, trazabilidad de reexports y semántica `unknown`. |
| CI-04 | Terminado; CI Node 24 validada | Referencias Markdown/MDX `doc-trace/v1`, encabezados, enlaces a archivos y rutas API, CLI y pruebas. |
| CI-05 | CI-05A/B/C terminados; CI Node 24 validada | Selección acotada, fragmentos verificados, CLI offline y contrato `context-query/v1`. |
| CI-06 | CI-06A1/A2, CI-06B1 y CI-06V1 validados en Node 24; CI-06V2 aporta smoke CLI independiente; CI-06B2 pendiente | Reutilización AST por SHA-256, hashing concurrente, MCP local y CI-06V1 instalación reproducible. La prueba MCP con clientes reales sigue abierta. |

## Último core implementado: CI-05 — Contexto recuperable y citado

- **CI-05A — IMPLEMENTADO:** selector `selectContext()` sobre artefactos v1 validados y coherentes; búsqueda por ruta/palabra, relaciones import/consumer y enlaces Markdown resueltos; profundidad 0–2, máximos 50 resultados y 64 KiB por respuesta. Sin acceso al árbol del repositorio.
- **CI-05B — IMPLEMENTADO:** paquetes privados de evidencia con fragmentos posicionados y hash SHA-256 comprobado frente al snapshot; estados `indexed`, `unknown`, `not-checked`; límites independientes de líneas, caracteres, ficheros y bytes.
- **CI-05C — IMPLEMENTADO:** comandos `context-select`, `context-evidence` y `context-validate`; contrato JSON `context-query/v1` con fingerprint SHA-256 canónico; validación de entradas y salidas; tres pruebas adicionales.

**CI-05A/B/C — criterios cubiertos:** (1) resultados reproducibles con fuente y posición; (2) contenido solo tras verificar bytes, hash y ruta, y `unknown`/`not-checked` ante falta de evidencia; (3) presupuestos de lectura y salida. **Pruebas:** CI-05A 3 casos, CI-05B 3 casos, CI-05C 3 casos nuevos; incluidos en la suite 44/44 validada con Node 24 en Ubuntu y Windows (evidencia CI-06V1 debajo).

## CI-06 — Rendimiento e integración opcional

- **CI-06A1 — IMPLEMENTADO:** `graph-incremental` reutiliza nodos, relaciones y diagnósticos AST de ficheros sin cambios SHA-256 frente a un snapshot/grafo anteriores validados; admite `--invalidate-path`; ante altas/bajas de fuentes TS/JS, cambios JSON o versión distinta, hace reanálisis completo. La salida sigue siendo `code-graph/v1`, con misma huella que una ejecución completa. Cuatro pruebas añadidas (suite: 38/38, Node 22 experimental). Primera iteración: 0.6.0.
- **CI-06A2 — IMPLEMENTADO (0.6.1):** hashing limitado a cuatro operaciones simultáneas y poda anticipada de rutas excluidas; enumeración completa de directorios permitidos y SHA-256 fresco de todos los archivos incluidos. Sin cachear el inventario por `mtime` ni afirmar que se omite el recorrido. Tres pruebas nuevas (suite: 41/41 en Node 22 experimental). Criterios: (1) mismos contratos y resultados estables; (2) altas/bajas/ediciones y límites detectados; (3) mejora de rendimiento medida localmente. **No es un escaneo incremental del árbol.**
- **CI-06B1 — IMPLEMENTADO (0.6.2):** adaptador MCP `stdio` local mínimo y sin dependencias nuevas, compatible con la generación 2025-11-25: inicialización, lista de herramientas y consultas `context-query/v1` de solo lectura; evidencia en bruto deshabilitada salvo `--allow-evidence` explícito; raíz e índices fijados en CLI, sin capacidad de reconfiguración remota. Tres pruebas nuevas. Sin agentes ni LLM dentro del indexador.
- **CI-06B2 — PENDIENTE de decisión/validación:** integración mediante el SDK MCP oficial v2, negociación del protocolo moderno 2026-07-28 y prueba con clientes externos reales; no asumir compatibilidad moderna ni soporte general MCP para CI-06B1.
- Mantener la división por entregas pequeñas, tres criterios de aceptación como máximo; sin tareas de MCP en CI-06A.

**Medición CI-06A2:** 400 archivos TS sintéticos, ocho mediciones emparejadas tras tres calentamientos en Node 22: mediana escáner anterior ~272 ms, nuevo ~85 ms. No incluye análisis AST; resultados orientativos, dependientes de hardware/IO. **Se siguen hasheando todos los archivos admitidos.**

**Medición CI-06A1:** repositorio sintético temporal de 100 archivos TS con 25 funciones por archivo y modificación en uno. Mediana local con Node 22 sobre cuatro ejecuciones tras dos calentamientos: grafo completo ~119 ms, incremental ~89 ms, 99 AST reutilizados/1 parseado; mismo `artifactId`. Referencia orientativa, no benchmark reproducible bajo CI ni garantía general. **El snapshot sigue enumerando y calculando SHA-256 de todos los archivos.**

## Validaciones pendientes

- Probar manualmente el MCP de 2025 frente a un cliente real con fallback y comprobar su consentimiento antes de permitir lectura de fragmentos; verificar que `stdout` contiene exclusivamente JSON-RPC.
- Ampliar la validación interactiva de `docs-target`, `context-select` y `context-evidence` a un repositorio externo no sintético. CI-06V2 añade una prueba automatizada con la CLI como proceso independiente, fixtures externas y artefactos fuera del checkout; no sustituye la validación en proyectos reales.
- Evaluar rendimientos en repositorios grandes y en sistemas Windows/red, con cambios de `tsconfig.json`. CI-06A1 reduce trabajo AST y CI-06A2 acelera el hashing de I/O, pero **ambos siguen recorriendo y hasheando toda fuente incluida**; CI-05A/B/C verifican cuatro índices y CI-04 reescanea parcialmente la fuente.

## CI-06V1 — Instalación reproducible y evidencia Node 24

**IMPLEMENTADO.** Fase limitada al workflow, las instrucciones de instalación y el estado del pendiente; sin cambiar dependencias, contratos ni código del indexador. Rollback: revertir el commit de esta fase.

1. Instalar desde `package-lock.json` mediante `npm ci --ignore-scripts --no-audit --no-fund` en la matriz existente Ubuntu/Windows, sin resolver ni reescribir el lockfile con `npm install`.
2. Registrar versiones de Node/npm antes de instalar y conservar typecheck y suite completa como checks obligatorios del workflow.
3. Sustituir el pendiente de validación Node 24 por evidencia comprobada, manteniendo abiertas las pruebas manuales y con clientes MCP reales.

**Evidencia base:** [CI de `develop`, ejecución 40391442477](https://github.com/Frasevo/frasevo-code-intel/actions/runs/40391442477), commit `8d2bc8691046ab7aad259dbcf13b1a2a83789484`: typecheck PASS y **44/44 tests, cero omitidos**, en Ubuntu y Windows con Node 24. Esa ejecución utilizó `npm install`; no demuestra por sí sola instalación congelada en ambos sistemas.

**Verificación local de esta fase:** Node 24.22.1, npm 11.9.0; `npm ci --ignore-scripts --no-audit --no-fund`, `npm run typecheck` y `npm test` PASS (44/44). La matriz del PR de CI-06V1 registra versiones y comprueba instalación congelada, typecheck y tests en Ubuntu y Windows. PR [#11](https://github.com/Frasevo/frasevo-code-intel/pull/11) fusionada en `develop` (commit `f1647c881345f00392a744012acbde13e4552cf6`); [CI 40596472060](https://github.com/Frasevo/frasevo-code-intel/actions/runs/40596472060) PASS en Ubuntu/Windows. La rama de trabajo antigua puede eliminarse; las validaciones MCP con clientes externos siguen abiertas.

## CI-06V2 — Prueba integrada de CLI como proceso

**IMPLEMENTACIÓN:** `tests/cli-process.test.ts` ejecuta con Node 24 la CLI real sobre un repositorio sintético creado en un directorio temporal con espacios. Genera snapshot, grafo, catálogo API y referencias documentales, consulta `docs-target`, recupera y valida contexto/evidencia, verifica fragmentos citados y rechaza salidas dentro del repositorio fuente.

**Aceptación (3):** (1) todos los comandos se ejecutan como procesos independientes con códigos de salida verificados; (2) los artefactos y referencias son coherentes y no incluyen rutas absolutas; (3) el repositorio fuente permanece sin modificar, incluso ante un destino prohibido. No añade dependencias ni cambia contratos.

**Validación:** pendiente de comprobar los checks del PR en Ubuntu y Windows Node 24 antes de fusionar a `develop`. La compatibilidad MCP con clientes externos sigue siendo CI-06B2.

## Reglas técnicas

- Sin analizar secretos, rutas prohibidas, enlaces simbólicos, archivos grandes o carpetas excluidas; nunca publicar artefactos privados.
- Ningún LLM debe afirmar falsamente que un endpoint está probado, un enlace funciona en producción o la autenticación es efectiva. Lo no demostrado es `unknown`.
- No implementar componentes redundantes: reutilizar los contratos y el análisis existente. No ejecutar código, herramientas o scripts del repositorio objetivo.
- Versionar contratos JSON independientemente; preservar compatibilidad de `code-snapshot/v1`, `code-graph/v1` y `api-catalog/v1`.
- Fases acotadas, máximo tres criterios de aceptación por core y separar siempre desarrollo de validación; no añadir pruebas repetidas ni código no esencial para forzar el cierre de un core.
