# PENDIENTE — Frasevo Code Intel

**Fecha:** 2026-10-26  
**Rama de integración:** `develop`  
**Contrato de entregas:** una rama `feat/ci-XX-*` y un commit coherente por core; PR hacia `develop`; tras el merge, eliminar la rama local y remota. La promoción a `main` requiere otro PR.

## Cores

| Core | Estado | Entrega principal |
| --- | --- | --- |
| CI-01 | Terminado | Escaneo offline, snapshot `code-snapshot/v1`, importación de inventario genérico, validación y tests. |
| CI-02 | Terminado | Análisis AST TypeScript, grafo `code-graph/v1`, imports y consumidores inversos. |
| CI-03 | Terminado | Catálogo estático Next.js `api-catalog/v1`, métodos declarados, trazabilidad de reexports y semántica `unknown`. |
| CI-04 | Implementado; pendiente de validar en CI Node 24 | Referencias Markdown/MDX `doc-trace/v1`, encabezados, enlaces a archivos y rutas API, CLI y pruebas. |
| CI-05 | Pendiente de desarrollo | Recuperación de contexto determinista, acotada y con citas a evidencia local; sin inferir pruebas, seguridad ni disponibilidad. |
| CI-06 | Pendiente de desarrollo | Indexación incremental, reducción de recomputación y MCP opcional de solo lectura. |

## Siguiente core: CI-05 — Contexto recuperable y citado

- **CI-05A — Selección determinista:** buscar por ruta, palabra clave y relaciones existentes sin ejecutar código ni utilizar servicios remotos; límites explícitos de resultados, tamaño y profundidad.
- **CI-05B — Paquetes de evidencia:** retornar fragmentos/identificadores con fuente, posiciones y estado de verificación; diferenciar datos indexados, inferencias no admitidas y ausencia de evidencia.
- **CI-05C — API CLI/contrato:** interfaz de consultas estructuradas, respuesta versionada, pruebas de estabilidad, entradas adversariales y documentación de límites.

**Criterios de aceptación para CI-05A:** (1) consultas reproducibles en el mismo conjunto de artefactos; (2) todos los hallazgos con referencias concretas a los contratos v1; (3) límites de tamaño/resultado y ninguna lectura fuera del inventario.

## Validaciones pendientes

- Ejecutar `npm ci --ignore-scripts --no-audit --no-fund`, `npm run typecheck` y `npm test` con Node.js 24 en CI de Ubuntu y Windows después de fusionar la rama CI-04.
- Verificar manualmente la consulta `docs-target` con un repositorio de prueba independiente, manteniendo el artefacto fuera de su raíz.
- Evaluar el rendimiento en repositorios grandes: CI-04 compone procesos CI-01/CI-02/CI-03 que reescanean parcialmente la fuente. La optimización se reserva para CI-06; evitar añadir cachés ad hoc en CI-04.

## Reglas técnicas

- Sin analizar secretos, rutas prohibidas, enlaces simbólicos, archivos grandes o carpetas excluidas; nunca publicar artefactos privados.
- Ningún LLM debe afirmar falsamente que un endpoint está probado, un enlace funciona en producción o la autenticación es efectiva. Lo no demostrado es `unknown`.
- No implementar componentes redundantes: reutilizar los contratos y el análisis existente. No ejecutar código, herramientas o scripts del repositorio objetivo.
- Versionar contratos JSON independientemente; preservar compatibilidad de `code-snapshot/v1`, `code-graph/v1` y `api-catalog/v1`.
- Fases acotadas, máximo tres criterios de aceptación por core y separar siempre desarrollo de validación; no añadir pruebas repetidas ni código no esencial para forzar el cierre de un core.
