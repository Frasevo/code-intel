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
| CI-05 | CI-05A/B implementados; CI-05C pendiente | Selección offline acotada y fragmentos verificados; pendiente de API CLI y contrato público. |
| CI-06 | Pendiente de desarrollo | Indexación incremental, reducción de recomputación y MCP opcional de solo lectura. |

## Core activo: CI-05 — Contexto recuperable y citado

- **CI-05A — IMPLEMENTADO:** selector `selectContext()` sobre artefactos v1 validados y coherentes; búsqueda por ruta/palabra, relaciones import/consumer y enlaces Markdown resueltos; profundidad 0–2, máximos 50 resultados y 64 KiB por respuesta. Sin acceso al árbol del repositorio.
- **CI-05B — IMPLEMENTADO:** paquetes privados de evidencia con fragmentos posicionados y hash SHA-256 comprobado frente al snapshot; estados `indexed`, `unknown`, `not-checked`; límites independientes de líneas, caracteres, ficheros y bytes.
- **CI-05C — API CLI/contrato:** interfaz de consultas estructuradas, respuesta versionada, pruebas de estabilidad, entradas adversariales y documentación de límites.

**CI-05A/B — criterios cubiertos:** (1) resultados reproducibles con fuente y posición; (2) contenido solo tras verificar bytes, hash y ruta, y `unknown`/`not-checked` ante falta de evidencia; (3) presupuestos de lectura y salida. **Pruebas:** CI-05A 3 casos y CI-05B 3 casos nuevos; ejecutar CI con Node 24 antes de considerar validadas las entregas.

## Siguiente subcore: CI-05C — CLI y contrato versionado

- Definir una respuesta JSON versionada y verificable para consultas de contexto y evidencia, sin alterar contratos v1 anteriores.
- Añadir comandos CLI de consulta offline que lean artefactos existentes, con restricciones de rutas, presupuestos y salida fuera del repositorio.
- Pruebas de estabilidad, límites y entradas adversariales; documentación del formato y de las garantías excluidas.

## Validaciones pendientes

- Ejecutar `npm ci --ignore-scripts --no-audit --no-fund`, `npm run typecheck` y `npm test` con Node.js 24 en Ubuntu y Windows tras integrar CI-05A/B en `develop`.
- Verificar manualmente consultas `docs-target`, `selectContext` y `buildEvidencePack` con un repositorio de prueba independiente, manteniendo los artefactos fuera de su raíz.
- Evaluar el rendimiento en repositorios grandes. CI-05A/B verifican los cuatro índices cada vez; CI-04 reescanea parcialmente la fuente. Optimización reservada para CI-06.

## Reglas técnicas

- Sin analizar secretos, rutas prohibidas, enlaces simbólicos, archivos grandes o carpetas excluidas; nunca publicar artefactos privados.
- Ningún LLM debe afirmar falsamente que un endpoint está probado, un enlace funciona en producción o la autenticación es efectiva. Lo no demostrado es `unknown`.
- No implementar componentes redundantes: reutilizar los contratos y el análisis existente. No ejecutar código, herramientas o scripts del repositorio objetivo.
- Versionar contratos JSON independientemente; preservar compatibilidad de `code-snapshot/v1`, `code-graph/v1` y `api-catalog/v1`.
- Fases acotadas, máximo tres criterios de aceptación por core y separar siempre desarrollo de validación; no añadir pruebas repetidas ni código no esencial para forzar el cierre de un core.
