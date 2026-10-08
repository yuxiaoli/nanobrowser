export interface JevConfirmationRequest {
  type: 'jev_confirmation';
  taskId: string;
  decisionId: string;
  actionName: string;
  summary: string;
}

/** Ignore stale requests from a previous task and malformed background messages. */
export function readJevConfirmation(message: unknown, currentTaskId: string | null): JevConfirmationRequest | null {
  if (!message || typeof message !== 'object' || currentTaskId === null) return null;
  const value = message as Partial<JevConfirmationRequest>;
  if (
    value.type !== 'jev_confirmation' ||
    value.taskId !== currentTaskId ||
    typeof value.decisionId !== 'string' ||
    !value.decisionId ||
    typeof value.actionName !== 'string' ||
    !value.actionName ||
    typeof value.summary !== 'string'
  ) {
    return null;
  }
  return {
    type: 'jev_confirmation',
    taskId: value.taskId,
    decisionId: value.decisionId,
    actionName: value.actionName.slice(0, 100),
    summary: value.summary.slice(0, 1_000),
  };
}
