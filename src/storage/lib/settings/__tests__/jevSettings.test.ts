import { beforeEach, describe, expect, it, vi } from 'vitest';

const stored = vi.hoisted(() => {
  const values: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys: string[]) =>
          Object.fromEntries(keys.filter(key => key in values).map(key => [key, values[key]])),
        set: async (items: Record<string, unknown>) => Object.assign(values, items),
        onChanged: { addListener: () => undefined },
      },
    },
  });
  return values;
});

const { jevSettingsStore, DEFAULT_JEV_SETTINGS, validateJevSettings } = await import('../jevSettings');

describe('Jev settings', () => {
  beforeEach(async () => {
    await jevSettingsStore.resetToDefaults();
    delete stored['jev-settings'];
  });

  it('keeps Jev, routing and experimental selection disabled by default', async () => {
    const settings = await jevSettingsStore.getSettings();
    expect(settings).toMatchObject({ enabled: false, routingEnabled: false, system1Enabled: false, timeoutMs: 10_000 });
    expect(settings.apiKey).toBe('');
  });

  it('fills newly introduced defaults without changing stored credentials or existing provider stores', async () => {
    stored['jev-settings'] = { enabled: true, apiKey: 'fixture-key', model: 'jev-latest' };
    stored['llm-api-keys'] = { providers: { local: { apiKey: '', modelNames: ['local-model'] } } };
    const providers = stored['llm-api-keys'];
    expect(await jevSettingsStore.getSettings()).toMatchObject({
      enabled: true,
      apiKey: 'fixture-key',
      proceedThreshold: 0.8,
      completionThreshold: 0.9,
    });
    expect(stored['llm-api-keys']).toBe(providers);
  });

  it('updates a partial configuration and retains generative model settings in their existing shape', async () => {
    await jevSettingsStore.updateSettings({ apiKey: ' fixture-key ', enabled: true });
    await jevSettingsStore.updateSettings({
      routingEnabled: true,
      fastModel: { provider: 'ollama', modelName: 'local-model', reasoningEffort: 'low' },
    });
    expect(await jevSettingsStore.getSettings()).toMatchObject({
      apiKey: 'fixture-key',
      enabled: true,
      routingEnabled: true,
      fastModel: { provider: 'ollama', modelName: 'local-model', reasoningEffort: 'low' },
    });
  });

  it.each([
    { timeoutMs: 0 },
    { timeoutMs: 60_001 },
    { timeoutMs: 10_000.5 },
    { proceedThreshold: Number.NaN },
    { completionThreshold: -0.1 },
    { selectionThreshold: 1.1 },
    { model: ' ' },
    { fastModel: { provider: '', modelName: 'local' } },
  ])('rejects invalid settings atomically: %j', async invalid => {
    await jevSettingsStore.updateSettings({ apiKey: 'fixture-key' });
    const previous = stored['jev-settings'];
    await expect(jevSettingsStore.updateSettings(invalid)).rejects.toThrow('Invalid Jev');
    expect(stored['jev-settings']).toBe(previous);
  });

  it('never includes supplied credentials in validation errors', () => {
    expect(() => validateJevSettings({ ...DEFAULT_JEV_SETTINGS, apiKey: 'fixture-secret', model: '' })).toThrow(
      'Invalid Jev settings',
    );
  });

  it('removes the saved key and routing models when reset', async () => {
    await jevSettingsStore.updateSettings({
      apiKey: 'fixture-key',
      fastModel: { provider: 'ollama', modelName: 'local' },
    });
    await jevSettingsStore.resetToDefaults();
    expect(stored['jev-settings']).toEqual(DEFAULT_JEV_SETTINGS);
  });
});
