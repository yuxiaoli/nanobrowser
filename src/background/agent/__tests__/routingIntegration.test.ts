import { afterEach, describe, expect, it, vi } from 'vitest';
import { Executor, type ExecutorExtraArgs } from '../executor';
import type { NavigatorAgent } from '../agents/navigator';
import type { PlannerAgent, PlannerOutput } from '../agents/planner';
import { RequestCancelledError } from '../agents/errors';
import { ActionResult, type AgentContext, type AgentOutput } from '../types';
import { DOMElementNode, DOMTextNode } from '../../browser/dom/views';
import type { BrowserState } from '../../browser/views';
import type BrowserContext from '../../browser/context';
import type { ChatModel } from '../../llm/types';
import { NoopDecisionEngine } from '../decision/engine';
import type { DecisionEngine, RoutingDecision } from '../decision/types';
import { DEFAULT_JEV_SETTINGS } from '@extension/storage';
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

const originalModel = { provider: 'fixture', modelName: 'original' } as ChatModel;
const fastModel = { provider: 'fixture', modelName: 'fast' } as ChatModel;
const capableModel = { provider: 'fixture', modelName: 'capable' } as ChatModel;

interface ExecutorInternals {
  navigator: NavigatorAgent;
  planner: PlannerAgent;
  context: AgentContext;
  initializeRouting(): Promise<boolean>;
  navigate(): Promise<boolean>;
  forcePlanner: boolean;
  routingInitialized: boolean;
}

function routingDecision(outcome: RoutingDecision['outcome']): RoutingDecision {
  return {
    outcome,
    reasonCode: outcome === 'fast' ? 'fast_task' : outcome === 'capable' ? 'complex_task' : 'planner_required',
    confidence: 0.95,
    probability: 0.96,
    metadata: { elapsedMs: 1, apiCalls: 1 },
  };
}

function browserState(): BrowserState {
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
    url: 'https://example.test/result',
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

function fixture(outcome: RoutingDecision['outcome'] = 'fast', options: Partial<ExecutorExtraArgs> = {}) {
  const state = browserState();
  const browser = { getState: vi.fn(async () => state), cleanup: vi.fn() } as unknown as BrowserContext;
  const route = vi.fn<DecisionEngine['routeTask']>().mockResolvedValue(routingDecision(outcome));
  const engine = new NoopDecisionEngine();
  engine.routeTask = route;
  const notify = vi.fn();
  const executor = new Executor('Find the result', 'routing-task', browser, originalModel, {
    decisionEngine: engine,
    jevSettings: { ...DEFAULT_JEV_SETTINGS, enabled: true, routingEnabled: true },
    routingModels: { fast: fastModel, capable: capableModel },
    decisionNotify: notify,
    agentOptions: { maxSteps: 3, planningInterval: 10 },
    ...options,
  });
  const internals = executor as unknown as ExecutorInternals;
  const setModel = vi.spyOn(internals.navigator, 'setChatModel');
  const events: AgentEvent[] = [];
  executor.subscribeExecutionEvents(async event => {
    events.push(event);
  });
  return { executor, internals, route, engine, notify, setModel, browser, events };
}

function plan(done: boolean): AgentOutput<PlannerOutput> {
  return {
    id: 'planner',
    result: {
      observation: 'Result is visible',
      challenges: '',
      done,
      next_steps: done ? '' : 'Find the result',
      final_answer: done ? 'The result' : '',
      reasoning: '',
      web_task: true,
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('Executor model routing integration', () => {
  it.each([
    ['fast', fastModel],
    ['capable', capableModel],
  ] as const)('routes %s tasks once and selects the existing configured model', async (outcome, expectedModel) => {
    const { internals, route, setModel, browser } = fixture(outcome);
    expect(await internals.initializeRouting()).toBe(true);
    expect(await internals.initializeRouting()).toBe(true);
    expect(route).toHaveBeenCalledTimes(1);
    expect(setModel).toHaveBeenCalledWith(expectedModel);
    expect(route.mock.calls[0][0]).toMatchObject({ taskId: 'routing-task', task: 'Find the result' });
    expect(route.mock.calls[0][0]).not.toHaveProperty('browser');
    expect(browser.getState).not.toHaveBeenCalled();
  });

  it.each([
    { ...DEFAULT_JEV_SETTINGS, enabled: false, routingEnabled: true },
    { ...DEFAULT_JEV_SETTINGS, enabled: true, routingEnabled: false },
  ])('retains the original path when decisions or routing are disabled', async jevSettings => {
    const { internals, route, setModel } = fixture('fast', { jevSettings });
    expect(await internals.initializeRouting()).toBe(true);
    expect(route).not.toHaveBeenCalled();
    expect(setModel).not.toHaveBeenCalled();
  });

  it.each(['fast', 'capable'] as const)(
    'keeps the original model when the %s target is unconfigured',
    async outcome => {
      const { internals, setModel } = fixture(outcome, { routingModels: {} });
      expect(await internals.initializeRouting()).toBe(true);
      expect(setModel).not.toHaveBeenCalled();
    },
  );

  it('reclassifies a follow-up task and restores the default model before selecting its route', async () => {
    const { executor, internals, route, setModel } = fixture();
    await internals.initializeRouting();
    await internals.initializeRouting();
    executor.addFollowUpTask('Now compare the results');
    expect(setModel).toHaveBeenLastCalledWith(originalModel);
    expect(internals.routingInitialized).toBe(false);
    route.mockResolvedValueOnce(routingDecision('capable'));
    await internals.initializeRouting();
    expect(route).toHaveBeenCalledTimes(2);
    expect(route.mock.calls[1][0].task).toContain('Now compare the results');
    expect(setModel).toHaveBeenLastCalledWith(capableModel);
  });

  it('uses the existing Planner for uncertain tasks without substituting its model', async () => {
    const { internals, setModel } = fixture('planner');
    await internals.initializeRouting();
    expect(internals.forcePlanner).toBe(true);
    expect(setModel).not.toHaveBeenCalled();
  });

  it.each(['returned_error', 'thrown_error', 'blocked_action'] as const)(
    'escalates %s navigation to capable execution and Planner guidance without reclassifying',
    async failure => {
      const { internals, route, setModel } = fixture();
      await internals.initializeRouting();
      const execute = vi.spyOn(internals.navigator, 'execute');
      if (failure === 'thrown_error') execute.mockRejectedValue(new Error('fixture failure'));
      else if (failure === 'returned_error') execute.mockResolvedValue({ id: 'navigator', error: 'fixture failure' });
      else {
        internals.context.actionResults = [new ActionResult({ decisionBlocked: true })];
        execute.mockResolvedValue({ id: 'navigator', result: { done: false } });
      }
      expect(await internals.navigate()).toBe(false);
      expect(setModel).toHaveBeenLastCalledWith(capableModel);
      expect(internals.forcePlanner).toBe(true);
      expect(route).toHaveBeenCalledTimes(1);
    },
  );

  it('still requests Planner guidance when an escalation model is unconfigured', async () => {
    const { internals, setModel } = fixture('fast', { routingModels: { fast: fastModel } });
    await internals.initializeRouting();
    setModel.mockClear();
    vi.spyOn(internals.navigator, 'execute').mockResolvedValue({ id: 'navigator', error: 'fixture failure' });
    await internals.navigate();
    expect(internals.forcePlanner).toBe(true);
    expect(setModel).not.toHaveBeenCalled();
  });

  it('runs forced Planner guidance immediately after failure, even before the periodic interval', async () => {
    const { executor, internals, route, setModel, events } = fixture();
    const planner = vi
      .spyOn(internals.planner, 'execute')
      .mockResolvedValueOnce(plan(false))
      .mockResolvedValueOnce(plan(true));
    const navigate = vi
      .spyOn(internals.navigator, 'execute')
      .mockResolvedValue({ id: 'navigator', error: 'fixture failure' });
    vi.spyOn(internals.navigator, 'addStateMessageToMemory').mockResolvedValue();
    await executor.execute();
    expect(planner).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(route).toHaveBeenCalledTimes(1);
    expect(setModel).toHaveBeenLastCalledWith(capableModel);
    expect(events.some(event => event.state === ExecutionState.TASK_OK)).toBe(true);
  });
});

describe('Routing confirmation and cancellation', () => {
  it('requires explicit matching approval before initialization and ordinary resume cannot grant it', async () => {
    const { executor, internals, route, notify, setModel } = fixture('confirm');
    const initialization = internals.initializeRouting();
    let initialized = false;
    void initialization.then(() => {
      initialized = true;
    });
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    const request = notify.mock.calls[0][0];
    expect(request.actionName).toBe('task_execution');
    expect(executor.confirmDecision('wrong-task', request.decisionId, true)).toBe(false);
    expect(executor.confirmDecision(request.taskId, 'stale-id', true)).toBe(false);
    await executor.resume();
    expect(initialized).toBe(false);
    expect(internals.routingInitialized).toBe(false);
    expect(setModel).not.toHaveBeenCalled();
    expect(executor.confirmDecision(request.taskId, request.decisionId, true)).toBe(true);
    expect(await initialization).toBe(true);
    expect(internals.forcePlanner).toBe(true);
    expect(route).toHaveBeenCalledTimes(1);
  });

  it('does not initialize a rejected route and asks for a fresh approval after resume', async () => {
    const { executor, internals, route, notify } = fixture('confirm');
    const first = internals.initializeRouting();
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    const rejected = notify.mock.calls[0][0];
    executor.confirmDecision(rejected.taskId, rejected.decisionId, false);
    expect(await first).toBe(false);
    expect(internals.context.paused).toBe(true);
    expect(internals.routingInitialized).toBe(false);
    await executor.resume();
    const second = internals.initializeRouting();
    await vi.waitFor(() =>
      expect(notify.mock.calls.filter(([request]) => request.type === 'jev_confirmation')).toHaveLength(2),
    );
    const fresh = notify.mock.calls.findLast(([request]) => request.type === 'jev_confirmation')![0];
    expect(fresh.decisionId).not.toBe(rejected.decisionId);
    executor.confirmDecision(fresh.taskId, fresh.decisionId, true);
    expect(await second).toBe(true);
    expect(route).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending routing confirmation and clears its notification', async () => {
    const { internals, notify } = fixture('confirm');
    const initialization = internals.initializeRouting();
    const assertion = expect(initialization).rejects.toBeInstanceOf(RequestCancelledError);
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    internals.context.controller.abort();
    await assertion;
    expect(internals.routingInitialized).toBe(false);
    expect(notify.mock.calls.at(-1)?.[0].type).toBe('jev_confirmation_cleared');
  });

  it('does not emit success when cancellation arrives with a Planner completion claim', async () => {
    const { executor, internals, events } = fixture('planner');
    vi.spyOn(internals.planner, 'execute').mockImplementation(async () => {
      internals.context.stopped = true;
      return plan(true);
    });
    const navigator = vi.spyOn(internals.navigator, 'execute');
    await executor.execute();
    expect(events.some(event => event.state === ExecutionState.TASK_OK)).toBe(false);
    expect(events.some(event => event.state === ExecutionState.TASK_CANCEL)).toBe(true);
    expect(navigator).not.toHaveBeenCalled();
  });

  it('does not invoke Planner or Navigator after cancellation during task classification', async () => {
    const { executor, internals, route, events } = fixture();
    let resolveRoute: (route: RoutingDecision) => void = () => {};
    route.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveRoute = resolve;
        }),
    );
    const planner = vi.spyOn(internals.planner, 'execute').mockResolvedValue(plan(true));
    const navigator = vi.spyOn(internals.navigator, 'execute');
    const execution = executor.execute();
    await vi.waitFor(() => expect(route).toHaveBeenCalledTimes(1));
    internals.context.stopped = true;
    resolveRoute(routingDecision('fast'));
    await execution;
    expect(planner).not.toHaveBeenCalled();
    expect(navigator).not.toHaveBeenCalled();
    expect(events.some(event => event.state === ExecutionState.TASK_OK)).toBe(false);
    expect(events.some(event => event.state === ExecutionState.TASK_CANCEL)).toBe(true);
  });
});
