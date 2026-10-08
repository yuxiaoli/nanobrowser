import type { ChatModel } from '@src/background/llm/types';
import { type ActionResult, AgentContext, type AgentOptions, type AgentOutput } from './types';
import { t } from '@extension/i18n';
import { NavigatorAgent, NavigatorActionRegistry } from './agents/navigator';
import { PlannerAgent, type PlannerOutput } from './agents/planner';
import { NavigatorPrompt } from './prompts/navigator';
import { PlannerPrompt } from './prompts/planner';
import { createLogger } from '@src/background/log';
import MessageManager from './messages/service';
import type BrowserContext from '../browser/context';
import { ActionBuilder } from './actions/builder';
import { EventManager } from './event/manager';
import { Actors, type EventCallback, EventType, ExecutionState } from './event/types';
import {
  ChatModelAuthError,
  ChatModelBadRequestError,
  ChatModelForbiddenError,
  ExtensionConflictError,
  RequestCancelledError,
  MaxStepsReachedError,
  MaxFailuresReachedError,
} from './agents/errors';
import { URLNotAllowedError } from '../browser/views';
import { chatHistoryStore } from '@extension/storage/lib/chat';
import type { AgentStepHistory } from './history';
import type { GeneralSettingsConfig, JevSettingsConfig } from '@extension/storage';
import { analytics } from '../services/analytics';
import type { DecisionEngine, RoutingDecision } from './decision/types';
import { userMessage } from '../llm/messages';
import { sanitizeDecisionText } from './decision/policy';
import { DecisionRuntime, type DecisionNotification } from './decision-runtime';

const logger = createLogger('Executor');

export interface ExecutorExtraArgs {
  plannerLLM?: ChatModel;
  extractorLLM?: ChatModel;
  agentOptions?: Partial<AgentOptions>;
  generalSettings?: GeneralSettingsConfig;
  decisionEngine?: DecisionEngine;
  jevSettings?: JevSettingsConfig;
  decisionNotify?: (message: DecisionNotification) => void;
  routingModels?: { fast?: ChatModel; capable?: ChatModel };
}

export class Executor {
  private readonly navigator: NavigatorAgent;
  private readonly planner: PlannerAgent;
  private readonly context: AgentContext;
  private readonly plannerPrompt: PlannerPrompt;
  private readonly navigatorPrompt: NavigatorPrompt;
  private readonly generalSettings: GeneralSettingsConfig | undefined;
  private tasks: string[] = [];
  private readonly routingModels?: ExecutorExtraArgs['routingModels'];
  private readonly jevSettings?: JevSettingsConfig;
  private readonly defaultNavigatorLLM: ChatModel;
  private routeDecision?: RoutingDecision;
  private routingInitialized = false;
  private forcePlanner = false;
  constructor(
    task: string,
    taskId: string,
    browserContext: BrowserContext,
    navigatorLLM: ChatModel,
    extraArgs?: Partial<ExecutorExtraArgs>,
  ) {
    const messageManager = new MessageManager();

    const plannerLLM = extraArgs?.plannerLLM ?? navigatorLLM;
    const extractorLLM = extraArgs?.extractorLLM ?? navigatorLLM;
    const eventManager = new EventManager();
    const context = new AgentContext(
      taskId,
      browserContext,
      messageManager,
      eventManager,
      extraArgs?.agentOptions ?? {},
    );

    this.generalSettings = extraArgs?.generalSettings;
    this.jevSettings = extraArgs?.jevSettings;
    this.routingModels = extraArgs?.routingModels;
    this.defaultNavigatorLLM = navigatorLLM;
    this.tasks.push(task);
    this.navigatorPrompt = new NavigatorPrompt(context.options.maxActionsPerStep);
    this.plannerPrompt = new PlannerPrompt();

    const actionBuilder = new ActionBuilder(context, extractorLLM);
    const navigatorActionRegistry = new NavigatorActionRegistry(actionBuilder.buildDefaultActions());

    // Initialize agents with their respective prompts
    this.navigator = new NavigatorAgent(
      navigatorActionRegistry,
      {
        chatLLM: navigatorLLM,
        context: context,
        prompt: this.navigatorPrompt,
      },
      { system1Enabled: extraArgs?.jevSettings?.system1Enabled },
    );

    this.planner = new PlannerAgent({
      chatLLM: plannerLLM,
      context: context,
      prompt: this.plannerPrompt,
    });

    this.context = context;
    if (extraArgs?.decisionEngine)
      context.decision = new DecisionRuntime(
        extraArgs.decisionEngine,
        extraArgs.jevSettings?.enabled ?? false,
        task,
        context,
        extraArgs.decisionNotify,
      );
    // Initialize message history
    this.context.messageManager.initTaskMessages(this.navigatorPrompt.getSystemMessage(), task);
  }

  subscribeExecutionEvents(callback: EventCallback): void {
    this.context.eventManager.subscribe(EventType.EXECUTION, callback);
  }

  clearExecutionEvents(): void {
    // Clear all execution event listeners
    this.context.eventManager.clearSubscribers(EventType.EXECUTION);
  }

  addFollowUpTask(task: string): void {
    this.tasks.push(task);
    this.context.decision?.setTask(this.tasks.join('\n'));
    this.routeDecision = undefined;
    this.routingInitialized = false;
    this.navigator.setChatModel(this.defaultNavigatorLLM);
    this.context.messageManager.addNewTask(task);

    // need to reset previous action results that are not included in memory
    this.context.actionResults = this.context.actionResults.filter(result => result.includeInMemory);
  }

  /**
   * Check if task is complete based on planner output and handle completion
   */
  private checkTaskCompletion(planOutput: AgentOutput<PlannerOutput> | null): boolean {
    if (this.context.stopped || this.context.paused) return false;
    if (planOutput?.result?.done) {
      logger.info('✅ Planner confirms task completion');
      if (planOutput.result.final_answer) {
        this.context.finalAnswer = planOutput.result.final_answer;
      }
      return true;
    }
    return false;
  }

  /**
   * Execute the task
   *
   * @returns {Promise<void>}
   */
  async execute(): Promise<void> {
    logger.info(`🚀 Executing task: ${this.tasks[this.tasks.length - 1]}`);
    // reset the step counter
    const context = this.context;
    context.nSteps = 0;
    const allowedMaxSteps = this.context.options.maxSteps;

    try {
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_START, this.context.taskId);

      // Track task start
      void analytics.trackTaskStart(this.context.taskId);

      let step = 0;
      let latestPlanOutput: AgentOutput<PlannerOutput> | null = null;
      let navigatorDone = false;

      for (step = 0; step < allowedMaxSteps; step++) {
        context.stepInfo = {
          stepNumber: context.nSteps,
          maxSteps: context.options.maxSteps,
        };

        logger.info(`🔄 Step ${step + 1} / ${allowedMaxSteps}`);
        if (await this.shouldStop()) {
          break;
        }

        if (!this.routingInitialized && !(await this.initializeRouting())) continue;

        // Run planner periodically for guidance
        if (
          this.planner &&
          (this.forcePlanner || context.nSteps % context.options.planningInterval === 0 || navigatorDone)
        ) {
          this.forcePlanner = false;
          navigatorDone = false;
          latestPlanOutput = await this.runPlanner();
          if (context.stopped) break;

          // Check if task is complete after planner run
          if (this.checkTaskCompletion(latestPlanOutput)) {
            break;
          }
        }

        // Execute navigator
        navigatorDone = await this.navigate();

        // If navigator indicates completion, the next periodic planner run will validate it
        if (navigatorDone) {
          logger.info('🔄 Navigator indicates completion - will be validated by next planner run');
        }
      }

      // Determine task completion status
      const isCompleted = latestPlanOutput?.result?.done === true && !context.stopped && !context.paused;

      if (isCompleted) {
        // Emit final answer if available, otherwise use task ID
        const finalMessage = this.context.finalAnswer || this.context.taskId;
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, finalMessage);

        // Track task completion
        void analytics.trackTaskComplete(this.context.taskId);
      } else if (step >= allowedMaxSteps) {
        logger.error('❌ Task failed: Max steps reached');
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_errors_maxStepsReached'));

        // Track task failure with specific error category
        const maxStepsError = new MaxStepsReachedError(t('exec_errors_maxStepsReached'));
        const errorCategory = analytics.categorizeError(maxStepsError);
        void analytics.trackTaskFailed(this.context.taskId, errorCategory);
      } else if (this.context.stopped) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_task_cancel'));

        // Track task cancellation
        void analytics.trackTaskCancelled(this.context.taskId);
      } else {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_PAUSE, t('exec_task_pause'));
        // Note: We don't track pause as it's not a final state
      }
    } catch (error) {
      if (error instanceof RequestCancelledError) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_task_cancel'));

        // Track task cancellation
        void analytics.trackTaskCancelled(this.context.taskId);
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_task_fail', [errorMessage]));

        // Track task failure with detailed error categorization
        const errorCategory = analytics.categorizeError(error instanceof Error ? error : errorMessage);
        void analytics.trackTaskFailed(this.context.taskId, errorCategory);
      }
    } finally {
      if (import.meta.env.DEV) {
        logger.debug('Executor history', JSON.stringify(this.context.history, null, 2));
      }
      // store the history only if replay is enabled
      if (this.generalSettings?.replayHistoricalTasks) {
        const historyString = JSON.stringify(this.context.history);
        logger.info(`Executor history size: ${historyString.length}`);
        await chatHistoryStore.storeAgentStepHistory(this.context.taskId, this.tasks[0], historyString);
      } else {
        logger.info('Replay historical tasks is disabled, skipping history storage');
      }
    }
  }

  private async initializeRouting(): Promise<boolean> {
    const taskVersion = this.tasks.length;
    const decision = this.context.decision;
    if (!decision?.enabled || !this.jevSettings?.routingEnabled) {
      this.routingInitialized = true;
      return true;
    }
    if (!this.routeDecision) {
      const route = await decision.invoke(() => decision.engine.routeTask(decision.taskInput()));
      if (this.context.stopped || this.context.controller.signal.aborted)
        throw new RequestCancelledError('Task routing cancelled');
      if (this.tasks.length !== taskVersion) return false;
      this.routeDecision = route;
      decision.record('routing', this.routeDecision);
    }
    const route = this.routeDecision.outcome;
    if (route === 'confirm') {
      const state = await this.context.browserContext.getState(false);
      if (this.tasks.length !== taskVersion) return false;
      if (!(await decision.confirm('task_execution', state, sanitizeDecisionText(this.tasks.at(-1) ?? ''))))
        return false;
      if (this.tasks.length !== taskVersion) return false;
      this.forcePlanner = true;
    }
    if (this.context.stopped || this.context.controller.signal.aborted)
      throw new RequestCancelledError('Task routing cancelled');
    const model =
      route === 'fast' ? this.routingModels?.fast : route === 'capable' ? this.routingModels?.capable : undefined;
    if (model) this.navigator.setChatModel(model);
    if (route === 'planner') this.forcePlanner = true;
    this.context.messageManager.addMessageWithTokens(
      userMessage(
        `Execution strategy: ${route}. Preserve all existing security rules and user authorization boundaries.`,
      ),
    );
    this.routingInitialized = true;
    return true;
  }

  /**
   * Helper method to run planner and store its output
   */
  private async runPlanner(): Promise<AgentOutput<PlannerOutput> | null> {
    const context = this.context;
    try {
      // Add current browser state to memory
      let positionForPlan = 0;
      if (this.tasks.length > 1 || this.context.nSteps > 0) {
        await this.navigator.addStateMessageToMemory();
        positionForPlan = this.context.messageManager.length() - 1;
      } else {
        positionForPlan = this.context.messageManager.length();
      }

      // Execute planner
      const planOutput = await this.planner.execute();
      if (planOutput.result?.done && context.decision?.enabled) {
        const completion = await context.decision.verify({
          text: planOutput.result.final_answer,
          observation: planOutput.result.observation,
        });
        if (completion.outcome !== 'complete' || completion.isHandoff) {
          planOutput.result.done = false;
          planOutput.result.next_steps = `Jev completion: ${completion.reasonCode}. ${planOutput.result.next_steps}`;
        }
      }
      if (planOutput.result) {
        this.context.messageManager.addPlan(JSON.stringify(planOutput.result), positionForPlan);
      }
      return planOutput;
    } catch (error) {
      logger.error(`Failed to execute planner: ${error}`);
      if (
        error instanceof ChatModelAuthError ||
        error instanceof ChatModelBadRequestError ||
        error instanceof ChatModelForbiddenError ||
        error instanceof URLNotAllowedError ||
        error instanceof RequestCancelledError ||
        error instanceof ExtensionConflictError
      ) {
        throw error;
      }
      context.consecutiveFailures++;
      logger.error(`Failed to execute planner: ${error}`);
      if (context.consecutiveFailures >= context.options.maxFailures) {
        throw new MaxFailuresReachedError(t('exec_errors_maxFailuresReached'));
      }
      return null;
    }
  }

  private async navigate(): Promise<boolean> {
    const context = this.context;
    try {
      // Get and execute navigation action
      // check if the task is paused or stopped
      if (context.paused || context.stopped) {
        return false;
      }
      const navOutput = await this.navigator.execute();
      // check if the task is paused or stopped
      if (context.paused || context.stopped) {
        return false;
      }
      context.nSteps++;
      if (navOutput.error) {
        this.escalateNavigation();
        throw new Error(navOutput.error);
      }
      context.consecutiveFailures = 0;
      if (context.actionResults.some(result => result.decisionBlocked || result.error)) this.escalateNavigation();
      if (navOutput.result?.done) {
        return true;
      }
    } catch (error) {
      this.escalateNavigation();
      logger.error(`Failed to execute step: ${error}`);
      if (
        error instanceof ChatModelAuthError ||
        error instanceof ChatModelBadRequestError ||
        error instanceof ChatModelForbiddenError ||
        error instanceof URLNotAllowedError ||
        error instanceof RequestCancelledError ||
        error instanceof ExtensionConflictError
      ) {
        throw error;
      }
      context.consecutiveFailures++;
      logger.error(`Failed to execute step: ${error}`);
      if (context.consecutiveFailures >= context.options.maxFailures) {
        throw new MaxFailuresReachedError(t('exec_errors_maxFailuresReached'));
      }
    }
    return false;
  }

  private escalateNavigation(): void {
    if (!this.context.decision?.enabled || !this.jevSettings?.routingEnabled) return;
    if (this.routingModels?.capable) this.navigator.setChatModel(this.routingModels.capable);
    this.forcePlanner = true;
  }

  private async shouldStop(): Promise<boolean> {
    if (this.context.stopped) {
      logger.info('Agent stopped');
      return true;
    }

    while (this.context.paused) {
      await new Promise(resolve => setTimeout(resolve, 200));
      if (this.context.stopped) {
        return true;
      }
    }

    if (this.context.consecutiveFailures >= this.context.options.maxFailures) {
      logger.error(`Stopping due to ${this.context.options.maxFailures} consecutive failures`);
      return true;
    }

    return false;
  }

  async cancel(): Promise<void> {
    await this.context.stop();
    if (this.context.decision?.enabled) this.context.controller.abort();
  }

  async resume(): Promise<void> {
    if (this.context.decision?.awaitingConfirmation) return;
    await this.context.resume();
    await this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_RESUME, t('chat_jev_resumeTask'));
  }

  confirmDecision(taskId: string, decisionId: string, approved: boolean): boolean {
    return this.context.decision?.resolveConfirmation(taskId, decisionId, approved) ?? false;
  }

  async pause(): Promise<void> {
    this.context.pause();
  }

  async cleanup(): Promise<void> {
    try {
      await this.context.browserContext.cleanup();
    } catch (error) {
      logger.error(`Failed to cleanup browser context: ${error}`);
    }
  }

  async getCurrentTaskId(): Promise<string> {
    return this.context.taskId;
  }

  /**
   * Replays a saved history of actions with error handling and retry logic.
   *
   * @param history - The history to replay
   * @param maxRetries - Maximum number of retries per action
   * @param skipFailures - Whether to skip failed actions or stop execution
   * @param delayBetweenActions - Delay between actions in seconds
   * @returns List of action results
   */
  async replayHistory(
    sessionId: string,
    maxRetries = 3,
    skipFailures = true,
    delayBetweenActions = 2.0,
  ): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    const replayLogger = createLogger('Executor:replayHistory');

    logger.info('replay task', this.tasks[0]);

    try {
      const historyFromStorage = await chatHistoryStore.loadAgentStepHistory(sessionId);
      if (!historyFromStorage) {
        throw new Error(t('exec_replay_historyNotFound'));
      }

      const history = JSON.parse(historyFromStorage.history) as AgentStepHistory;
      if (history.history.length === 0) {
        throw new Error(t('exec_replay_historyEmpty'));
      }
      logger.debug(`🔄 Replaying history: ${JSON.stringify(history, null, 2)}`);
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_START, this.context.taskId);

      for (let i = 0; i < history.history.length; i++) {
        const historyItem = history.history[i];

        // Check if execution should stop
        if (await this.shouldStop()) {
          replayLogger.info('Replay stopped by user');
          break;
        }

        // Execute the history step with enhanced method that handles all the logic
        const stepResults = await this.navigator.executeHistoryStep(
          historyItem,
          i,
          history.history.length,
          maxRetries,
          delayBetweenActions * 1000,
          skipFailures,
        );

        results.push(...stepResults);
        if (stepResults.some(result => result.decisionBlocked)) {
          await this.context.decision?.pauseForUser(
            'Replay was interrupted by a decision. Review the current state before starting a new task.',
          );
          return results;
        }

        // If stopped during execution, break the loop
        if (this.context.stopped) {
          break;
        }
      }

      if (!this.context.stopped && this.context.decision?.enabled) {
        const completion = await this.context.decision.verify({
          text: 'Historical actions have been replayed. Verify the original user task from the resulting state.',
        });
        if (completion.outcome !== 'complete' || completion.isHandoff) {
          this.context.emitEvent(
            Actors.SYSTEM,
            ExecutionState.TASK_PAUSE,
            'Replay finished, but task completion is unverified.',
          );
          return results;
        }
      }
      if (this.context.stopped) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_replay_cancel'));
      } else {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, t('exec_replay_ok'));
      }
    } catch (error) {
      if (error instanceof RequestCancelledError) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_replay_cancel'));
        return results;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      replayLogger.error(`Replay failed: ${errorMessage}`);
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_replay_fail', [errorMessage]));
    }

    return results;
  }
}
