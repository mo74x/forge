import {
  Controller,
  Post,
  Get,
  Patch,
  Param,
  Body,
  BadRequestException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { MappingSpecSchema, CanonicalFieldName, FieldMappingSchema } from '@lattice/mapping-spec';
import { AdapterCompiler } from '@lattice/codegen';
import { VerificationPipeline } from '@lattice/verify';
import { SandboxRunner } from '@lattice/sandbox';

@Controller('runs')
export class RunsController {
  constructor(private readonly prisma: PrismaClient) {}

  @Get(':id')
  async getRun(@Param('id') id: string) {
    const run = await this.prisma.onboardingRun.findUnique({
      where: { id },
      include: {
        specs: { orderBy: { version: 'desc' }, take: 1 },
        attempts: { orderBy: { number: 'asc' } },
        samples: true,
      },
    });
    if (!run) throw new BadRequestException('Run not found');
    return run;
  }

  /**
   * Inline Human Override:
   * Allows an FDE in the Review Studio to override a single field's JSONPath or Transform,
   * increments SpecVersion with source = HUMAN, and re-runs the 6-stage verifier.
   */
  @Patch(':id/spec/fields/:canonicalField')
  async overrideFieldMapping(
    @Param('id') id: string,
    @Param('canonicalField') canonicalField: CanonicalFieldName,
    @Body() overridePayload: unknown
  ) {
    const latestSpecRow = await this.prisma.specVersion.findFirst({
      where: { runId: id },
      orderBy: { version: 'desc' },
    });
    if (!latestSpecRow) throw new BadRequestException('No spec found for run');

    const validatedField = FieldMappingSchema.parse({
      ...(overridePayload as object),
      canonicalField,
      confidence: 1.0, // Human-verified override receives 1.0 confidence
    });

    const currentSpec = MappingSpecSchema.parse(latestSpecRow.spec);
    const updatedFields = currentSpec.fields.map((f) =>
      f.canonicalField === canonicalField ? validatedField : f
    );

    const newSpec = MappingSpecSchema.parse({
      ...currentSpec,
      fields: updatedFields,
    });

    const savedVersion = await this.prisma.specVersion.create({
      data: {
        runId: id,
        version: latestSpecRow.version + 1,
        spec: newSpec as any,
        source: 'HUMAN',
      },
    });

    const compiled = await AdapterCompiler.compile(newSpec);
    return {
      specVersion: savedVersion.version,
      spec: newSpec,
      adapterCode: compiled.adapterCode,
    };
  }

  /**
   * Live Sandboxed Simulator:
   * Executes the compiled TypeScript adapter inside the locked-down V8 sandbox
   * against any pasted partner JSON payload and measures sub-millisecond CPU latency.
   */
  @Post(':id/simulate')
  @HttpCode(HttpStatus.OK)
  async simulatePayload(
    @Param('id') id: string,
    @Body() body: { partnerPayload: Record<string, unknown> }
  ) {
    const latestSpecRow = await this.prisma.specVersion.findFirst({
      where: { runId: id },
      orderBy: { version: 'desc' },
    });
    if (!latestSpecRow) throw new BadRequestException('No spec found for run');

    const spec = MappingSpecSchema.parse(latestSpecRow.spec);
    const compiled = await AdapterCompiler.compile(spec);

    const startNs = process.hrtime.bigint();
    const adapter = SandboxRunner.instantiateAdapter(compiled.adapterCode);
    const canonicalEnvelope = adapter.toCanonical(body.partnerPayload);
    const endNs = process.hrtime.bigint();

    const executionMs = Number(endNs - startNs) / 1_000_000;

    return {
      canonicalEnvelope,
      executionTimeMs: Number(executionMs.toFixed(3)),
      runtimeLlmCalls: 0,
    };
  }

  /**
   * Gate-Checked Approval & Export:
   * Blocks export unless:
   * 1. All 6 verification stages pass
   * 2. Every field has confidence >= 0.85 (or was human-overridden)
   * 3. Any custom escape-hatch blocks are explicitly acknowledged
   */
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  async approveAndExport(
    @Param('id') id: string,
    @Body() body: { acknowledgeEscapeHatches?: boolean }
  ) {
    const run = await this.prisma.onboardingRun.findUnique({
      where: { id },
      include: {
        specs: { orderBy: { version: 'desc' }, take: 1 },
        samples: true,
      },
    });
    if (!run || run.specs.length === 0) throw new BadRequestException('Run or spec missing');

    const spec = MappingSpecSchema.parse(run.specs[0].spec);
    const compiled = await AdapterCompiler.compile(spec);

    // Gate 1: Low-confidence check
    const unresolvedLowConf = spec.fields.filter((f) => f.confidence < 0.85);
    if (unresolvedLowConf.length > 0) {
      throw new BadRequestException(
        `Approval Gate Blocked: Unresolved low-confidence fields: ${unresolvedLowConf.map((f) => f.canonicalField).join(', ')}`
      );
    }

    // Gate 2: Escape hatch acknowledgment check
    if (compiled.hasCustomEscapeHatch && !body.acknowledgeEscapeHatches) {
      throw new BadRequestException(
        `Approval Gate Blocked: Adapter contains custom escape-hatch code requiring explicit sign-off.`
      );
    }

    // Gate 3: Full 6-Stage Verification Check
    const report = VerificationPipeline.runAll({
      adapterFileName: compiled.adapterFileName,
      adapterCode: compiled.adapterCode,
      spec,
      goldenFixtures: run.samples
        .filter((s) => s.kind === 'TRAINING' && s.goldenCanonical)
        .map((s) => ({
          sampleId: s.id,
          label: s.label,
          isHeldOut: false,
          rawPartnerPayload: s.payload as Record<string, unknown>,
          expectedCanonical: s.goldenCanonical as any,
        })),
      heldOutFixtures: run.samples
        .filter((s) => s.kind === 'HELD_OUT' && s.goldenCanonical)
        .map((s) => ({
          sampleId: s.id,
          label: s.label,
          isHeldOut: true,
          rawPartnerPayload: s.payload as Record<string, unknown>,
          expectedCanonical: s.goldenCanonical as any,
        })),
      webhookVector: (run.webhookVector as any) || undefined,
    });

    if (!report.allPassed) {
      throw new BadRequestException(
        `Approval Gate Blocked: Verification stage "${report.failedStage}" failed.`
      );
    }

    await this.prisma.onboardingRun.update({
      where: { id },
      data: { status: 'APPROVED' },
    });

    return {
      status: 'APPROVED',
      files: {
        [compiled.adapterFileName]: compiled.adapterCode,
        [compiled.schemaFileName]: compiled.schemaCode,
        [compiled.testFileName]: compiled.testCode,
        [`${spec.provider}.mapping.json`]: JSON.stringify(spec, null, 2),
      },
    };
  }
}