import { useEffect, useState } from 'react';
import { Button } from '@extension/ui';
import {
  DEFAULT_JEV_SETTINGS,
  jevSettingsStore,
  llmProviderStore,
  llmProviderModelNames,
  ProviderTypeEnum,
  type JevSettingsConfig,
  type ModelConfig,
  type ReasoningEffort,
} from '@extension/storage';
import { t } from '@extension/i18n';

interface ModelOption {
  provider: string;
  modelName: string;
  label: string;
}

const modelValue = (model: ModelConfig | undefined) => (model ? JSON.stringify([model.provider, model.modelName]) : '');

export const JevSettings = ({ isDarkMode = false }: { isDarkMode?: boolean }) => {
  const [settings, setSettings] = useState<JevSettingsConfig>(DEFAULT_JEV_SETTINGS);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'saved' | 'error' | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([jevSettingsStore.getSettings(), llmProviderStore.getAllProviders()])
      .then(([saved, providers]) => {
        if (!active) return;
        setSettings(saved);
        setModels(
          Object.entries(providers).flatMap(([provider, config]) => {
            const names =
              config.type === ProviderTypeEnum.AzureOpenAI
                ? config.azureDeploymentNames || []
                : config.modelNames || llmProviderModelNames[config.type as keyof typeof llmProviderModelNames] || [];
            return names.map(modelName => ({
              provider,
              modelName,
              label: `${config.name || provider} — ${modelName}`,
            }));
          }),
        );
      })
      .catch(() => {
        if (active) setStatus('error');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const update = <K extends keyof JevSettingsConfig>(key: K, value: JevSettingsConfig[K]) => {
    setSettings(current => ({ ...current, [key]: value }));
    setStatus(null);
  };

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      await jevSettingsStore.updateSettings(settings);
      setSettings(await jevSettingsStore.getSettings());
      setStatus('saved');
    } catch {
      setStatus('error');
    } finally {
      setSaving(false);
    }
  };

  const fieldClass = `w-full rounded-md border px-3 py-2 ${
    isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-200' : 'border-gray-300 bg-white text-gray-700'
  }`;

  const routingModel = (key: 'fastModel' | 'capableModel', label: string) => {
    const config = settings[key];
    const savedIsAvailable = models.some(model => modelValue(model) === modelValue(config));
    return (
      <div className="space-y-2">
        <label htmlFor={`jev-${key}`} className="block font-medium">
          {label}
        </label>
        <select
          id={`jev-${key}`}
          className={fieldClass}
          value={modelValue(config)}
          onChange={event => {
            const selected = models.find(model => modelValue(model) === event.target.value);
            update(key, selected ? { provider: selected.provider, modelName: selected.modelName } : undefined);
          }}>
          <option value="">{t('options_jev_currentModel')}</option>
          {config && !savedIsAvailable && (
            <option value={modelValue(config)}>{`${config.provider} — ${config.modelName}`}</option>
          )}
          {models.map(model => (
            <option key={modelValue(model)} value={modelValue(model)}>
              {model.label}
            </option>
          ))}
        </select>
        {config && (
          <>
            <label htmlFor={`jev-${key}-effort`} className="block text-sm">
              {t('options_jev_reasoningEffort')}
            </label>
            <select
              id={`jev-${key}-effort`}
              className={fieldClass}
              value={config.reasoningEffort || ''}
              onChange={event =>
                update(key, { ...config, reasoningEffort: (event.target.value || undefined) as ReasoningEffort })
              }>
              <option value="">{t('options_jev_providerDefault')}</option>
              {(['none', 'low', 'medium', 'high', 'xhigh'] as const).map(effort => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </select>
          </>
        )}
      </div>
    );
  };

  return (
    <section
      className={`space-y-5 rounded-lg border p-6 text-left shadow-sm ${
        isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-blue-100 bg-white'
      }`}>
      <h2 className="text-xl font-semibold">{t('options_jev_header')}</h2>
      <p className={`text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{t('options_jev_description')}</p>
      <fieldset disabled={loading || saving} className="space-y-5">
        <label htmlFor="jev-enabled" className="flex items-center gap-3 font-medium">
          <input
            id="jev-enabled"
            type="checkbox"
            checked={settings.enabled}
            onChange={event => update('enabled', event.target.checked)}
          />
          {t('options_jev_enabled')}
        </label>
        <p className="text-sm">{t('options_jev_privacy')}</p>
        <div className="space-y-2">
          <label htmlFor="jev-api-key" className="block font-medium">
            {t('options_jev_apiKey')}
          </label>
          <input
            id="jev-api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            className={fieldClass}
            value={settings.apiKey}
            onChange={event => update('apiKey', event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="jev-model" className="block font-medium">
            {t('options_jev_model')}
          </label>
          <input
            id="jev-model"
            type="text"
            spellCheck={false}
            className={fieldClass}
            value={settings.model}
            onChange={event => update('model', event.target.value)}
          />
          <a
            href="https://docs.typesafe.ai/api"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-sky-500 underline">
            {t('options_jev_apiDocs')}
          </a>
        </div>
        <div className="grid grid-cols-2 gap-4">
          {(
            [
              ['timeoutMs', t('options_jev_timeout'), 1_000, 60_000, 1_000],
              ['proceedThreshold', t('options_jev_proceedThreshold'), 0, 1, 0.01],
              ['completionThreshold', t('options_jev_completionThreshold'), 0, 1, 0.01],
              ['selectionThreshold', t('options_jev_selectionThreshold'), 0, 1, 0.01],
            ] as const
          ).map(([key, label, min, max, step]) => (
            <div key={key} className="space-y-2">
              <label htmlFor={`jev-${key}`} className="block font-medium">
                {label}
              </label>
              <input
                id={`jev-${key}`}
                type="number"
                min={min}
                max={max}
                step={step}
                className={fieldClass}
                value={Number.isNaN(settings[key]) ? '' : settings[key]}
                onChange={event => update(key, event.target.valueAsNumber)}
              />
            </div>
          ))}
        </div>
        <label htmlFor="jev-routing" className="flex items-center gap-3 font-medium">
          <input
            id="jev-routing"
            type="checkbox"
            checked={settings.routingEnabled}
            onChange={event => update('routingEnabled', event.target.checked)}
          />
          {t('options_jev_routing')}
        </label>
        <p className="text-sm">{t('options_jev_routingDescription')}</p>
        <div className="grid grid-cols-2 gap-4">
          {routingModel('fastModel', t('options_jev_fastModel'))}
          {routingModel('capableModel', t('options_jev_capableModel'))}
        </div>
        <label htmlFor="jev-system1" className="flex items-center gap-3 font-medium">
          <input
            id="jev-system1"
            type="checkbox"
            checked={settings.system1Enabled}
            onChange={event => update('system1Enabled', event.target.checked)}
          />
          {t('options_jev_system1')}
        </label>
        <p className="text-sm">{t('options_jev_system1Description')}</p>
        <Button onClick={save} className="rounded-lg bg-sky-600 px-4 py-2 text-white hover:bg-sky-700">
          {saving ? t('options_jev_saving') : t('options_jev_save')}
        </Button>
      </fieldset>
      {status && (
        <p role="status" className={status === 'error' ? 'text-red-500' : 'text-green-600'}>
          {status === 'error' ? t('options_jev_saveError') : t('options_jev_saved')}
        </p>
      )}
    </section>
  );
};
