import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';
import { normalizeReasoningEffort, type ModelConfig } from './agentModels';

/** Jev is a decision service; its credentials are separate from generative LLM providers. */
export interface JevSettingsConfig {
  enabled: boolean;
  apiKey: string;
  model: string;
  timeoutMs: number;
  proceedThreshold: number;
  completionThreshold: number;
  selectionThreshold: number;
  routingEnabled: boolean;
  system1Enabled: boolean;
  fastModel?: ModelConfig;
  capableModel?: ModelConfig;
}

export const DEFAULT_JEV_SETTINGS: JevSettingsConfig = {
  enabled: false,
  apiKey: '',
  model: 'jev-latest',
  timeoutMs: 10_000,
  proceedThreshold: 0.8,
  completionThreshold: 0.9,
  selectionThreshold: 0.8,
  routingEnabled: false,
  system1Enabled: false,
};

export type JevSettingsStorage = BaseStorage<JevSettingsConfig> & {
  getSettings: () => Promise<JevSettingsConfig>;
  updateSettings: (settings: Partial<JevSettingsConfig>) => Promise<void>;
  resetToDefaults: () => Promise<void>;
};

/** Reject invalid values without including user input (especially credentials) in errors. */
export function validateJevSettings(settings: JevSettingsConfig): JevSettingsConfig {
  if (
    typeof settings.enabled !== 'boolean' ||
    typeof settings.routingEnabled !== 'boolean' ||
    typeof settings.system1Enabled !== 'boolean' ||
    typeof settings.apiKey !== 'string' ||
    typeof settings.model !== 'string' ||
    !settings.model.trim() ||
    !Number.isInteger(settings.timeoutMs) ||
    settings.timeoutMs < 1_000 ||
    settings.timeoutMs > 60_000
  ) {
    throw new Error('Invalid Jev settings');
  }

  for (const threshold of [settings.proceedThreshold, settings.completionThreshold, settings.selectionThreshold]) {
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new Error('Invalid Jev confidence threshold');
    }
  }

  const normalizeModel = (config: ModelConfig | undefined): ModelConfig | undefined => {
    if (config === undefined) return undefined;
    if (
      !config ||
      typeof config !== 'object' ||
      typeof config.provider !== 'string' ||
      !config.provider.trim() ||
      typeof config.modelName !== 'string' ||
      !config.modelName.trim()
    ) {
      throw new Error('Invalid Jev routing model');
    }
    const reasoningEffort = normalizeReasoningEffort(config.reasoningEffort);
    if (reasoningEffort !== undefined && !['none', 'low', 'medium', 'high', 'xhigh'].includes(reasoningEffort)) {
      throw new Error('Invalid Jev routing model');
    }
    return { provider: config.provider.trim(), modelName: config.modelName.trim(), reasoningEffort };
  };

  return {
    ...settings,
    apiKey: settings.apiKey.trim(),
    model: settings.model.trim(),
    fastModel: normalizeModel(settings.fastModel),
    capableModel: normalizeModel(settings.capableModel),
  };
}

// Chrome local storage follows the existing provider configuration pattern; it is not encrypted storage.
const storage = createStorage<JevSettingsConfig>('jev-settings', DEFAULT_JEV_SETTINGS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const jevSettingsStore: JevSettingsStorage = {
  ...storage,
  async getSettings() {
    return validateJevSettings({ ...DEFAULT_JEV_SETTINGS, ...(await storage.get()) });
  },
  async updateSettings(settings) {
    await storage.set(current => validateJevSettings({ ...DEFAULT_JEV_SETTINGS, ...current, ...settings }));
  },
  async resetToDefaults() {
    await storage.set({ ...DEFAULT_JEV_SETTINGS });
  },
};
