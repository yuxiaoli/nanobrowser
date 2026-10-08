import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NoopDecisionEngine } from '../src/background/agent/decision/engine';
import { JevDecisionEngine } from '../src/background/agent/decision/jev';
import { DEFAULT_DECISION_CONFIG } from '../src/background/agent/decision/types';
import type {
  DecisionAction,
  DecisionCandidate,
  DecisionContext,
  DecisionEngine,
} from '../src/background/agent/decision/types';

interface Fixture {
  id: string;
  kind: 'action' | 'completion' | 'routing' | 'selection';
  task: { en: string; zh: string };
  browser: NonNullable<DecisionContext['browser']>;
  action?: DecisionAction;
  candidates?: DecisionCandidate[];
  claimedCompletion?: string;
  choice: string;
  confidence: number;
  expected: string;
  handoff?: boolean;
  acceptance: string;
}

const fixturePath = resolve(import.meta.dirname, '../docs/evaluation/jev-fixtures.json');
const packageInfo: { version: string } = JSON.parse(
  await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8'),
);
const fixtures: Fixture[] = JSON.parse(await readFile(fixturePath, 'utf8'));
if (fixtures.length !== 20 || new Set(fixtures.map(fixture => fixture.id)).size !== 20) {
  throw new Error('Evaluation requires exactly 20 uniquely identified task fixtures');
}

function mockResponse(fixture: Fixture): Response {
  const question = { action: 'action', completion: 'completion', routing: 'route', selection: 'selection' }[
    fixture.kind
  ];
  const choices = {
    action: ['proceed', 'reconsider', 'confirm'],
    completion: ['complete', 'incomplete', 'needs_verification'],
    routing: ['fast', 'capable', 'planner', 'confirm'],
    selection: [...(fixture.candidates ?? []).map(candidate => candidate.id), '__fallback__'],
  }[fixture.kind];
  const otherProbability = (1 - fixture.confidence) / Math.max(1, choices.length - 1);
  const probabilities = Object.fromEntries(
    choices.map(choice => [choice, choice === fixture.choice ? fixture.confidence : otherProbability]),
  );
  return new Response(
    JSON.stringify({
      model: 'jev-offline-fixture',
      answers: {
        [question]: { type: 'choice', choice: fixture.choice, probabilities, confidence: fixture.confidence },
        ...(fixture.kind === 'completion' ? { handoff: { type: 'noul', noul: fixture.handoff ? 0.99 : 0.01 } } : {}),
      },
      usage: { input_tokens: 100, output_tokens: 10 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

async function evaluate(engine: DecisionEngine, fixture: Fixture, language: 'en' | 'zh') {
  const context: DecisionContext = {
    taskId: `${fixture.id}-${language}`,
    task: fixture.task[language],
    browser: fixture.browser,
    claimedCompletion: fixture.claimedCompletion,
  };
  switch (fixture.kind) {
    case 'action':
      if (!fixture.action) throw new Error(`Missing action for ${fixture.id}`);
      return engine.evaluateAction(context, fixture.action);
    case 'completion':
      return engine.verifyCompletion(context);
    case 'routing':
      return engine.routeTask(context);
    case 'selection':
      return engine.selectAction(context, fixture.candidates ?? []);
  }
}

const results = [];
for (const fixture of fixtures) {
  for (const language of ['en', 'zh'] as const) {
    let mockCalls = 0;
    const mockFetch: typeof fetch = async () => {
      mockCalls++;
      return mockResponse(fixture);
    };
    const enhanced = new JevDecisionEngine(
      { ...DEFAULT_DECISION_CONFIG, enabled: true, apiKey: 'offline-fixture-key', model: 'jev-offline-fixture' },
      { fetch: mockFetch },
    );
    const baseline = await evaluate(new NoopDecisionEngine(), fixture, language);
    const decision = await evaluate(enhanced, fixture, language);
    const handoffMatches = !('isHandoff' in decision) || decision.isHandoff === Boolean(fixture.handoff);
    results.push({
      taskId: fixture.id,
      language,
      kind: fixture.kind,
      expectedControlOutcome: fixture.expected,
      baseline,
      enhanced: decision,
      mockCalls,
      passed: decision.outcome === fixture.expected && handoffMatches && mockCalls === 1,
    });
  }
}

const report = {
  mode: 'offline-mocked-decision-contract',
  generatedAt: new Date().toISOString(),
  extensionVersion: packageInfo.version,
  ...(process.env.GITHUB_SHA ? { commitSha: process.env.GITHUB_SHA } : {}),
  taskFixtures: fixtures.length,
  languages: ['en', 'zh'],
  controlChecks: results.length,
  passedControlChecks: results.filter(result => result.passed).length,
  externalApiCalls: 0,
  liveMetrics: {
    taskSuccessRate: null,
    incorrectActions: null,
    latencyMs: null,
    apiCalls: null,
    estimatedCostUsd: null,
  },
  limitations: [
    'Responses are supplied deterministic fixtures, not Jev predictions.',
    'No browser action, TypeSafe call, or generative LLM call was executed.',
    'Adapter timings and synthetic usage cannot estimate live latency or cost.',
    'Passing control checks does not prove task success or performance improvement.',
  ],
  results,
};
await mkdir(resolve(import.meta.dirname, '../dist-zip'), { recursive: true });
await writeFile(
  resolve(import.meta.dirname, '../dist-zip/jev-evaluation.json'),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(`Offline control checks: ${report.passedControlChecks}/${report.controlChecks}; external API calls: 0.`);
if (report.passedControlChecks !== report.controlChecks) process.exitCode = 1;
