import { describe, expect, it, vi } from 'vitest';
import { Executor } from '../executor';
import { Action } from '../actions/builder';
import { doneActionSchema, clickElementActionSchema } from '../actions/schemas';
import { NavigatorAgent, NavigatorActionRegistry } from '../agents/navigator';
import type { PlannerAgent } from '../agents/planner';
import { ActionResult, type AgentContext } from '../types';
import { DOMElementNode, DOMTextNode } from '../../browser/dom/views';
import type { BrowserState } from '../../browser/views';
import type BrowserContext from '../../browser/context';
import type { ChatModel } from '../../llm/types';
import { NoopDecisionEngine } from '../decision/engine';
import type { CompletionDecision, DecisionEngine } from '../decision/types';
import { DecisionRuntimeError } from '../decision-runtime';
import type { DecisionRuntime } from '../decision-runtime';
import { DEFAULT_JEV_SETTINGS } from '@extension/storage';
import type { BasePrompt } from '../prompts/base';
import type { AgentEvent } from '../event/types';
import { ExecutionState } from '../event/types';

vi.mock('@extension/i18n', () => ({ t: (key: string) => key }));
vi.mock('@src/background/services/analytics', () => ({
  analytics: {
    trackTaskStart: vi.fn(),
    trackTaskComplete: vi.fn(),
    trackTaskFailed: vi.fn(),
    trackTaskCancelled: vi.fn(),
    categorizeError: vi.fn(() => 'test'),
  },
}));
vi.mock('@extension/storage/lib/chat', () => ({ chatHistoryStore: { storeAgentStepHistory: vi.fn() } }));

function state(): BrowserState {
  const element = new DOMElementNode({
    tagName: 'button',
    xpath: '/button',
    attributes: {},
    children: [new DOMTextNode('Result', true)],
    isVisible: true,
    isInteractive: true,
    isInViewport: true,
    highlightIndex: 1,
  });
  return {
    tabId: 1,
    url: 'https://example.test',
    title: 'Result',
    elementTree: element,
    selectorMap: new Map([[1, element]]),
    tabs: [],
    screenshot: null,
    scrollY: 0,
    scrollHeight: 1000,
    visualViewportHeight: 800,
  };
}
const model = { provider: 'test', modelName: 'test' } as ChatModel;

function navigatorFixture(enabled = true) {
  const current = state();
  const decision = {
    enabled,
    approve: vi.fn(async () => true),
    verify: vi.fn(async () => ({ outcome: 'complete', reasonCode: 'task_complete', isHandoff: false })),
    recordExecution: vi.fn(),
  };
  const context = {
    options: {},
    browserContext: { getState: vi.fn(async () => current), removeHighlight: vi.fn() },
    paused: false,
    stopped: false,
    decision,
    emitEvent: vi.fn(),
    controller: new AbortController(),
  } as unknown as AgentContext;
  const click = vi.fn(async () => new ActionResult({ success: true }));
  const done = vi.fn(async () => new ActionResult({ isDone: true }));
  const registry = new NavigatorActionRegistry([
    new Action(click, clickElementActionSchema, true),
    new Action(done, doneActionSchema),
  ]);
  const agent = new NavigatorAgent(registry, { context, chatLLM: model, prompt: {} as BasePrompt });
  const run = (actions: Record<string, unknown>[]) =>
    (
      agent as unknown as { doMultiAction: (actions: Record<string, unknown>[]) => Promise<ActionResult[]> }
    ).doMultiAction(actions);
  return { agent, run, decision, click, done, context };
}

describe('Navigator actual execution seam', () => {
  it('does not execute a rejected action or the rest of its batch', async () => {
    const fixture = navigatorFixture();
    fixture.decision.approve.mockResolvedValue(false);
    const result = await fixture.run([{ click_element: { index: 1 } }, { click_element: { index: 1 } }]);
    expect(fixture.click).not.toHaveBeenCalled();
    expect(fixture.decision.approve).toHaveBeenCalledTimes(1);
    expect(result[0].includeInMemory).toBe(true);
  });

  it('validates parameters before paying for any decision', async () => {
    const fixture = navigatorFixture();
    await fixture.run([{ click_element: { index: 'invalid' } }]);
    expect(fixture.decision.approve).not.toHaveBeenCalled();
    expect(fixture.click).not.toHaveBeenCalled();
  });

  it('propagates decision service errors instead of continuing the action batch', async () => {
    const fixture = navigatorFixture();
    fixture.decision.approve.mockRejectedValue(new DecisionRuntimeError('service unavailable'));
    await expect(
      fixture.run([{ click_element: { index: 1 } }, { click_element: { index: 1 } }]),
    ).rejects.toBeInstanceOf(DecisionRuntimeError);
    expect(fixture.click).not.toHaveBeenCalled();
  });

  it('rejects Navigator done before its success handler emits anything', async () => {
    const fixture = navigatorFixture();
    fixture.decision.verify.mockResolvedValue({
      outcome: 'needs_verification',
      reasonCode: 'evidence_insufficient',
      isHandoff: false,
    });
    const result = await fixture.run([{ done: { text: 'done', success: true } }]);
    expect(fixture.done).not.toHaveBeenCalled();
    expect(result[0].isDone).toBe(false);
  });

  it('retains existing execution behavior with Jev disabled', async () => {
    const fixture = navigatorFixture(false);
    const result = await fixture.run([{ done: { text: 'done', success: true } }]);
    expect(fixture.done).toHaveBeenCalledTimes(1);
    expect(fixture.decision.verify).not.toHaveBeenCalled();
    expect(result[0].isDone).toBe(true);
    expect(result).toHaveLength(1);
  });

  it('covers historical replay with the same gate', async () => {
    const fixture = navigatorFixture();
    fixture.decision.approve.mockResolvedValue(false);
    const history = {
      modelOutput: JSON.stringify({ current_state: { next_goal: 'click' }, action: [{ click_element: { index: 1 } }] }),
      result: [new ActionResult()],
      state: null,
    };
    const result = await fixture.agent.executeHistoryStep(history as never, 0, 1, 1, 0);
    expect(fixture.decision.approve).toHaveBeenCalledTimes(1);
    expect(fixture.click).not.toHaveBeenCalled();
    expect(result[0].isDone).toBe(false);
  });
});

describe('Planner final authority cannot bypass completion verification', () => {
  it('does not emit task success for an unverified first Planner declaration', async () => {
    const browser = { getState: vi.fn(async () => state()), cleanup: vi.fn() } as unknown as BrowserContext;
    const verify = vi.fn<DecisionEngine['verifyCompletion']>();
    const response = (outcome: CompletionDecision['outcome']): CompletionDecision => ({
      outcome,
      reasonCode: outcome === 'complete' ? 'task_complete' : 'task_incomplete',
      isHandoff: false,
      confidence: 1,
      probability: 1,
      metadata: { elapsedMs: 1, apiCalls: 1 },
    });
    verify.mockResolvedValueOnce(response('incomplete')).mockResolvedValueOnce(response('complete'));
    const engine = new NoopDecisionEngine();
    engine.verifyCompletion = verify;
    const executor = new Executor('Find result', 'task', browser, model, {
      decisionEngine: engine,
      jevSettings: { ...DEFAULT_JEV_SETTINGS, enabled: true },
      agentOptions: { maxSteps: 3, planningInterval: 1 },
    });
    const internals = executor as unknown as {
      planner: PlannerAgent;
      navigator: NavigatorAgent;
      context: AgentContext;
    };
    const plannerResult = {
      observation: 'Result visible',
      challenges: '',
      done: true,
      next_steps: '',
      final_answer: 'Result',
      reasoning: '',
      web_task: true,
    };
    vi.spyOn(internals.planner, 'execute').mockImplementation(async () => ({
      id: 'planner',
      result: { ...plannerResult },
    }));
    vi.spyOn(internals.navigator, 'execute').mockResolvedValue({ id: 'navigator', result: { done: false } });
    vi.spyOn(internals.navigator, 'addStateMessageToMemory').mockResolvedValue();
    const events: AgentEvent[] = [];
    executor.subscribeExecutionEvents(async event => {
      events.push(event);
    });
    await executor.execute();
    expect(verify).toHaveBeenCalledTimes(2);
    expect(internals.navigator.execute).toHaveBeenCalledTimes(1);
    expect(events.filter(event => event.state === ExecutionState.TASK_OK)).toHaveLength(1);
  });

  it('ordinary resume never approves the pending action', async () => {
    const browser = {} as BrowserContext;
    const executor = new Executor('task', 'task', browser, model);
    const internals = executor as unknown as { context: AgentContext };
    internals.context.paused = true;
    internals.context.decision = { awaitingConfirmation: true } as DecisionRuntime;
    await executor.resume();
    expect(internals.context.paused).toBe(true);
  });
});
