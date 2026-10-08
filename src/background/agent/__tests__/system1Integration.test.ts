import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { NavigatorAgent, NavigatorActionRegistry } from '../agents/navigator';
import { Action } from '../actions/builder';
import {
  clickElementActionSchema,
  doneActionSchema,
  nextPageActionSchema,
  previousPageActionSchema,
  selectDropdownOptionActionSchema,
  switchTabActionSchema,
} from '../actions/schemas';
import { ActionResult, AgentContext } from '../types';
import { DOMElementNode, DOMTextNode } from '../../browser/dom/views';
import type { BrowserState } from '../../browser/views';
import type BrowserContext from '../../browser/context';
import type { ChatModel } from '../../llm/types';
import { NoopDecisionEngine } from '../decision/engine';
import type { DecisionEngine, SelectionDecision } from '../decision/types';
import { DecisionRuntime, buildDecisionCandidates } from '../decision-runtime';
import MessageManager from '../messages/service';
import { EventManager } from '../event/manager';
import { NavigatorPrompt } from '../prompts/navigator';
import type { NavigatorOutput } from '../agents/navigatorOutput';

vi.mock('@extension/i18n', () => ({ t: (key: string) => key }));
vi.mock('@src/background/services/analytics', () => ({ analytics: { trackDomainVisit: vi.fn() } }));

function element(index: number, tagName = 'button', attributes: Record<string, string> = {}): DOMElementNode {
  return new DOMElementNode({
    tagName,
    xpath: '/' + tagName + '[' + index + ']',
    attributes,
    children: [new DOMTextNode('Element ' + index, true)],
    isVisible: true,
    isInteractive: true,
    isInViewport: true,
    highlightIndex: index,
  });
}

function browserState(): BrowserState {
  const button = element(1);
  return {
    tabId: 1,
    url: 'https://example.test/result',
    title: 'Result',
    elementTree: button,
    selectorMap: new Map([[1, button]]),
    tabs: [],
    screenshot: null,
    scrollY: 0,
    scrollHeight: 1000,
    visualViewportHeight: 800,
  };
}

const metrics = { confidence: 0.95, probability: 0.96, metadata: { elapsedMs: 1, apiCalls: 1 } };
function selection(candidateId = 'click_1'): SelectionDecision {
  return { outcome: 'selected', candidateId, reasonCode: 'candidate_selected', ...metrics };
}
function fallback(): SelectionDecision {
  return { outcome: 'fallback', reasonCode: 'generative_fallback', ...metrics };
}
const generated: NavigatorOutput = {
  current_state: { evaluation_previous_goal: '', memory: '', next_goal: 'Complete with the result' },
  action: [{ done: { text: 'The requested result', success: true } }],
};

function fixture(system1Enabled = true, decisionEnabled = true, invalidClickSchema = false) {
  let current = browserState();
  const browser = {
    getCachedState: vi.fn(async () => current),
    getState: vi.fn(async () => current),
    removeHighlight: vi.fn(),
  } as unknown as BrowserContext;
  const messages = new MessageManager();
  const context = new AgentContext('system1-task', browser, messages, new EventManager(), {});
  const engine = new NoopDecisionEngine();
  const select = vi.fn<DecisionEngine['selectAction']>().mockResolvedValue(selection());
  const evaluate = vi.fn<DecisionEngine['evaluateAction']>().mockResolvedValue({
    outcome: 'proceed',
    reasonCode: 'approved',
    ...metrics,
  });
  engine.selectAction = select;
  engine.evaluateAction = evaluate;
  context.decision = new DecisionRuntime(engine, decisionEnabled, 'Click the result', context);
  const click = vi.fn(async () => new ActionResult({ success: true }));
  const done = vi.fn(async () => new ActionResult({ isDone: true, success: true }));
  const scroll = vi.fn(async () => new ActionResult({ success: true }));
  const switchTab = vi.fn(async () => new ActionResult({ success: true }));
  const dropdown = vi.fn(async () => new ActionResult({ success: true }));
  const clickSchema = invalidClickSchema
    ? { ...clickElementActionSchema, schema: z.object({ index: z.number().min(2) }) }
    : clickElementActionSchema;
  const registry = new NavigatorActionRegistry([
    new Action(click, clickSchema, true),
    new Action(done, doneActionSchema),
    new Action(scroll, nextPageActionSchema),
    new Action(scroll, previousPageActionSchema),
    new Action(switchTab, switchTabActionSchema),
    new Action(dropdown, selectDropdownOptionActionSchema, true),
  ]);
  const prompt = new NavigatorPrompt(10);
  messages.initTaskMessages(prompt.getSystemMessage(), 'Click the result');
  const navigator = new NavigatorAgent(
    registry,
    { context, chatLLM: { provider: 'fixture', modelName: 'fixture' } as ChatModel, prompt },
    { system1Enabled },
  );
  vi.spyOn(navigator, 'addStateMessageToMemory').mockResolvedValue();
  const invoke = vi.spyOn(navigator, 'invoke').mockResolvedValue(generated);
  return {
    navigator,
    context,
    registry,
    select,
    evaluate,
    invoke,
    click,
    done,
    scroll,
    switchTab,
    dropdown,
    state: current,
    setState: (state: BrowserState) => {
      current = state;
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('System-1 through the real Navigator execution path', () => {
  it('skips generative invocation for a valid selected action while retaining evaluation and normal execution', async () => {
    const { navigator, select, evaluate, invoke, click, context } = fixture();
    const output = await navigator.execute();
    expect(select).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0][1]).toMatchObject({ name: 'click_element', parameters: { index: 1 } });
    expect(click).toHaveBeenCalledWith(expect.objectContaining({ index: 1 }));
    expect(output.result).toEqual({ done: false });
    expect(context.decision?.records.map(record => record.operation)).toEqual(['selection', 'action', 'execution']);
    expect(context.history.history).toHaveLength(1);
  });

  it('still blocks a selected action when the normal evaluation gate rejects it', async () => {
    const { navigator, evaluate, invoke, click, context } = fixture();
    evaluate.mockResolvedValue({ outcome: 'reconsider', reasonCode: 'action_reconsideration', ...metrics });
    await navigator.execute();
    expect(click).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(context.actionResults[0].decisionBlocked).toBe(true);
  });

  it.each([fallback(), selection('invented-candidate')])(
    'uses the generative Navigator for fallback or unknown selection IDs',
    async answer => {
      const { navigator, select, invoke, click, done } = fixture();
      select.mockResolvedValue(answer);
      const output = await navigator.execute();
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(click).not.toHaveBeenCalled();
      expect(done).toHaveBeenCalledTimes(1);
      expect(output.result?.done).toBe(true);
    },
  );

  it('falls back when browser targets change while the selection is in flight', async () => {
    const { navigator, select, invoke, click, state, setState } = fixture();
    select.mockImplementation(async () => {
      setState({ ...state, url: 'https://example.test/different' });
      return selection();
    });
    await navigator.execute();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(click).not.toHaveBeenCalled();
  });

  it('filters invalid candidates through the actual registered action schema before selection', async () => {
    const { navigator, select, invoke, click } = fixture(true, true, true);
    await navigator.execute();
    expect(select).toHaveBeenCalledTimes(1);
    expect(select.mock.calls[0][1].some(candidate => candidate.id === 'click_1')).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(click).not.toHaveBeenCalled();
  });

  it.each([
    [false, true],
    [true, false],
  ])('avoids selection calls when experimental mode or decisions are disabled', async (system1, decisions) => {
    const { navigator, select, invoke } = fixture(system1, decisions);
    await navigator.execute();
    expect(select).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it.each(['stopped', 'paused'] as const)(
    'does not invoke generative fallback after the task becomes %s during selection',
    async stateFlag => {
      const { navigator, context, select, invoke, click } = fixture();
      select.mockImplementation(async () => {
        context[stateFlag] = true;
        return fallback();
      });
      await navigator.execute();
      expect(invoke).not.toHaveBeenCalled();
      expect(click).not.toHaveBeenCalled();
    },
  );

  it('sends a selected tab action through the same evaluation and executor', async () => {
    const { navigator, select, evaluate, switchTab, state } = fixture();
    state.tabs.push({ id: 9, title: 'Target tab', url: 'https://example.test/target' });
    select.mockResolvedValue(selection('tab_9'));
    await navigator.execute();
    expect(evaluate.mock.calls[0][1]).toMatchObject({ name: 'switch_tab', parameters: { tab_id: 9 } });
    expect(switchTab).toHaveBeenCalledWith(expect.objectContaining({ tab_id: 9 }));
  });

  it('abandons a selection for a superseded task without executing it or starting generative fallback', async () => {
    const { navigator, context, select, invoke, evaluate, click, done } = fixture();
    select.mockImplementation(async () => {
      context.decision!.setTask('A different user task');
      return selection();
    });
    const output = await navigator.execute();
    expect(output.result).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });

  it('abandons a generative fallback output when the task changes while that model is running', async () => {
    const { navigator, context, select, invoke, click, done } = fixture();
    select.mockResolvedValue(fallback());
    invoke.mockImplementation(async () => {
      context.decision!.setTask('A different user task');
      return generated;
    });
    const output = await navigator.execute();
    expect(output.result).toBeUndefined();
    expect(click).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });
});

describe('System-1 candidate validity and bounded requests', () => {
  it('excludes disabled, hidden, offscreen and free-text input candidates', () => {
    const state = browserState();
    state.selectorMap.set(2, element(2, 'button', { disabled: '' }));
    state.selectorMap.set(3, element(3, 'button', { 'aria-disabled': 'true' }));
    state.selectorMap.set(4, element(4, 'input'));
    state.selectorMap.set(5, element(5, 'textarea'));
    const hidden = element(6);
    hidden.isVisible = false;
    state.selectorMap.set(6, hidden);
    const offscreen = element(7);
    offscreen.isInViewport = false;
    state.selectorMap.set(7, offscreen);
    const candidates = buildDecisionCandidates(state);
    expect(
      candidates.filter(candidate => candidate.action.name === 'click_element').map(candidate => candidate.id),
    ).toEqual(['click_1']);
  });

  it('only offers scrolling when the corresponding direction can move', () => {
    const state = browserState();
    expect(buildDecisionCandidates(state).map(candidate => candidate.id)).toContain('scroll_next');
    expect(buildDecisionCandidates(state).map(candidate => candidate.id)).not.toContain('scroll_previous');
    state.scrollY = 200;
    expect(buildDecisionCandidates(state).map(candidate => candidate.id)).not.toContain('scroll_next');
    expect(buildDecisionCandidates(state).map(candidate => candidate.id)).toContain('scroll_previous');
    state.scrollY = 0;
    state.scrollHeight = state.visualViewportHeight;
    expect(buildDecisionCandidates(state).some(candidate => candidate.action.name.endsWith('_page'))).toBe(false);
  });

  it('bounds DOM options and total candidates while skipping disabled dropdown options', () => {
    const state = browserState();
    const select = element(2, 'select');
    const disabled = element(0, 'option', { disabled: '' });
    disabled.children = [new DOMTextNode('Unavailable option', true)];
    select.children = [disabled, ...Array.from({ length: 200 }, (_, index) => element(index + 1, 'option'))];
    state.selectorMap = new Map([[2, select]]);
    state.tabs = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      title: 'Tab ' + index,
      url: 'https://example.test/',
    }));
    const candidates = buildDecisionCandidates(state);
    const options = candidates.filter(candidate => candidate.action.name === 'select_dropdown_option');
    expect(options).toHaveLength(36);
    expect(options.every(candidate => candidate.action.parameters.index === 2)).toBe(true);
    expect(options.some(candidate => candidate.action.parameters.text === 'Unavailable option')).toBe(false);
    expect(candidates).toHaveLength(48);
    expect(new Set(candidates.map(candidate => candidate.id)).size).toBe(48);
    expect(candidates.some(candidate => candidate.id === 'tab_1')).toBe(false);
  });

  it('caps large interactive DOM sets and supplies parameters valid under existing schemas', () => {
    const state = browserState();
    state.selectorMap = new Map(Array.from({ length: 100 }, (_, index) => [index + 1, element(index + 1)]));
    const candidates = buildDecisionCandidates(state);
    expect(candidates.filter(candidate => candidate.action.name === 'click_element')).toHaveLength(36);
    for (const candidate of candidates) {
      const schema =
        candidate.action.name === 'click_element' ? clickElementActionSchema.schema : nextPageActionSchema.schema;
      expect(schema.safeParse(candidate.action.parameters).success).toBe(true);
    }
  });
});
