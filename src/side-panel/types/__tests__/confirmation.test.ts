import { describe, expect, it } from 'vitest';
import { readJevConfirmation } from '../confirmation';

const request = {
  type: 'jev_confirmation',
  taskId: 'current-task',
  decisionId: 'decision-1',
  actionName: 'click_element',
  summary: 'Click element 5',
};

describe('Jev confirmation messages', () => {
  it('accepts an action-bound confirmation for the active task', () => {
    expect(readJevConfirmation(request, 'current-task')).toEqual(request);
  });

  it('ignores requests belonging to an old task or closed session', () => {
    expect(readJevConfirmation(request, 'different-task')).toBeNull();
    expect(readJevConfirmation(request, null)).toBeNull();
  });

  it.each([null, {}, { ...request, decisionId: '' }, { ...request, summary: {} }, { ...request, type: 'resume_task' }])(
    'rejects malformed or unrelated messages',
    message => {
      expect(readJevConfirmation(message, 'current-task')).toBeNull();
    },
  );

  it('bounds displayed summaries and treats markup as ordinary text', () => {
    const result = readJevConfirmation(
      { ...request, summary: '<script>ignored</script>' + 'x'.repeat(2_000) },
      'current-task',
    );
    expect(result?.summary.length).toBe(1_000);
    expect(result?.summary).toMatch(/^<script>/);
  });
});
