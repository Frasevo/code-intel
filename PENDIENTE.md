# PENDIENTE — Frasevo Code Intel

**Fecha:** 2026-10-26  
**Rama de integración:** `develop`  
**Contrato de entregas:** una rama `feat/ci-XX-*` y un commit coherente por core; PR hacia `develop`; tras el merge, eliminar la rama local y remota. **Prohibido integrar en `main` hasta una nueva autorización expresa.**

## Cores

| Core | Estado | Entrega principal |
| --- | --- | --- |
| CI-01 | Terminado | Escaneo offline, snapshot `code-snapshot/v1`, importación de inventario genérico, validación y tests. |
| CI-02 | Terminado | Análisis AST TypeScript, grafo `code-graph/v1`, imports y consumidores inversos. |
| CI-03 | Terminado | Catálogo estático Next.js `api-catalog/v1`, métodos declarados, trazabilidad de reexports y semántica `unknown`. |
| CI-04 | Implementado; pendiente de validar en CI Node 24 | Referencias Markdown/MDX `doc-trace/v1`, encabezados, enlaces a archivos y rutas API, CLI y pruebas. |
| CI-05 | CI-05A/B/C implementados; pendiente validar en CI Node 24 | Selección acotada, fragmentos verificados, CLI offline y contrato `context-query/v1`. |
| CI-06 | CI-06A1/A2 implementados; CI-06B pendiente de decisión | Reutilización AST por SHA-256, escaneo con hashing concurrente y verificación completa; MCP opcional. |

## Último core implementado: CI-05 — Contexto recuperable y citado

- **CI-05A — IMPLEMENTADO:** selector `selectContext()` sobre artefactos v1 validados y coherentes; búsqueda por ruta/palabra, relaciones import/consumer y enlaces Markdown resueltos; profundidad 0–2, máximos 50 resultados y 64 KiB por respuesta. Sin acceso al árbol del repositorio.
- **CI-05B — IMPLEMENTADO:** paquetes privados de evidencia con fragmentos posicionados y hash SHA-256 comprobado frente al snapshot; estados `indexed`, `unknown`, `not-checked`; límites independientes de líneas, caracteres, ficheros y bytes.
- **CI-05C — IMPLEMENTADO:** comandos `context-select`, `context-evidence` y `context-validate`; contrato JSON `context-query/v1` con fingerprint SHA-256 canónico; validación de entradas y salidas; tres pruebas adicionales.

**CI-05A/B/C — criterios cubiertos:** (1) resultados reproducibles con fuente y posición; (2) contenido solo tras verificar bytes, hash y ruta, y `unknown`/`not-checked` ante falta de evidencia; (3) presupuestos de lectura y salida. **Pruebas:** CI-05A 3 casos, CI-05B 3 casos, CI-05C 3 casos nuevos; suite completa 34/34 (Node 22 con flag experimental); ejecutar CI con Node 24 antes de considerar cerrada la validación de integración.

## CI-06 — Rendimiento e integración opcional

- **CI-06A1 — IMPLEMENTADO:** `graph-incremental` reutiliza nodos, relaciones y diagnósticos AST de ficheros sin cambios SHA-256 frente a un snapshot/grafo anteriores validados; admite `--invalidate-path`; ante altas/bajas de fuentes TS/JS, cambios JSON o versión distinta, hace reanálisis completo. La salida sigue siendo `code-graph/v1`, con misma huella que una ejecución completa. Cuatro pruebas añadidas (suite: 38/38, Node 22 experimental). Primera iteración: 0.6.0.
- **CI-06A2 — IMPLEMENTADO (0.6.1):** hashing limitado a cuatro operaciones simultáneas y poda anticipada de rutas excluidas; enumeración completa de directorios permitidos y SHA-256 fresco de todos los archivos incluidos. Sin cachear el inventario por `mtime` ni afirmar que se omite el recorrido. Tres pruebas nuevas (suite: 41/41 en Node 22 experimental). Criterios: (1) mismos contratos y resultados estables; (2) altas/bajas/ediciones y límites detectados; (3) mejora de rendimiento medida localmente. **No es un escaneo incremental del árbol.**
- **CI-06B — PENDIENTE de decisión técnica:** estudiar un adaptador MCP de solo lectura para consultas a `context-query/v1`, con permisos explícitos; sin agente ni LLM dentro del indexador.
- Mantener la división por entregas pequeñas, tres criterios de aceptación como máximo; sin tareas de MCP en CI-06A.

**Medición CI-06A2:** 400 archivos TS sintéticos, ocho mediciones emparejadas tras tres calentamientos en Node 22: mediana escáner anterior ~272 ms, nuevo ~85 ms. No incluye análisis AST; resultados orientativos, dependientes de hardware/IO. **Se siguen hasheando todos los archivos admitidos.**

**Medición CI-06A1:** repositorio sintético temporal de 100 archivos TS con 25 funciones por archivo y modificación en uno. Mediana local con Node 22 sobre cuatro ejecuciones tras dos calentamientos: grafo completo ~119 ms, incremental ~89 ms, 99 AST reutilizados/1 parseado; mismo `artifactId`. Referencia orientativa, no benchmark reproducible bajo CI ni garantía general. **El snapshot sigue enumerando y calculando SHA-256 de todos los archivos.**

## Validaciones pendientes

- Ejecutar `npm ci --ignore-scripts --no-audit --no-fund`, `npm run typecheck` y `npm test` con Node.js 24 en Ubuntu y Windows tras integrar CI-05/06 en `develop`.
- Verificar manualmente consultas `docs-target`, `selectContext` y `buildEvidencePack` y los comandos `context-select`/`context-evidence` con un repositorio de prueba independiente, manteniendo los artefactos fuera de su raíz.
- Evaluar rendimientos en repositorios grandes y en sistemas Windows/red, con cambios de `tsconfig.json`. CI-06A1 reduce trabajo AST y CI-06A2 acelera el hashing de I/O, pero **ambos siguen recorriendo y hasheando toda fuente incluida**; CI-05A/B/C verifican cuatro índices y CI-04 reescanea parcialmente la fuente.

## Reglas técnicas

- Sin analizar secretos, rutas prohibidas, enlaces simbólicos, archivos grandes o carpetas excluidas; nunca publicar artefactos privados.
- Ningún LLM debe afirmar falsamente que un endpoint está probado, un enlace funciona en producción o la autenticación es efectiva. Lo no demostrado es `unknown`.
- No implementar componentes redundantes: reutilizar los contratos y el análisis existente. No ejecutar código, herramientas o scripts del repositorio objetivo.
- Versionar contratos JSON independientemente; preservar compatibilidad de `code-snapshot/v1`, `code-graph/v1` y `api-catalog/v1`.
- Fases acotadas, máximo tres criterios de aceptación por core y separar siempre desarrollo de validación; no añadir pruebas repetidas ni código no esencial para forzar el cierre de un core.
