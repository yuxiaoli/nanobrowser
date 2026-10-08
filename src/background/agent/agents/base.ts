import type { z } from 'zod';
import type { AgentContext, AgentOutput } from '../types';
import type { BasePrompt } from '../prompts/base';
import type { Action } from '../actions/builder';
import type { ChatModel, FlexibleSchema, ModelMessage } from '@src/background/llm/types';
import { generateStructured } from '@src/background/llm/generate';

export interface BaseAgentOptions {
  chatLLM: ChatModel;
  context: AgentContext;
  prompt: BasePrompt;
}
export interface ExtraAgentOptions {
  id?: string;
}

/**
 * Base class for all agents
 * @param T - The Zod schema for the model output
 * @param M - The type of the result field of the agent output
 */
export abstract class BaseAgent<T extends z.ZodType, M = unknown> {
  protected id: string;
  protected chatLLM: ChatModel;
  protected prompt: BasePrompt;
  protected context: AgentContext;
  protected actions: Record<string, Action> = {};
  protected modelOutputSchema: T;
  protected modelName: string;
  protected provider: string;
  protected modelOutputToolName: string;
  // Tool name in tool mode; defaults to modelOutputToolName
  protected structuredToolName?: string;
  declare ModelOutput: z.infer<T>;

  constructor(modelOutputSchema: T, options: BaseAgentOptions, extraOptions?: Partial<ExtraAgentOptions>) {
    // base options
    this.modelOutputSchema = modelOutputSchema;
    this.chatLLM = options.chatLLM;
    this.prompt = options.prompt;
    this.context = options.context;
    this.provider = this.chatLLM.provider;
    this.modelName = this.chatLLM.modelName;
    // extra options
    this.id = extraOptions?.id || 'agent';
    this.modelOutputToolName = `${this.id}_output`;
  }

  /**
   * The schema sent to the model and used to validate its reply
   */
  protected getOutputSchema(): FlexibleSchema<this['ModelOutput']> {
    return this.modelOutputSchema;
  }

  async invoke(inputMessages: ModelMessage[]): Promise<this['ModelOutput']> {
    const { output } = await generateStructured({
      chatModel: this.chatLLM,
      messages: inputMessages,
      schema: this.getOutputSchema(),
      name: this.modelOutputToolName,
      toolName: this.structuredToolName,
      abortSignal: this.context.controller.signal,
    });
    return output;
  }

  setChatModel(model: ChatModel): void {
    this.chatLLM = model;
    this.provider = model.provider;
    this.modelName = model.modelName;
  }

  // Execute the agent and return the result
  abstract execute(): Promise<AgentOutput<M>>;
}
