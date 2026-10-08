import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DecisionRuntime,
  DecisionRuntimeError,
  browserFingerprint,
  buildDecisionCandidates,
} from '../decision-runtime';
import { DecisionError } from '../decision/errors';
import { NoopDecisionEngine } from '../decision/engine';
import type { ActionResult, AgentContext } from '../types';
import { DOMElementNode, DOMTextNode } from '../../browser/dom/views';
import type { BrowserState } from '../../browser/views';
import type { ActionDecision, CompletionDecision, DecisionEngine } from '../decision/types';
import { ChatModelAuthError, RequestCancelledError } from '../agents/errors';

const metadata = { elapsedMs: 1, apiCalls: 1 };
const completion = (outcome: CompletionDecision['outcome'], isHandoff = false): CompletionDecision => ({
  outcome,
  isHandoff,
  reasonCode: outcome === 'complete' ? 'task_complete' : 'evidence_insufficient',
  confidence: 1,
  probability: 1,
  metadata,
});
const actionDecision = (outcome: ActionDecision['outcome']): ActionDecision => ({
  outcome,
  reasonCode: 'approved',
  confidence: 1,
  probability: 1,
  metadata,
});

export function stateFixture(): BrowserState {
  const button = new DOMElementNode({
    tagName: 'button',
    xpath: '/button',
    attributes: {},
    children: [new DOMTextNode('View result', true)],
    isVisible: true,
    isInViewport: true,
    isInteractive: true,
    highlightIndex: 1,
  });
  return {
    tabId: 1,
    url: 'https://example.test/result',
    title: 'Result',
    elementTree: button,
    selectorMap: new Map([[1, button]]),
    tabs: [{ id: 1, url: 'https://example.test/result', title: 'Result' }],
    screenshot: null,
    scrollY: 0,
    scrollHeight: 1000,
    visualViewportHeight: 800,
  };
}

function setup(enabled = true, notify = vi.fn()) {
  let state = stateFixture();
  const context = {
    taskId: 'task',
    controller: new AbortController(),
    actionResults: [] as ActionResult[],
    stopped: false,
    paused: false,
    browserContext: { getState: vi.fn(async () => state) },
    messageManager: { addMessageWithTokens: vi.fn() },
    emitEvent: vi.fn(),
    pause: vi.fn(async () => {
      context.paused = true;
    }),
  };
  const engine: DecisionEngine = {
    evaluateAction: vi.fn(async () => actionDecision('proceed')),
    verifyCompletion: vi.fn(async () => completion('complete')),
    routeTask: new NoopDecisionEngine().routeTask,
    selectAction: new NoopDecisionEngine().selectAction,
  };
  const runtime = new DecisionRuntime(engine, enabled, 'Find the result', context as unknown as AgentContext, notify);
  return {
    runtime,
    engine,
    context,
    notify,
    state,
    setState: (next: BrowserState) => {
      state = next;
    },
  };
}

beforeEach(() => vi.restoreAllMocks());

describe('decision runtime execution safeguards', () => {
  it('does not call decision services in disabled compatibility mode', async () => {
    const { runtime, engine, state } = setup(false);
    expect(await runtime.approve({ name: 'click_element', parameters: { index: 1 } }, state)).toBe(true);
    expect(engine.evaluateAction).not.toHaveBeenCalled();
  });

  it('does not approve a changed DOM, including a mutable cached state object', async () => {
    const { runtime, engine, state } = setup();
    vi.mocked(engine.evaluateAction).mockImplementation(async () => {
      state.selectorMap.get(1)!.attributes['aria-label'] = 'Delete';
      return actionDecision('proceed');
    });
    expect(await runtime.approve({ name: 'click_element', parameters: { index: 1 } }, state)).toBe(false);
  });

  it('binds confirmation to task and decision; resume cannot resolve it', async () => {
    const { runtime, state, notify } = setup();
    const pending = runtime.confirm('click_element', state, '{"index":1}');
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    const request = notify.mock.calls[0][0];
    expect(runtime.resolveConfirmation('other-task', request.decisionId, true)).toBe(false);
    expect(runtime.resolveConfirmation('task', 'old-id', true)).toBe(false);
    expect(runtime.awaitingConfirmation).toBe(true);
    expect(runtime.resolveConfirmation('task', request.decisionId, true)).toBe(true);
    expect(await pending).toBe(true);
    expect(runtime.awaitingConfirmation).toBe(false);
    expect(notify.mock.calls.at(-1)?.[0].type).toBe('jev_confirmation_cleared');
  });

  it('expires an approved action if browser state changed while awaiting the user', async () => {
    const { runtime, state, notify, setState } = setup();
    const pending = runtime.confirm('click_element', state);
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    setState({ ...state, url: 'https://example.test/different' });
    runtime.resolveConfirmation('task', notify.mock.calls[0][0].decisionId, true);
    expect(await pending).toBe(false);
  });

  it('rejects without executing and pauses for user review', async () => {
    const { runtime, state, notify, context } = setup();
    const pending = runtime.confirm('click_element', state);
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    runtime.resolveConfirmation('task', notify.mock.calls[0][0].decisionId, false);
    expect(await pending).toBe(false);
    expect(context.paused).toBe(true);
  });

  it('cancels outstanding approval and clears its UI notification', async () => {
    const { runtime, state, notify, context } = setup();
    const pending = runtime.confirm('click_element', state);
    const assertion = expect(pending).rejects.toBeInstanceOf(RequestCancelledError);
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    context.controller.abort();
    await assertion;
    expect(runtime.awaitingConfirmation).toBe(false);
    expect(notify.mock.calls.at(-1)?.[0].type).toBe('jev_confirmation_cleared');
  });

  it('pauses after two unsuccessful action proposals', async () => {
    const { runtime, engine, state, context } = setup();
    vi.mocked(engine.evaluateAction).mockResolvedValue(actionDecision('reconsider'));
    expect(await runtime.approve({ name: 'click_element', parameters: { index: 1 } }, state)).toBe(false);
    expect(context.paused).toBe(false);
    await runtime.approve({ name: 'click_element', parameters: { index: 1 } }, state);
    expect(context.paused).toBe(true);
  });

  it('annotates sensitive input fields only for evaluation', async () => {
    const { runtime, engine, state } = setup();
    state.selectorMap.get(1)!.attributes = { type: 'password', autocomplete: 'current-password' };
    const action = { name: 'input_text', parameters: { index: 1, text: 'not-a-pattern-secret' } };
    await runtime.approve(action, state);
    expect(vi.mocked(engine.evaluateAction).mock.calls[0][1].parameters.type).toBe('password');
    expect(action.parameters).toEqual({ index: 1, text: 'not-a-pattern-secret' });
  });

  it('shows a bounded target label in the sanitized confirmation without changing executable parameters', async () => {
    const { runtime, engine, state, notify } = setup();
    vi.mocked(engine.evaluateAction).mockResolvedValue(actionDecision('confirm'));
    const action = { name: 'click_element', parameters: { index: 1 } };
    const approval = runtime.approve(action, state);
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    const request = notify.mock.calls[0][0];
    const summary = JSON.parse(request.summary);
    expect(summary.target.text).toBe('View result');
    expect(summary.target.tagName).toBe('button');
    expect(summary.target).not.toHaveProperty('value');
    expect(action.parameters).toEqual({ index: 1 });
    runtime.resolveConfirmation(request.taskId, request.decisionId, true);
    expect(await approval).toBe(true);
  });

  it('redacts password-target input and DOM text from confirmation and omits its DOM value', async () => {
    const { runtime, engine, state, notify } = setup();
    const target = state.selectorMap.get(1)!;
    target.tagName = 'input';
    target.attributes = {
      type: 'password',
      name: 'user_password',
      autocomplete: 'current-password',
      value: 'private-dom-value',
    };
    target.children = [new DOMTextNode('private-dom-text', true)];
    vi.mocked(engine.evaluateAction).mockResolvedValue(actionDecision('confirm'));
    const action = { name: 'input_text', parameters: { index: 1, text: 'private-typed-value' } };
    const approval = runtime.approve(action, state);
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    const request = notify.mock.calls[0][0];
    const summary = JSON.parse(request.summary);
    expect(summary.text).toBe('[REDACTED]');
    expect(summary.target.text).toBe('[REDACTED]');
    expect(summary.target).not.toHaveProperty('value');
    for (const secret of ['private-dom-value', 'private-dom-text', 'private-typed-value']) {
      expect(request.summary).not.toContain(secret);
    }
    expect(action.parameters.text).toBe('private-typed-value');
    runtime.resolveConfirmation(request.taskId, request.decisionId, true);
    expect(await approval).toBe(true);
  });

  it('does not create confirmation for an action evaluated before a task change', async () => {
    const { runtime, engine, state, notify } = setup();
    vi.mocked(engine.evaluateAction).mockImplementation(async () => {
      runtime.setTask('A different goal');
      return actionDecision('confirm');
    });
    expect(await runtime.approve({ name: 'click_element', parameters: { index: 1 } }, state)).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    expect(runtime.awaitingConfirmation).toBe(false);
  });

  it('maps authentication to existing fatal errors without leaking underlying messages', async () => {
    const { runtime } = setup();
    await expect(
      runtime.invoke(async () => {
        throw new DecisionError('authentication', 401);
      }),
    ).rejects.toBeInstanceOf(ChatModelAuthError);
    await expect(
      runtime.invoke(async () => {
        throw new Error('secret browser content');
      }),
    ).rejects.toEqual(new DecisionRuntimeError('Jev decision failed. Check connectivity and decision settings.'));
  });
});

describe('completion evidence', () => {
  it('reuses established completion only for the same claim and evidence', async () => {
    const { runtime, engine } = setup();
    await runtime.verify({ text: 'Result established' });
    await runtime.verify({ text: 'Result established' });
    expect(engine.verifyCompletion).toHaveBeenCalledTimes(1);
  });

  it('does not let a previous completed claim bypass a later sign-in handoff', async () => {
    const { runtime, engine, context } = setup();
    await runtime.verify({ text: 'Result established', success: true });
    vi.mocked(engine.verifyCompletion).mockResolvedValue(completion('needs_verification', true));
    expect((await runtime.verify({ text: 'Sign in before continuing', success: false })).isHandoff).toBe(true);
    expect(engine.verifyCompletion).toHaveBeenCalledTimes(2);
    expect(context.paused).toBe(true);
  });

  it('does not accept completion when evidence changes during the API request', async () => {
    const { runtime, engine, state, setState, context } = setup();
    vi.mocked(engine.verifyCompletion).mockImplementation(async () => {
      setState({ ...state, url: 'https://example.test/new' });
      return completion('complete');
    });
    expect((await runtime.verify({ text: 'done' })).outcome).toBe('needs_verification');
    expect(context.paused).toBe(true);
  });

  it('caches refreshed verdicts against the refreshed state, never the original one', async () => {
    const { runtime, engine, state, setState } = setup();
    const refreshed = { ...state, title: 'Refreshed result' };
    vi.mocked(engine.verifyCompletion)
      .mockImplementationOnce(async () => {
        setState(refreshed);
        return completion('needs_verification');
      })
      .mockResolvedValue(completion('complete'));
    await runtime.verify({ text: 'done' });
    await runtime.verify({ text: 'done' });
    expect(engine.verifyCompletion).toHaveBeenCalledTimes(2);
    setState(state);
    await runtime.verify({ text: 'done' });
    expect(engine.verifyCompletion).toHaveBeenCalledTimes(3);
  });

  it('retains execution evidence when the upstream message manager consumes action results', async () => {
    const { runtime, context } = setup();
    runtime.recordExecution({ success: true, extractedContent: 'Found requested result', error: null } as ActionResult);
    context.actionResults = [];
    expect((await runtime.input()).outcomes).toEqual([
      { success: true, content: 'Found requested result', error: null },
    ]);
  });

  it('refreshes evidence only once before surfacing unverified completion', async () => {
    const { runtime, engine, context } = setup();
    vi.mocked(engine.verifyCompletion).mockResolvedValue(completion('needs_verification'));
    expect((await runtime.verify({ text: 'done' })).outcome).toBe('needs_verification');
    expect(engine.verifyCompletion).toHaveBeenCalledTimes(2);
    expect(context.paused).toBe(true);
  });

  it('does not turn a sign-in handoff into task success or navigate for more evidence', async () => {
    const { runtime, engine, context } = setup();
    vi.mocked(engine.verifyCompletion).mockResolvedValue(completion('needs_verification', true));
    expect((await runtime.verify({ text: 'Please sign in' })).isHandoff).toBe(true);
    expect(engine.verifyCompletion).toHaveBeenCalledTimes(1);
    expect(context.paused).toBe(true);
  });

  it('invalidates completion for a changed task or browser state', async () => {
    const { runtime, engine, state, setState } = setup();
    await runtime.verify({ text: 'done' });
    setState({ ...state, title: 'Different result' });
    await runtime.verify({ text: 'done' });
    runtime.setTask('Another user goal');
    await runtime.verify({ text: 'done' });
    expect(engine.verifyCompletion).toHaveBeenCalledTimes(3);
  });
});

describe('experimental candidate bounds', () => {
  it('excludes text-entry fields and binds click candidates to actual DOM indices', () => {
    const state = stateFixture();
    const input = new DOMElementNode({
      tagName: 'input',
      xpath: '/input',
      attributes: { type: 'text' },
      children: [],
      isVisible: true,
      isInteractive: true,
      isInViewport: true,
      highlightIndex: 2,
    });
    state.selectorMap.set(2, input);
    const candidates = buildDecisionCandidates(state);
    expect(candidates.find(candidate => candidate.id === 'click_1')?.action).toEqual({
      name: 'click_element',
      parameters: { index: 1 },
    });
    expect(candidates.some(candidate => candidate.id === 'click_2')).toBe(false);
  });

  it('includes input values in the private approval fingerprint', async () => {
    const state = stateFixture();
    const before = await browserFingerprint(state);
    state.selectorMap.get(1)!.attributes.value = 'changed';
    expect(await browserFingerprint(state)).not.toBe(before);
  });
});
