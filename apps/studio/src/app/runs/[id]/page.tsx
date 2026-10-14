'use client';

import React, { useState } from 'react';

interface FieldRow {
  canonicalField: string;
  source: { path: string; fallbackPaths: string[] };
  transform: { kind: string; [key: string]: any };
  required: boolean;
  confidence: number;
  evidence: string[];
}

export default function ForgeReviewStudioPage() {
  const [fields, setFields] = useState<FieldRow[]>([
    {
      canonicalField: 'propertyId',
      source: { path: '$.property_id', fallbackPaths: [] },
      transform: { kind: 'identity' },
      required: true,
      confidence: 1.0,
      evidence: ['sample-1: "prop_101" → "prop_101"'],
    },
    {
      canonicalField: 'guestName',
      source: { path: '$.guest_first_name', fallbackPaths: [] },
      transform: { kind: 'concat', paths: ['$.guest_first_name', '$.guest_last_name'], separator: ' ' },
      required: true,
      confidence: 0.99,
      evidence: ['sample-1: "Layla" + "Hassan" → "Layla Hassan"'],
    },
    {
      canonicalField: 'checkIn',
      source: { path: '$.start_date', fallbackPaths: [] },
      transform: { kind: 'isoDate', inputFormat: 'ISO_STRING' },
      required: true,
      confidence: 1.0,
      evidence: ['sample-1: "2026-11-01T00:00:00Z" → "2026-11-01"'],
    },
    {
      canonicalField: 'totalAmount',
      source: { path: '$.total_cents', fallbackPaths: [] },
      transform: { kind: 'centsToDecimal', scale: 2 },
      required: true,
      confidence: 0.99,
      evidence: ['Attempt 2 Auto-Repaired: 145000 → 1450.00'],
    },
    {
      canonicalField: 'status',
      source: { path: '$.booking_status', fallbackPaths: [] },
      transform: { kind: 'enumMap', map: { reserved: 'CONFIRMED', void: 'CANCELLED' } },
      required: true,
      confidence: 0.96,
      evidence: ['sample-1: "reserved" → "CONFIRMED"'],
    },
  ]);

  const [sampleJson, setSampleJson] = useState(
    JSON.stringify(
      {
        reservation_id: 'cb_9921',
        property_id: 'prop_zamalek_01',
        room_identifier: 'penthouse_4',
        guest_first_name: 'Karim',
        guest_last_name: 'Nabil',
        start_date: '2026-11-10T00:00:00Z',
        end_date: '2026-11-15T00:00:00Z',
        booking_status: 'reserved',
        total_cents: 95000,
        currency_code: 'usd',
        has_pet_fee: true,
      },
      null,
      2
    )
  );

  const stages = [
    { name: '1. TYPECHECK', status: 'PASS', ms: '42ms' },
    { name: '2. AST_SCAN', status: 'PASS', ms: '8ms' },
    { name: '3. GOLDEN', status: 'PASS', ms: '19ms' },
    { name: '4. HELD_OUT', status: 'PASS', ms: '14ms' },
    { name: '5. PROPERTY (200x)', status: 'PASS', ms: '112ms' },
    { name: '6. WEBHOOK_HMAC', status: 'PASS', ms: '5ms' },
  ];

  const allGatesGreen = fields.every((f) => f.confidence >= 0.85);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 font-sans">
      {/* Header & Export Gate */}
      <header className="flex items-center justify-between border-b border-slate-800 pb-4 mb-6">
        <div>
          <div className="flex items-center gap-3">
            <span className="px-2.5 py-0.5 text-xs font-mono bg-sky-950 text-sky-400 border border-sky-800 rounded">
              FORGE COMPILER v1.0
            </span>
            <h1 className="text-xl font-bold tracking-tight">
              Partner Onboarding Review: <span className="text-sky-400 font-mono">cloudbeds_mock</span>
            </h1>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Attempt 2 of 3 converged to green • Total Cost: $0.0197 • Runtime LLM Calls: 0
          </p>
        </div>

        <button
          disabled={!allGatesGreen}
          className={`px-4 py-2 rounded font-semibold text-sm transition ${
            allGatesGreen
              ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-950'
              : 'bg-slate-800 text-slate-500 cursor-not-allowed'
          }`}
        >
          ✓ Approve & Export Adapter to Lattice
        </button>
      </header>

      {/* 6-Stage Verification Pipeline Bar */}
      <section className="grid grid-cols-6 gap-3 mb-6">
        {stages.map((st) => (
          <div
            key={st.name}
            className="bg-slate-900 border border-emerald-800/60 rounded p-3 flex flex-col justify-between"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono text-slate-300">{st.name}</span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 bg-emerald-950 text-emerald-400 rounded">
                {st.status}
              </span>
            </div>
            <span className="text-xs text-slate-500 font-mono mt-2">{st.ms}</span>
          </div>
        ))}
      </section>

      {/* Main Split Workbench: Mapping Table (Left) + Live Sandbox Simulator (Right) */}
      <div className="grid grid-cols-12 gap-6">
        {/* Declarative Mapping Spec Table */}
        <div className="col-span-7 bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800 flex justify-between items-center">
            <h2 className="text-sm font-semibold">Declarative Field Mapping Spec</h2>
            <span className="text-xs text-slate-400 font-mono">Unmapped Policy: CAPTURE_ALL</span>
          </div>
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950/60 text-slate-400 font-mono uppercase">
              <tr>
                <th className="p-3">Canonical Field</th>
                <th className="p-3">Partner JSONPath</th>
                <th className="p-3">Transform</th>
                <th className="p-3">Confidence</th>
                <th className="p-3">Sample Evidence</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {fields.map((f) => (
                <tr key={f.canonicalField} className="hover:bg-slate-800/40">
                  <td className="p-3 font-mono font-semibold text-sky-300">{f.canonicalField}</td>
                  <td className="p-3 font-mono text-slate-300">{f.source.path}</td>
                  <td className="p-3">
                    <span className="px-2 py-0.5 bg-indigo-950 text-indigo-300 border border-indigo-800 rounded font-mono">
                      {f.transform.kind}
                    </span>
                  </td>
                  <td className="p-3 font-mono">
                    <span className="text-emerald-400 font-semibold">
                      {(f.confidence * 100).toFixed(0)}%
                    </span>
                  </td>
                  <td className="p-3 text-slate-400 font-mono truncate max-w-[200px]">
                    {f.evidence[0]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Sandboxed Live Payload Simulator */}
        <div className="col-span-5 bg-slate-900 border border-slate-800 rounded-lg p-4 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Live Sandboxed Simulator (V8 Isolate)</h2>
            <span className="text-xs font-mono px-2 py-0.5 bg-slate-800 text-emerald-400 rounded">
              ⚡ 0.19ms CPU | 0 LLM Calls
            </span>
          </div>

          <div>
            <label className="text-xs font-mono text-slate-400 block mb-1">
              Raw Partner Payload Input:
            </label>
            <textarea
              value={sampleJson}
              onChange={(e) => setSampleJson(e.target.value)}
              rows={8}
              className="w-full bg-slate-950 border border-slate-800 rounded p-2.5 font-mono text-xs text-slate-200"
            />
          </div>

          <div>
            <label className="text-xs font-mono text-slate-400 block mb-1">
              Compiled Canonical Output + Unmapped Metadata Capture:
            </label>
            <pre className="bg-slate-950 border border-emerald-900/50 rounded p-2.5 font-mono text-xs text-emerald-300 overflow-x-auto">
              {JSON.stringify(
                {
                  entityType: 'booking',
                  externalId: 'cb_9921',
                  data: {
                    propertyId: 'prop_zamalek_01',
                    unitId: 'penthouse_4',
                    guestName: 'Karim Nabil',
                    checkIn: '2026-11-10',
                    checkOut: '2026-11-15',
                    status: 'CONFIRMED',
                    totalAmount: 950.0,
                    currency: 'USD',
                    unmappedMetadata: {
                      '$.has_pet_fee': true,
                    },
                  },
                },
                null,
                2
              )}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}