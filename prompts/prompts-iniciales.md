# Prompts iniciales — Ampliación del modelo de datos LTI (Módulo 8: Bases de Datos)

> Bitácora técnica de los prompts y pasos que he seguido para convertir el ERD
> (formato Mermaid) en un modelo **Prisma** + **migración SQL de PostgreSQL**,
> aplicando normalización (hasta 3FN/BCNF), índices y restricciones de
> integridad (FK, UNIQUE, CHECK, ENUM).
>
> **Stack:** PostgreSQL 17 (Docker) · Prisma 5.19 · Node 24 · TypeScript.
> Conexión verificada con `psql`/PGAdmin contra `localhost:5432/LTIdb` usando
> las credenciales de `.env`.
>
> **Metodología — bucle de doble pasada.** Cada paso lo ejecuto en dos pasadas:
> (1) producir el artefacto, (2) revisión crítica adversarial *"¿qué falta?,
> ¿qué viola una forma normal?, ¿qué índice sobra o falta?, ¿hay DDL
> destructivo?"*. Las mejoras de la 2ª pasada van marcadas con 🔁.

---

## Paso 0 — Análisis del repositorio y del esquema actual

**Prompt:**
> "Analiza el repositorio sin modificar nada. Quiero el inventario de entidades
> ya presentes en `backend/prisma/schema.prisma`, el estado de
> `backend/prisma/migrations/`, el `DATABASE_URL` efectivo (resolviendo la
> interpolación de variables del `.env`) y si hay un PostgreSQL accesible.
> Resume las brechas respecto al ERD objetivo."

**Hallazgos:**
- `schema.prisma` ya define `Candidate`, `Education`, `WorkExperience`,
  `Resume`. El módulo ATS del ERD (Company, Position, InterviewFlow…) **no
  existe**.
- `migrations/` solo contiene `migration_lock.toml` (`provider = "postgresql"`):
  **no hay migraciones versionadas todavía**, por lo que la migración que genere
  será la `init` real del histórico de Prisma.
- `.env` define `DATABASE_URL` con interpolación
  `postgresql://${DB_USER}:${DB_PASSWORD}@localhost:${DB_PORT}/${DB_NAME}` →
  resuelve a `postgresql://LTIdbUser:***@localhost:5432/LTIdb`.
- Aprovisiono rol `LTIdbUser` (LOGIN, CREATEDB) y base `LTIdb` en el Postgres
  local para que el `.env` funcione **sin tocarlo**.

**🔁 2ª pasada — análisis de identidad de entidades.** El `CANDIDATE` del ERD
(firstName, lastName, email, phone, address) es **isomorfo** al `Candidate`
existente. Decisión: **no introduzco una entidad duplicada**; extiendo la
existente con la relación inversa `applications Application[]`. Esto evita una
violación de normalización por duplicación de la entidad candidato y mantiene
una única fuente de verdad.

---

## Paso 1 — Conversión del ERD (Mermaid) a modelo Prisma con normalización

**Prompt:**
> "Convierte el ERD Mermaid a modelos Prisma para PostgreSQL respetando las 9
> entidades y todas las relaciones. El ERD usa `string` para todo y no tiene
> índices ni constraints: normalízalo hasta 3FN, sustituye los `string` de
> dominio acotado por tipos correctos y justifica cada decisión contra las
> formas normales."

### Decisiones de normalización (1FN → BCNF)

- **1FN (atomicidad):** todos los atributos son escalares; no hay columnas
  multivaluadas. Las colecciones (los pasos de un flujo, las candidaturas de una
  posición) se modelan como **tablas hijas con FK**, no como listas en una celda.
- **2FN (dependencia plena de la PK):** todas las tablas usan una PK sintética
  `id` de una sola columna (`@id @default(autoincrement())`), de modo que no
  caben dependencias parciales sobre PKs compuestas.
- **3FN / BCNF (sin dependencias transitivas):** los atributos descriptivos de
  un flujo viven en `InterviewFlow`/`InterviewType`, no repetidos en
  `InterviewStep`. El detalle de empresa no se copia en `Position`
  (relación por FK `companyId`). Los valores de `status`/`role`/`result` se
  externalizan a **ENUM** en lugar de repetir strings por fila.

### Sustitución de `string` libre por ENUM nativo (integridad de dominio)

El ERD declara `status`, `role`, `result`, `employment_type` como `string`, lo
que permite valores inconsistentes (`"open"` vs `"OPEN"`). Los convierto a
**enums nativos de PostgreSQL** — equivalen a un `CHECK` cerrado y son más
eficientes en almacenamiento que `VARCHAR`:

```prisma
enum PositionStatus    { DRAFT OPEN PAUSED CLOSED ARCHIVED }
enum ApplicationStatus { RECEIVED REVIEWING INTERVIEW OFFER HIRED REJECTED WITHDRAWN }
enum InterviewResult   { PENDING PASSED FAILED NO_SHOW }
enum EmployeeRole      { RECRUITER HIRING_MANAGER INTERVIEWER ADMIN }
enum EmploymentType    { FULL_TIME PART_TIME CONTRACT INTERNSHIP TEMPORARY FREELANCE }
```

### Tipos de dato correctos (en vez de `string` genérico)

| Campo(s) | Tipo elegido | Motivo |
|----------|--------------|--------|
| `salaryMin`, `salaryMax` | `Decimal(12,2)` | Dinero: nunca `float` (errores de redondeo IEEE-754). |
| `applicationDeadline`, `applicationDate`, `interviewDate` | `Date` | Fechas de negocio sin componente horario. |
| `description`, `requirements`, `responsibilities`, `benefits`, `jobDescription`, `companyDescription`, `notes` | `Text` | Texto largo sin límite artificial de `VARCHAR`. |
| `title`, `location`, `contactInfo`, `name`, `email` | `VarChar(n)` | Cadenas cortas acotadas. |

### Cardinalidad de `Position` ↔ `InterviewFlow`

El ERD la dibuja `||--||` (1:1). La modelo **N:1** (`Position.interviewFlowId` →
`InterviewFlow.id`, sin `UNIQUE`): un flujo de entrevistas es un **activo
reutilizable** y forzar 1:1 obligaría a clonar el flujo y sus pasos por cada
oferta — redundancia que rompe 3FN. Documentada como desviación consciente del
ERD literal.

**🔁 2ª pasada — defaults y nullabilidad.** Añado defaults de dominio
(`status DRAFT`, `isVisible false`, `role INTERVIEWER`, `isActive true`,
`result PENDING`, `applicationDate now()`) y marco como opcional (`?`) todo el
detalle no imprescindible de la oferta, dejando `NOT NULL` solo lo necesario para
operar (título, FKs). Así el `INSERT` del caso común es mínimo y consistente.

---

## Paso 2 — Índices y restricciones UNIQUE

**Prompt:**
> "Diseña la estrategia de índices. Regla: indexar toda columna de FK (Postgres
> no las indexa sola y son las columnas de JOIN), más las columnas de los
> `WHERE`/`ORDER BY` más frecuentes del backlog. Añade UNIQUE donde lo exija la
> lógica de negocio. Evita índices redundantes con los que ya crea cada UNIQUE."

| Índice / constraint | Tipo | Justificación (carga de trabajo) |
|---------------------|------|----------------------------------|
| FK: `companyId`, `interviewFlowId`, `interviewTypeId`, `positionId`, `candidateId`, `applicationId`, `interviewStepId`, `employeeId` | B-tree | Acelera los JOIN del pipeline (todas las relaciones). |
| `@@unique([positionId, candidateId])` en `Application` | UNIQUE | Un candidato no puede aplicar dos veces a la misma posición. |
| `@@unique([interviewFlowId, orderIndex])` en `InterviewStep` | UNIQUE | Orden de paso único dentro de un flujo. |
| `@unique` en `Company.name`, `Employee.email`, `InterviewType.name`, `Candidate.email` | UNIQUE | Claves naturales / identidad. |
| `@@index([status, isVisible])` en `Position` | B-tree compuesto | Consulta del portal público: ofertas `OPEN` + visibles. Orden de columnas por selectividad. |
| `@@index([status])` en `Application`; `@@index([isActive])` en `Employee` | B-tree | Filtros del panel de recruiter. |

**🔁 2ª pasada — anti-redundancia.** Verifico que **no** creo un `@@index` sobre
columnas que ya cubre un `@unique`/`@@unique` (que genera su propio índice B-tree
implícito), para no pagar coste de escritura doble. El compuesto
`(status, isVisible)` se ordena con la columna más selectiva primero para que sea
útil también en consultas que solo filtran por `status`.

---

## Paso 3 — Generación y aplicación de la migración

**Prompt:**
> "Formatea y valida el schema; luego genera la migración con nombre
> descriptivo y aplícala contra la BD de desarrollo. Muéstrame el SQL generado
> íntegro antes de continuar."

```bash
npx prisma format
npx prisma validate
DATABASE_URL="postgresql://LTIdbUser:***@localhost:5432/LTIdb" \
  npx prisma migrate dev --name expand_ats_schema
```

Genera `backend/prisma/migrations/20260621175254_expand_ats_schema/migration.sql`
con el orden DDL correcto: `CREATE TYPE` (5 enums) → `CREATE TABLE` (12) →
`CREATE [UNIQUE] INDEX` → `ALTER TABLE … ADD FOREIGN KEY`. Las FK se generan con
`ON DELETE RESTRICT ON UPDATE CASCADE` (default de Prisma).

---

## Paso 4 — 🔁 Revisión de la migración + CHECK constraints

**Prompt (revisión obligatoria de DDL):**
> "Revisa el SQL generado: ¿hay operaciones destructivas (DROP, ALTER que
> trunque, CREATE UNIQUE sobre datos existentes)? ¿Falta integridad de dominio
> expresable como CHECK? El material del módulo cita los CHECK como herramienta
> clave; añádelos donde aporten."

**Resultado de la revisión:**
- Migración **puramente aditiva** (solo `CREATE`/`ADD`): **0 operaciones
  destructivas** → segura de aplicar. Al ser la `init`, tampoco hay
  `CREATE UNIQUE` sobre datos preexistentes.
- Faltan **CHECK** de dominio. Prisma 5.x no los expresa en el schema, así que
  los añado al final del `migration.sql` (no generan *drift* porque Prisma no
  gestiona CHECK):

```sql
ALTER TABLE "Interview" ADD CONSTRAINT "Interview_score_range_chk"
  CHECK ("score" IS NULL OR ("score" >= 0 AND "score" <= 100));
ALTER TABLE "Position"  ADD CONSTRAINT "Position_salary_range_chk"
  CHECK ("salaryMin" IS NULL OR "salaryMax" IS NULL OR "salaryMax" >= "salaryMin");
```

- Re-aplico de forma limpia con `npx prisma migrate reset --force` (la BD es
  desechable y aún no hay datos productivos) para que el *checksum* de la
  migración se recalcule e incluya los CHECK.

---

## Paso 5 — Verificación de la estructura en PostgreSQL / PGAdmin

**Prompt:**
> "Conéctate a la BD y verifica que la estructura es correcta, como haría en
> PGAdmin: lista tablas, enums e índices de las tablas del pipeline, y confirma
> que las FK existen."

```sql
\dt                                              -- 12 tablas de dominio + _prisma_migrations
SELECT typname FROM pg_type WHERE typtype = 'e'; -- 5 enums
SELECT tablename, indexname FROM pg_indexes
 WHERE tablename IN ('Position','Application','Interview');
```

Confirmo: 12 tablas del dominio, los 5 enums y los índices esperados (PK, FK,
UNIQUE y compuesto). Conexión OK con las credenciales del `.env`.

---

## Paso 6 — Datos de prueba y consulta con JOINs

**Prompt:**
> "Inserta un caso que recorra todo el flujo (Company → Employee → InterviewFlow
> → InterviewType → InterviewStep → Position → Candidate → Application →
> Interview) y ejecuta un JOIN que muestre el pipeline completo. Comprueba que la
> UNIQUE rechaza una candidatura duplicada."

```sql
SELECT c."firstName" || ' ' || c."lastName" AS candidato,
       p.title AS posicion, comp.name AS empresa,
       a.status, i.result, i.score, e.name AS entrevistador
FROM "Application" a
JOIN "Candidate" c  ON c.id = a."candidateId"
JOIN "Position"  p  ON p.id = a."positionId"
JOIN "Company"   comp ON comp.id = p."companyId"
JOIN "Interview" i  ON i."applicationId" = a.id
JOIN "Employee"  e  ON e.id = i."employeeId";
```

Devuelve `Luis García | Backend Engineer | LTI Talent | INTERVIEW | PASSED | 9 |
Ana Recruiter`. El segundo `INSERT` de la misma candidatura es rechazado:
`duplicate key value violates unique constraint "Application_positionId_candidateId_key"`. ✅

**🔁 2ª pasada — plan de ejecución.** Sobre el JOIN ejecuto
`EXPLAIN (ANALYZE, BUFFERS)`. Con el volumen de prueba (1 fila/tabla) el
planificador elige `Hash Join` + `Seq Scan`, que es **óptimo** a esa escala (un
`Index Scan` sería más caro que leer la tabla entera). Los índices B-tree sobre
las FK están en su sitio para que el planificador conmute a `Index Scan` /
`Nested Loop` cuando las tablas crezcan; lo valido revisando que las condiciones
de JOIN (`Hash Cond: a."candidateId" = c.id`, etc.) son exactamente las columnas
indexadas.

---

## Paso 7 — Tests de integración automatizados

**Prompt:**
> "Escribe tests (Jest + Prisma Client, como el resto del proyecto) que validen:
> inserción del flujo completo, JOIN con datos relacionados, y que UNIQUE y los
> dos CHECK rechazan datos inválidos. Idempotentes: limpia los datos al
> terminar."

`backend/prisma/schema.integration.test.ts` con 5 casos:
1. Inserta el flujo completo de contratación.
2. JOIN (`prisma.application.findFirstOrThrow` con `include` anidado) devuelve el
   pipeline con datos relacionados.
3. Rechaza candidatura duplicada (UNIQUE).
4. Rechaza `score` fuera de rango (CHECK 0..100).
5. Rechaza `salaryMax < salaryMin` (CHECK).

```bash
DATABASE_URL="postgresql://…/LTIdb" npx jest prisma/schema.integration.test.ts
# Tests: 5 passed, 5 total ✅
```

El `afterAll` borra en orden inverso a las dependencias (FK `RESTRICT`) para que
el test sea reejecutable sin dejar residuos.

---

## Paso 8 — Entrega (rama, commit, push, PR)

**Prompt:**
> "Crea la rama `db-iniciales`, añade SOLO los cambios de modelo y la migración
> `.sql` en `backend/prisma` y `prompts/prompts-iniciales.md`. Revierte los lock
> files tocados por `npm install`. Commit descriptivo, push y abre el PR."

```bash
git checkout -b db-iniciales
git checkout -- backend/package-lock.json   # revierto ruido de npm install
git add backend/prisma/schema.prisma \
        backend/prisma/migrations/20260621175254_expand_ats_schema \
        prompts/prompts-iniciales.md
git commit -m "feat(db): ampliar modelo de datos LTI con el flujo ATS completo"
git push -u origin db-iniciales
gh pr create --base main --head db-iniciales
```

---

## Resumen de buenas prácticas aplicadas

| Práctica | Aplicación concreta |
|----------|---------------------|
| **Normalización 1FN–BCNF** | Atributos atómicos; PK sintética de una columna; sin dependencias transitivas; dominios acotados externalizados a ENUM. |
| **Índices** | B-tree en todas las FK (JOINs), en filtros frecuentes y compuesto `(status, isVisible)` ordenado por selectividad. |
| **Integridad referencial** | FK explícitas con `ON DELETE RESTRICT` en todas las relaciones. |
| **Integridad de dominio** | ENUM + CHECK (rango de `score`, coherencia de salario) + UNIQUE (candidatura única, orden de paso único, claves naturales). |
| **Tipos correctos** | `Decimal(12,2)` (dinero), `Date` (fechas de negocio), `Text` (texto largo). |
| **Revisión de migraciones** | 2ª pasada verificando ausencia de DDL destructivo antes de aplicar. |
| **Verificación real** | Inspección `psql`/PGAdmin + datos de prueba + JOIN + `EXPLAIN ANALYZE` + 5 tests de integración. |
