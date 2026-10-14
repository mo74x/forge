#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { MappingSpecSchema } from '@lattice/mapping-spec';
import { AdapterCompiler } from '@lattice/codegen';
import { VerificationPipeline } from '@lattice/verify';
import { OnboardingOrchestrator } from '@lattice/repair-loop';
import { OpenAiCompatibleProvider } from '@lattice/llm';

async function main() {
  const [, , command, ...args] = process.argv;
  const flags = parseFlags(args);

  switch (command) {
    case 'onboard':
      await handleOnboard(flags);
      break;
    case 'verify':
      await handleVerify(flags);
      break;
    case 'export':
      await handleExport(flags);
      break;
    default:
      console.log(`
 Forge — Self-Verifying AI Partner Onboarding Compiler

Usage:
  forge onboard --provider <name> --fixtures <path> [--docs <path>] [--vector <path>]
  forge verify  --spec <path> --fixtures <path> [--vector <path>]
  forge eval    --suite <all | regenerate-cloudbeds | mutation>
  forge export  --spec <path> --target <lattice-dir>
      `);
      process.exit(command ? 1 : 0);
  }
}

async function handleOnboard(flags: Record<string, string>) {
  const provider = flags.provider;
  const fixturesPath = flags.fixtures;
  if (!provider || !fixturesPath) {
    throw new Error('Missing required flags: --provider and --fixtures');
  }

  const rawFixtures = JSON.parse(fs.readFileSync(path.resolve(fixturesPath), 'utf8'));
  const trainingFixtures = rawFixtures.filter((f: any) => !f.isHeldOut);
  const heldOutFixtures = rawFixtures.filter((f: any) => f.isHeldOut);
  const docsExcerpt = flags.docs ? fs.readFileSync(path.resolve(flags.docs), 'utf8') : undefined;
  const webhookVector = flags.vector
    ? JSON.parse(fs.readFileSync(path.resolve(flags.vector), 'utf8'))
    : undefined;

  console.log(` [Forge] Starting onboarding run for provider "${provider}"...`);
  const llm = new OpenAiCompatibleProvider();

  const result = await OnboardingOrchestrator.executeRun({
    provider,
    trainingFixtures,
    heldOutFixtures,
    docsExcerpt,
    webhookVector,
    llm,
  });

  const outDir = path.resolve(`./generated/${provider}`);
  fs.mkdirSync(outDir, { recursive: true });

  if (result.finalSpec && result.compiledBundle) {
    fs.writeFileSync(
      path.join(outDir, `${provider}.mapping.json`),
      JSON.stringify(result.finalSpec, null, 2)
    );
    fs.writeFileSync(
      path.join(outDir, result.compiledBundle.adapterFileName),
      result.compiledBundle.adapterCode
    );
    fs.writeFileSync(
      path.join(outDir, result.compiledBundle.schemaFileName),
      result.compiledBundle.schemaCode
    );
    fs.writeFileSync(
      path.join(outDir, result.compiledBundle.testFileName),
      result.compiledBundle.testCode
    );
  }

  console.log(`\n Status: ${result.status}`);
  console.log(` Attempts: ${result.attempts.length} | Cost: $${result.totalCostUsd} | Time: ${result.wallClockMs}ms`);
  console.log(` Artifacts written to: ${outDir}`);
}

async function handleVerify(flags: Record<string, string>) {
  const specPath = flags.spec;
  const fixturesPath = flags.fixtures;
  if (!specPath || !fixturesPath) {
    throw new Error('Missing required flags: --spec and --fixtures');
  }

  const spec = MappingSpecSchema.parse(JSON.parse(fs.readFileSync(path.resolve(specPath), 'utf8')));
  const rawFixtures = JSON.parse(fs.readFileSync(path.resolve(fixturesPath), 'utf8'));
  const webhookVector = flags.vector
    ? JSON.parse(fs.readFileSync(path.resolve(flags.vector), 'utf8'))
    : undefined;

  const compiled = await AdapterCompiler.compile(spec);
  const report = VerificationPipeline.runAll({
    adapterFileName: compiled.adapterFileName,
    adapterCode: compiled.adapterCode,
    spec,
    goldenFixtures: rawFixtures.filter((f: any) => !f.isHeldOut),
    heldOutFixtures: rawFixtures.filter((f: any) => f.isHeldOut),
    webhookVector,
  });

  for (const s of report.stages) {
    const icon = s.passed ? ' PASS' : ' FAIL';
    console.log(`${icon} | Stage: ${s.stage.padEnd(10)} (${s.durationMs}ms)`);
    for (const d of s.diagnostics) {
      console.log(`   └── [${d.code}] ${d.message}`);
    }
  }

  if (!report.allPassed) process.exit(1);
}

async function handleExport(flags: Record<string, string>) {
  const specPath = flags.spec;
  const targetLatticeDir = flags.target;
  if (!specPath || !targetLatticeDir) {
    throw new Error('Missing required flags: --spec and --target');
  }

  const spec = MappingSpecSchema.parse(JSON.parse(fs.readFileSync(path.resolve(specPath), 'utf8')));
  const compiled = await AdapterCompiler.compile(spec);

  // Enforce Review Gates before export
  const lowConfidenceFields = spec.fields.filter((f) => f.confidence < 0.85);
  if (lowConfidenceFields.length > 0 && flags.force !== 'true') {
    throw new Error(
      `Export Gate Blocked: ${lowConfidenceFields.length} field(s) have confidence < 0.85. Resolve in Studio first.`
    );
  }

  const targetDir = path.resolve(targetLatticeDir, 'libs/adapters/src/generated', spec.provider);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, compiled.adapterFileName), compiled.adapterCode);
  fs.writeFileSync(path.join(targetDir, compiled.testFileName), compiled.testCode);

  console.log(` Exported verified ${spec.provider} adapter directly into Lattice: ${targetDir}`);
}

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].replace(/^--/, '');
      out[key] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
    }
  }
  return out;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(` [Forge CLI Error]: ${err.message}`);
    process.exit(1);
  });
}