# Initial prompts — Expanding the LTI data model (Module 8: Databases)

> Technical log of the prompts and steps I followed to turn the ERD (Mermaid
> format) into a **Prisma** model + a **PostgreSQL SQL migration**, applying
> normalization (up to 3NF/BCNF), indexes and integrity constraints
> (FK, UNIQUE, CHECK, ENUM).
>
> **Stack:** PostgreSQL 17 (Docker) · Prisma 5.19 · Node 24 · TypeScript.
> Connection verified with `psql`/PGAdmin against `localhost:5432/LTIdb` using
> the credentials from `.env`.
>
> **Methodology — two-pass loop.** I run each step in two passes:
> (1) produce the artifact, (2) adversarial critical review *"what's missing?,
> what violates a normal form?, which index is redundant or missing?, is there
> destructive DDL?"*. Improvements from the 2nd pass are marked with 🔁.

---

## Step 0 — Repository and current-schema analysis

**Prompt:**
> "Analyze the repository without modifying anything. I want the inventory of
> entities already present in `backend/prisma/schema.prisma`, the state of
> `backend/prisma/migrations/`, the effective `DATABASE_URL` (resolving the
> variable interpolation from `.env`) and whether there is a reachable
> PostgreSQL. Summarize the gaps against the target ERD."

**Findings:**
- `schema.prisma` already defines `Candidate`, `Education`, `WorkExperience`,
  `Resume`. The ATS module from the ERD (Company, Position, InterviewFlow…)
  **does not exist**.
- `migrations/` only contains `migration_lock.toml` (`provider = "postgresql"`):
  **there are no versioned migrations yet**, so the migration I generate will be
  the real `init` of Prisma's history.
- `.env` defines `DATABASE_URL` with interpolation
  `postgresql://${DB_USER}:${DB_PASSWORD}@localhost:${DB_PORT}/${DB_NAME}` →
  resolves to `postgresql://LTIdbUser:***@localhost:5432/LTIdb`.
- I provision the `LTIdbUser` role (LOGIN, CREATEDB) and the `LTIdb` database in
  the local Postgres so that `.env` works **without touching it**.

**🔁 2nd pass — entity-identity analysis.** The ERD's `CANDIDATE`
(firstName, lastName, email, phone, address) is **isomorphic** to the existing
`Candidate`. Decision: **I do not introduce a duplicate entity**; I extend the
existing one with the inverse relation `applications Application[]`. This avoids
a normalization violation by duplicating the candidate entity and keeps a single
source of truth.

---

## Step 1 — Converting the ERD (Mermaid) into a Prisma model with normalization

**Prompt:**
> "Convert the Mermaid ERD into Prisma models for PostgreSQL, honoring the 9
> entities and all relations. The ERD uses `string` for everything and has no
> indexes or constraints: normalize it up to 3NF, replace the bounded-domain
> `string`s with correct types and justify each decision against the normal
> forms."

### Normalization decisions (1NF → BCNF)

- **1NF (atomicity):** all attributes are scalar; there are no multi-valued
  columns. Collections (the steps of a flow, the applications of a position) are
  modeled as **child tables with FKs**, not as lists in a single cell.
- **2NF (full dependency on the PK):** every table uses a single-column synthetic
  PK `id` (`@id @default(autoincrement())`), so no partial dependencies on
  composite PKs are possible.
- **3NF / BCNF (no transitive dependencies):** a flow's descriptive attributes
  live in `InterviewFlow`/`InterviewType`, not repeated in `InterviewStep`.
  Company detail is not copied into `Position` (relation via FK `companyId`). The
  `status`/`role`/`result` values are externalized into **ENUM**s instead of
  repeating strings per row.

### Replacing free `string` with native ENUM (domain integrity)

The ERD declares `status`, `role`, `result`, `employment_type` as `string`,
which allows inconsistent values (`"open"` vs `"OPEN"`). I convert them into
**native PostgreSQL enums** — they are equivalent to a closed `CHECK` and are
more storage-efficient than `VARCHAR`:

```prisma
enum PositionStatus    { DRAFT OPEN PAUSED CLOSED ARCHIVED }
enum ApplicationStatus { RECEIVED REVIEWING INTERVIEW OFFER HIRED REJECTED WITHDRAWN }
enum InterviewResult   { PENDING PASSED FAILED NO_SHOW }
enum EmployeeRole      { RECRUITER HIRING_MANAGER INTERVIEWER ADMIN }
enum EmploymentType    { FULL_TIME PART_TIME CONTRACT INTERNSHIP TEMPORARY FREELANCE }
```

### Correct data types (instead of a generic `string`)

| Field(s) | Chosen type | Reason |
|----------|-------------|--------|
| `salaryMin`, `salaryMax` | `Decimal(12,2)` | Money: never `float` (IEEE-754 rounding errors). |
| `applicationDeadline`, `applicationDate`, `interviewDate` | `Date` | Business dates with no time component. |
| `description`, `requirements`, `responsibilities`, `benefits`, `jobDescription`, `companyDescription`, `notes` | `Text` | Long text with no artificial `VARCHAR` limit. |
| `title`, `location`, `contactInfo`, `name`, `email` | `VarChar(n)` | Short, bounded strings. |

### Cardinality of `Position` ↔ `InterviewFlow`

The ERD draws it as `||--||` (1:1). I model it as **N:1**
(`Position.interviewFlowId` → `InterviewFlow.id`, without `UNIQUE`): an interview
flow is a **reusable asset**, and forcing 1:1 would require cloning the flow and
its steps for every opening — redundancy that breaks 3NF. Documented as a
conscious deviation from the literal ERD.

**🔁 2nd pass — defaults and nullability.** I add domain defaults
(`status DRAFT`, `isVisible false`, `role INTERVIEWER`, `isActive true`,
`result PENDING`, `applicationDate now()`) and mark as optional (`?`) all the
non-essential opening detail, keeping `NOT NULL` only on what's required to
operate (title, FKs). This way the common-case `INSERT` is minimal and
consistent.

---

## Step 2 — Indexes and UNIQUE constraints

**Prompt:**
> "Design the indexing strategy. Rule: index every FK column (Postgres does not
> index them automatically and they are the JOIN columns), plus the columns in
> the most frequent `WHERE`/`ORDER BY` of the backlog. Add UNIQUE where the
> business logic requires it. Avoid indexes that are redundant with the ones each
> UNIQUE already creates."

| Index / constraint | Type | Justification (workload) |
|--------------------|------|--------------------------|
| FK: `companyId`, `interviewFlowId`, `interviewTypeId`, `positionId`, `candidateId`, `applicationId`, `interviewStepId`, `employeeId` | B-tree | Speeds up the pipeline JOINs (all relations). |
| `@@unique([positionId, candidateId])` on `Application` | UNIQUE | A candidate cannot apply twice to the same position. |
| `@@unique([interviewFlowId, orderIndex])` on `InterviewStep` | UNIQUE | Unique step order within a flow. |
| `@unique` on `Company.name`, `Employee.email`, `InterviewType.name`, `Candidate.email` | UNIQUE | Natural keys / identity. |
| `@@index([status, isVisible])` on `Position` | Composite B-tree | Public-portal query: `OPEN` + visible openings. Column order by selectivity. |
| `@@index([status])` on `Application`; `@@index([isActive])` on `Employee` | B-tree | Recruiter-dashboard filters. |

**🔁 2nd pass — anti-redundancy.** I verify that I do **not** create an `@@index`
on columns already covered by a `@unique`/`@@unique` (which generates its own
implicit B-tree index), to avoid paying a double write cost. The composite
`(status, isVisible)` is ordered with the most selective column first so it is
also useful for queries that only filter by `status`.

---

## Step 3 — Generating and applying the migration

**Prompt:**
> "Format and validate the schema; then generate the migration with a descriptive
> name and apply it against the development DB. Show me the full generated SQL
> before continuing."

```bash
npx prisma format
npx prisma validate
DATABASE_URL="postgresql://LTIdbUser:***@localhost:5432/LTIdb" \
  npx prisma migrate dev --name expand_ats_schema
```

This generates
`backend/prisma/migrations/20260621175254_expand_ats_schema/migration.sql`
with the correct DDL order: `CREATE TYPE` (5 enums) → `CREATE TABLE` (12) →
`CREATE [UNIQUE] INDEX` → `ALTER TABLE … ADD FOREIGN KEY`. The FKs are generated
with `ON DELETE RESTRICT ON UPDATE CASCADE` (Prisma default).

---

## Step 4 — 🔁 Migration review + CHECK constraints

**Prompt (mandatory DDL review):**
> "Review the generated SQL: are there destructive operations (DROP, truncating
> ALTER, CREATE UNIQUE over existing data)? Is there domain integrity expressible
> as a CHECK that's missing? The module material cites CHECKs as a key tool; add
> them where they help."

**Review result:**
- The migration is **purely additive** (only `CREATE`/`ADD`): **0 destructive
  operations** → safe to apply. Being the `init`, there is also no
  `CREATE UNIQUE` over pre-existing data.
- Domain **CHECK**s are missing. Prisma 5.x does not express them in the schema,
  so I add them at the end of `migration.sql` (they do not cause *drift* because
  Prisma does not manage CHECKs):

```sql
ALTER TABLE "Interview" ADD CONSTRAINT "Interview_score_range_chk"
  CHECK ("score" IS NULL OR ("score" >= 0 AND "score" <= 100));
ALTER TABLE "Position"  ADD CONSTRAINT "Position_salary_range_chk"
  CHECK ("salaryMin" IS NULL OR "salaryMax" IS NULL OR "salaryMax" >= "salaryMin");
```

- I re-apply cleanly with `npx prisma migrate reset --force` (the DB is
  disposable and there is no production data yet) so that the migration's
  *checksum* is recomputed and includes the CHECKs.

---

## Step 5 — Verifying the structure in PostgreSQL / PGAdmin

**Prompt:**
> "Connect to the DB and verify that the structure is correct, as I would in
> PGAdmin: list tables, enums and indexes of the pipeline tables, and confirm the
> FKs exist."

```sql
\dt                                              -- 12 domain tables + _prisma_migrations
SELECT typname FROM pg_type WHERE typtype = 'e'; -- 5 enums
SELECT tablename, indexname FROM pg_indexes
 WHERE tablename IN ('Position','Application','Interview');
```

I confirm: 12 domain tables, the 5 enums and the expected indexes (PK, FK,
UNIQUE and composite). Connection OK with the `.env` credentials.

---

## Step 6 — Test data and a JOIN query

**Prompt:**
> "Insert a case that traverses the whole flow (Company → Employee →
> InterviewFlow → InterviewType → InterviewStep → Position → Candidate →
> Application → Interview) and run a JOIN that shows the full pipeline. Check that
> the UNIQUE rejects a duplicate application."

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

It returns `Luis García | Backend Engineer | LTI Talent | INTERVIEW | PASSED | 9 |
Ana Recruiter`. The second `INSERT` of the same application is rejected:
`duplicate key value violates unique constraint "Application_positionId_candidateId_key"`. ✅

**🔁 2nd pass — execution plan.** On the JOIN I run
`EXPLAIN (ANALYZE, BUFFERS)`. With the test volume (1 row/table) the planner
chooses `Hash Join` + `Seq Scan`, which is **optimal** at that scale (an
`Index Scan` would be costlier than reading the whole table). The B-tree indexes
on the FKs are in place so the planner switches to `Index Scan` /
`Nested Loop` as the tables grow; I validate it by checking that the JOIN
conditions (`Hash Cond: a."candidateId" = c.id`, etc.) are exactly the indexed
columns.

---

## Step 7 — Automated integration tests

**Prompt:**
> "Write tests (Jest + Prisma Client, like the rest of the project) that
> validate: insertion of the full flow, a JOIN with related data, and that UNIQUE
> and the two CHECKs reject invalid data. Idempotent: clean up the data when
> finished."

`backend/prisma/schema.integration.test.ts` with 5 cases:
1. Inserts the complete hiring flow.
2. JOIN (`prisma.application.findFirstOrThrow` with nested `include`) returns the
   pipeline with related data.
3. Rejects a duplicate application (UNIQUE).
4. Rejects an out-of-range `score` (CHECK 0..100).
5. Rejects `salaryMax < salaryMin` (CHECK).

```bash
DATABASE_URL="postgresql://…/LTIdb" npx jest prisma/schema.integration.test.ts
# Tests: 5 passed, 5 total ✅
```

The `afterAll` deletes in reverse dependency order (FK `RESTRICT`) so the test is
re-runnable without leaving residue.

---

## Step 8 — Delivery (branch, commit, push, PR)

**Prompt:**
> "Create the `db-iniciales` branch, add ONLY the model changes and the `.sql`
> migration under `backend/prisma` plus `prompts/prompts-iniciales.md`. Revert
> the lock files touched by `npm install`. Descriptive commit, push and open the
> PR."

```bash
git checkout -b db-iniciales
git checkout -- backend/package-lock.json   # revert npm install noise
git add backend/prisma/schema.prisma \
        backend/prisma/migrations/20260621175254_expand_ats_schema \
        prompts/prompts-iniciales.md
git commit -m "feat(db): ampliar modelo de datos LTI con el flujo ATS completo"
git push -u origin db-iniciales
gh pr create --base main --head db-iniciales
```

---

## Summary of applied best practices

| Practice | Concrete application |
|----------|----------------------|
| **Normalization 1NF–BCNF** | Atomic attributes; single-column synthetic PK; no transitive dependencies; bounded domains externalized to ENUM. |
| **Indexes** | B-tree on every FK (JOINs), on frequent filters and a composite `(status, isVisible)` ordered by selectivity. |
| **Referential integrity** | Explicit FKs with `ON DELETE RESTRICT` on all relations. |
| **Domain integrity** | ENUM + CHECK (`score` range, salary coherence) + UNIQUE (single application, unique step order, natural keys). |
| **Correct types** | `Decimal(12,2)` (money), `Date` (business dates), `Text` (long text). |
| **Migration review** | 2nd pass verifying the absence of destructive DDL before applying. |
| **Real verification** | `psql`/PGAdmin inspection + test data + JOIN + `EXPLAIN ANALYZE` + 5 integration tests. |
