import type {
  DecisionAction,
  DecisionCandidate,
  DecisionContext,
  DecisionEngine,
  CompletionDecision,
} from './decision/types';
import type { AgentContext, ActionResult } from './types';
import type { BrowserState } from '../browser/views';
import { Actors, ExecutionState } from './event/types';
import { filterExternalContent } from './messages/utils';
import { userMessage } from '../llm/messages';
import { createLogger } from '../log';
import {
  ChatModelAuthError,
  ChatModelBadRequestError,
  ChatModelForbiddenError,
  RequestCancelledError,
} from './agents/errors';
import { sanitizeDecisionInput } from './decision/policy';

const logger = createLogger('DecisionRuntime');
const SAFE_ATTRIBUTES = ['title', 'type', 'role', 'aria-label', 'aria-expanded', 'checked', 'href'];

export interface DecisionConfirmation {
  type: 'jev_confirmation';
  taskId: string;
  decisionId: string;
  actionName: string;
  summary: string;
}

export type DecisionNotification =
  | DecisionConfirmation
  | {
      type: 'jev_confirmation_cleared';
      taskId: string;
      decisionId: string;
    };

export class DecisionRuntimeError extends Error {}

/** Hash raw state only in memory. Never put this raw snapshot in requests or logs. */
export async function browserFingerprint(state: BrowserState): Promise<string> {
  const snapshot = JSON.stringify({
    tabId: state.tabId,
    url: state.url,
    title: state.title,
    text: state.elementTree.clickableElementsToString(),
    elements: [...state.selectorMap].map(([index, element]) => [index, element.xpath, element.attributes]),
    tabs: state.tabs,
    scrollY: state.scrollY,
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(snapshot));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export class DecisionRuntime {
  private pending?: { id: string; resolve: (approved: boolean) => void };
  private completeCache?: { key: string; result: CompletionDecision };
  private reconsiderations = 0;
  private completionAttempts = 0;
  private generation = 0;
  private recentOutcomes: { success: boolean; content: string | null; error: string | null }[] = [];
  readonly records: {
    operation: string;
    outcome: string;
    reasonCode?: string;
    confidence?: number;
    probability?: number;
    elapsedMs?: number;
    apiCalls?: number;
    usage?: { inputTokens: number; outputTokens: number };
    estimatedCost?: number;
  }[] = [];

  constructor(
    readonly engine: DecisionEngine,
    readonly enabled: boolean,
    private task: string,
    private readonly context: AgentContext,
    private readonly notify: (message: DecisionNotification) => void = () => {},
  ) {}

  get awaitingConfirmation(): boolean {
    return !!this.pending;
  }

  setTask(task: string): void {
    this.generation++;
    this.pending?.resolve(false);
    this.task = task;
    this.completeCache = undefined;
    this.reconsiderations = 0;
    this.completionAttempts = 0;
    this.recentOutcomes = [];
  }

  recordExecution(result: ActionResult): void {
    this.recentOutcomes.push({ success: result.success, content: result.extractedContent, error: result.error });
    if (this.recentOutcomes.length > 10) this.recentOutcomes.shift();
    this.completeCache = undefined;
    this.record('execution', { outcome: result.error ? 'failed' : 'executed' });
  }

  async input(state?: BrowserState): Promise<DecisionContext> {
    const current = state ?? (await this.context.browserContext.getState(false));
    return {
      taskId: this.context.taskId,
      task: this.task,
      browser: {
        url: current.url,
        title: current.title,
        pageText: filterExternalContent(current.elementTree.clickableElementsToString(SAFE_ATTRIBUTES)),
      },
      outcomes: this.recentOutcomes.length
        ? [...this.recentOutcomes]
        : this.context.actionResults.slice(-10).map(result => ({
            success: result.success,
            content: result.extractedContent,
            error: result.error,
          })),
      signal: this.context.controller.signal,
    };
  }

  /** Adapt API errors to the existing Executor's fatal/configuration and retry behavior. */
  async invoke<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (this.context.controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new RequestCancelledError('Jev decision cancelled');
      }
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
      if (code === 'cancelled') throw new RequestCancelledError('Jev decision cancelled');
      if (status === 403 || code === 'forbidden') throw new ChatModelForbiddenError('Jev access denied.');
      if (status === 401 || code === 'authentication' || code === 'missing_api_key') {
        throw new ChatModelAuthError('Jev authentication failed. Check the key in settings.');
      }
      if (status === 400 || status === 422 || code === 'configuration' || code === 'invalid_config') {
        throw new ChatModelBadRequestError('Jev configuration or request is invalid.');
      }
      // Engine errors are already sanitized. Do not include arbitrary network errors or response bodies.
      throw new DecisionRuntimeError('Jev decision failed. Check connectivity and decision settings.');
    }
  }

  record(
    operation: string,
    result: {
      outcome: string;
      reasonCode?: string;
      confidence?: number;
      probability?: number;
      metadata?: {
        elapsedMs: number;
        apiCalls: number;
        usage?: { inputTokens: number; outputTokens: number };
        estimatedCost?: number;
      };
    },
  ): void {
    const record = {
      operation,
      outcome: result.outcome,
      elapsedMs: result.metadata?.elapsedMs,
      apiCalls: result.metadata?.apiCalls,
      reasonCode: result.reasonCode,
      confidence: result.confidence,
      probability: result.probability,
      usage: result.metadata?.usage,
      estimatedCost: result.metadata?.estimatedCost,
    };
    this.records.push(record);
    if (this.records.length > 200) this.records.shift();
    logger.info('Decision', record);
  }

  async pauseForUser(details: string): Promise<void> {
    await this.context.pause();
    await this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_PAUSE, details);
  }

  async approve(action: DecisionAction, state: BrowserState): Promise<boolean> {
    if (!this.enabled) return true;
    const generation = this.generation;
    const fingerprint = await browserFingerprint(state);
    const input = await this.input(state);
    const target =
      typeof action.parameters.index === 'number' ? state.selectorMap.get(action.parameters.index) : undefined;
    // Annotate evaluation-only parameters so the privacy filter can recognize sensitive input fields.
    const evaluationAction = target
      ? {
          ...action,
          parameters: {
            ...action.parameters,
            type: target.attributes.type,
            name: target.attributes.name,
            autocomplete: target.attributes.autocomplete,
          },
        }
      : action;
    const decision = await this.invoke(() => this.engine.evaluateAction(input, evaluationAction));
    this.record('action', decision);
    if (decision.outcome === 'reconsider') {
      this.reconsiderations++;
      if (this.reconsiderations >= 2)
        await this.pauseForUser('Jev could not establish a suitable action. Review the task before resuming.');
      return false;
    }
    if (decision.outcome === 'confirm') {
      if (!(await this.confirm(action.name, state, JSON.stringify(sanitizeDecisionInput(evaluationAction.parameters)))))
        return false;
    }
    // A decision or user approval may arrive after DOM navigation/change.
    const fresh = await this.context.browserContext.getState(false);
    if (generation !== this.generation || (await browserFingerprint(fresh)) !== fingerprint) return false;
    this.reconsiderations = 0;
    this.completeCache = undefined;
    return !this.context.stopped;
  }

  async confirm(actionName: string, state: BrowserState, summary = actionName): Promise<boolean> {
    const generation = this.generation;
    const fingerprint = await browserFingerprint(state);
    const id = crypto.randomUUID();
    const signal = this.context.controller.signal;
    if (signal.aborted) throw new RequestCancelledError('Decision cancelled');
    let onAbort: () => void = () => {};
    try {
      const approved = await new Promise<boolean>((resolve, reject) => {
        this.pending = { id, resolve };
        onAbort = () => reject(new RequestCancelledError('Decision cancelled'));
        signal.addEventListener('abort', onAbort, { once: true });
        this.notify({ type: 'jev_confirmation', taskId: this.context.taskId, decisionId: id, actionName, summary });
      });
      if (generation !== this.generation) return false;
      if (!approved) {
        await this.pauseForUser('The proposed action was rejected. Review or update the task before resuming.');
        return false;
      }
      const fresh = await this.context.browserContext.getState(false);
      if (fingerprint !== (await browserFingerprint(fresh))) {
        this.context.messageManager.addMessageWithTokens(
          userMessage('The approved action expired because browser state changed. Propose a fresh action.'),
        );
        return false;
      }
      return !this.context.stopped;
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.pending = undefined;
      this.notify({ type: 'jev_confirmation_cleared', taskId: this.context.taskId, decisionId: id });
    }
  }

  resolveConfirmation(taskId: string, decisionId: string, approved: boolean): boolean {
    if (taskId !== this.context.taskId || decisionId !== this.pending?.id) return false;
    this.pending.resolve(approved);
    return true;
  }

  async verify(claimedCompletion: unknown, state?: BrowserState): Promise<CompletionDecision> {
    if (this.context.stopped || this.context.controller.signal.aborted)
      throw new RequestCancelledError('Completion verification cancelled');
    const generation = this.generation;
    let current = state ?? (await this.context.browserContext.getState(false));
    let input = await this.input(current);
    const cacheKey = async () =>
      `${this.task}:${await browserFingerprint(current)}:${JSON.stringify(input.outcomes)}:${JSON.stringify(sanitizeDecisionInput(claimedCompletion))}`;
    let key = await cacheKey();
    let evaluatedFingerprint = await browserFingerprint(current);
    if (this.completeCache?.key === key) return this.completeCache.result;
    let result = await this.invoke(() => this.engine.verifyCompletion({ ...input, claimedCompletion }));
    this.record('completion', result);
    if (result.outcome === 'needs_verification' && !result.isHandoff) {
      // Refresh evidence once, without clicking or navigating solely to establish completion.
      current = await this.context.browserContext.getState(false);
      input = await this.input(current);
      key = await cacheKey();
      evaluatedFingerprint = await browserFingerprint(current);
      result = await this.invoke(() => this.engine.verifyCompletion({ ...input, claimedCompletion }));
      this.record('completion', result);
    }
    if (this.context.controller.signal.aborted) throw new RequestCancelledError('Completion verification cancelled');
    const latest = await this.context.browserContext.getState(false);
    if (generation !== this.generation || evaluatedFingerprint !== (await browserFingerprint(latest))) {
      result = { ...result, outcome: 'needs_verification', reasonCode: 'evidence_insufficient', isHandoff: false };
    }
    if (result.outcome === 'complete' && !result.isHandoff) {
      this.completeCache = { key, result };
      this.completionAttempts = 0;
    } else {
      this.completionAttempts++;
      if (result.isHandoff || result.outcome === 'needs_verification' || this.completionAttempts >= 2) {
        await this.pauseForUser(
          result.isHandoff
            ? 'The task needs your input or sign-in; it is not marked complete.'
            : 'Task completion remains unverified. Review the result before resuming.',
        );
      }
    }
    return result;
  }
}

/** Bounded candidates use existing action schemas; free-text generation always stays with Navigator. */
export function buildDecisionCandidates(state: BrowserState): DecisionCandidate[] {
  const candidates: DecisionCandidate[] = [];
  for (const [index, element] of state.selectorMap) {
    if (!element.isInteractive || !element.isVisible || !element.isInViewport) continue;
    const label =
      element.getAllTextTillNextClickableElement().slice(0, 160) ||
      element.attributes['aria-label'] ||
      element.tagName ||
      'element';
    if (element.tagName?.toLowerCase() === 'select') {
      for (const child of element.children) {
        if ('tagName' in child && child.tagName === 'option' && 'getAllTextTillNextClickableElement' in child) {
          const text = (child as typeof element).getAllTextTillNextClickableElement();
          if (text)
            candidates.push({
              id: `option_${index}_${candidates.length}`,
              label: `${label}: ${text}`,
              action: { name: 'select_dropdown_option', parameters: { index, text } },
            });
        }
      }
    } else if (!['input', 'textarea'].includes(element.tagName?.toLowerCase() ?? '')) {
      candidates.push({ id: `click_${index}`, label, action: { name: 'click_element', parameters: { index } } });
    }
    if (candidates.length >= 36) break;
  }
  candidates.push({
    id: 'scroll_next',
    label: 'Scroll to the next page',
    action: { name: 'next_page', parameters: {} },
  });
  candidates.push({
    id: 'scroll_previous',
    label: 'Scroll to the previous page',
    action: { name: 'previous_page', parameters: {} },
  });
  for (const tab of state.tabs) {
    if (tab.id !== state.tabId && candidates.length < 48)
      candidates.push({
        id: `tab_${tab.id}`,
        label: tab.title,
        action: { name: 'switch_tab', parameters: { tab_id: tab.id } },
      });
  }
  return candidates.slice(0, 48);
}
