import { PrismaClient, Prisma } from '@prisma/client';

// Test de integración contra la base de datos real (PostgreSQL).
// Verifica que la estructura creada por la migración funciona end-to-end:
//   - Se puede insertar el flujo completo (Company -> ... -> Interview).
//   - Se respetan las restricciones de integridad (UNIQUE y CHECK).
//   - Un JOIN devuelve los datos relacionados correctamente.
const prisma = new PrismaClient();

// IDs creados para poder limpiarlos al final.
let companyId: number;
let candidateId: number;
let positionId: number;
let applicationId: number;

afterAll(async () => {
  // Limpieza en orden inverso a las dependencias (FK RESTRICT).
  await prisma.interview.deleteMany({ where: { application: { candidateId } } });
  await prisma.application.deleteMany({ where: { candidateId } });
  await prisma.position.deleteMany({ where: { companyId } });
  await prisma.interviewStep.deleteMany({ where: { interviewFlow: { description: 'TEST Flujo Backend' } } });
  await prisma.interviewType.deleteMany({ where: { name: 'TEST-Technical' } });
  await prisma.interviewFlow.deleteMany({ where: { description: 'TEST Flujo Backend' } });
  await prisma.candidate.deleteMany({ where: { id: candidateId } });
  await prisma.employee.deleteMany({ where: { companyId } });
  await prisma.company.deleteMany({ where: { id: companyId } });
  await prisma.$disconnect();
});

describe('Esquema ATS - integración', () => {
  it('inserta el flujo completo de contratación', async () => {
    const company = await prisma.company.create({ data: { name: 'TEST LTI Talent' } });
    companyId = company.id;

    await prisma.employee.create({
      data: { name: 'Ana Recruiter', email: 'test-ana@lti.com', role: 'RECRUITER', companyId },
    });

    const flow = await prisma.interviewFlow.create({ data: { description: 'TEST Flujo Backend' } });
    const type = await prisma.interviewType.create({ data: { name: 'TEST-Technical' } });
    const step = await prisma.interviewStep.create({
      data: { name: 'Entrevista técnica', orderIndex: 1, interviewFlowId: flow.id, interviewTypeId: type.id },
    });

    const position = await prisma.position.create({
      data: {
        title: 'Backend Engineer', companyId, interviewFlowId: flow.id,
        status: 'OPEN', isVisible: true, employmentType: 'FULL_TIME',
        salaryMin: new Prisma.Decimal(45000), salaryMax: new Prisma.Decimal(60000),
      },
    });
    positionId = position.id;

    const candidate = await prisma.candidate.create({
      data: { firstName: 'Luis', lastName: 'García', email: 'test-luis@example.com' },
    });
    candidateId = candidate.id;

    const application = await prisma.application.create({
      data: { positionId, candidateId, status: 'INTERVIEW' },
    });
    applicationId = application.id;

    const employee = await prisma.employee.findFirstOrThrow({ where: { companyId } });
    const interview = await prisma.interview.create({
      data: {
        applicationId, interviewStepId: step.id, employeeId: employee.id,
        interviewDate: new Date('2026-06-25'), result: 'PASSED', score: 9,
      },
    });

    expect(interview.id).toBeGreaterThan(0);
  });

  it('un JOIN devuelve el pipeline completo con datos relacionados', async () => {
    const result = await prisma.application.findFirstOrThrow({
      where: { id: applicationId },
      include: {
        candidate: true,
        position: { include: { company: true } },
        interviews: { include: { employee: true } },
      },
    });

    expect(result.candidate.firstName).toBe('Luis');
    expect(result.position.title).toBe('Backend Engineer');
    expect(result.position.company.name).toBe('TEST LTI Talent');
    expect(result.interviews[0].result).toBe('PASSED');
    expect(result.interviews[0].employee.name).toBe('Ana Recruiter');
  });

  it('rechaza una candidatura duplicada (UNIQUE positionId+candidateId)', async () => {
    await expect(
      prisma.application.create({ data: { positionId, candidateId } }),
    ).rejects.toThrow();
  });

  it('rechaza un score fuera de rango (CHECK 0..100)', async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO "Interview" ("applicationId","interviewStepId","employeeId","interviewDate","score") VALUES (${applicationId}, 1, 1, '2026-06-25', 500)`,
    ).rejects.toThrow();
  });

  it('rechaza salaryMax < salaryMin (CHECK)', async () => {
    await expect(
      prisma.position.create({
        data: {
          title: 'Cargo inválido', companyId, interviewFlowId: 1,
          salaryMin: new Prisma.Decimal(80000), salaryMax: new Prisma.Decimal(10000),
        },
      }),
    ).rejects.toThrow();
  });
});
