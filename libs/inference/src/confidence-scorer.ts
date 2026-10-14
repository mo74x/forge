import { FieldMapping, applyTransform, getByPath } from '@lattice/mapping-spec';
import { FieldProfile } from './quirk-detector';

export class ConfidenceScorer {
  static scoreFieldMapping(
    mapping: FieldMapping,
    samples: Record<string, unknown>[],
    profiles: Map<string, FieldProfile>
  ): { confidence: number; evidence: string[]; flagged: boolean } {
    // Custom escape-hatch code is ALWAYS capped at 0.50 and flagged for human review
    if (mapping.transform.kind === 'custom') {
      return {
        confidence: 0.5,
        evidence: ['ESCAPE_HATCH: Requires mandatory human review'],
        flagged: true,
      };
    }

    const profile = profiles.get(mapping.source.path);
    if (!profile && mapping.transform.kind !== 'concat') {
      return { confidence: 0.0, evidence: [`Path ${mapping.source.path} not found in samples`], flagged: true };
    }

    let parseSuccesses = 0;
    let applicableSamples = 0;
    const computedEvidence: string[] = [];

    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      const rawVal = getByPath(sample, mapping.source.path);

      if (rawVal === undefined || rawVal === null) {
        if (mapping.required && mapping.transform.kind !== 'concat') {
          // Required field missing in sample -> penalize
          applicableSamples++;
        }
        continue;
      }

      applicableSamples++;
      try {
        const transformed = applyTransform(rawVal, sample, mapping.transform);
        if (transformed !== undefined && transformed !== null && transformed !== '') {
          parseSuccesses++;
          if (computedEvidence.length < 3) {
            computedEvidence.push(`sample-${i + 1}: ${JSON.stringify(rawVal)} → ${JSON.stringify(transformed)}`);
          }
        }
      } catch {
        // Transform threw on this sample
      }
    }

    const parseAgreement = applicableSamples > 0 ? parseSuccesses / applicableSamples : 0;
    const coverageRatio = profile ? profile.presentCount / profile.totalSamples : 1;

    // Penalize if optionality in spec contradicts sample presence
    const optionalityPenalty = !mapping.required && coverageRatio < 1 ? 1.0 : coverageRatio;

    const rawScore = 0.65 * parseAgreement + 0.35 * optionalityPenalty;
    const confidence = Math.round(rawScore * 100) / 100;

    return {
      confidence,
      evidence: computedEvidence,
      flagged: confidence < 0.85,
    };
  }
}