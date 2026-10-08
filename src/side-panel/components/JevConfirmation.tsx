import { t } from '@extension/i18n';
import type { JevConfirmationRequest } from '../types/confirmation';

export const JevConfirmation = ({
  request,
  onDecide,
  isDarkMode,
}: {
  request: JevConfirmationRequest;
  onDecide: (approved: boolean) => void;
  isDarkMode: boolean;
}) => (
  <div
    role="alert"
    className={`m-2 space-y-3 rounded-lg border p-3 ${
      isDarkMode ? 'border-amber-700 bg-slate-800 text-gray-200' : 'border-amber-300 bg-amber-50 text-gray-800'
    }`}>
    <h3 className="font-semibold">{t('chat_jev_confirmationTitle')}</h3>
    <p className="break-words text-sm">
      <strong>{request.actionName}</strong>: {request.summary}
    </p>
    <p className="text-xs">{t('chat_jev_confirmationDescription')}</p>
    <div className="flex gap-2">
      <button
        type="button"
        onClick={() => onDecide(true)}
        className="rounded-md bg-sky-600 px-3 py-2 text-sm text-white hover:bg-sky-700">
        {t('chat_jev_approve')}
      </button>
      <button
        type="button"
        onClick={() => onDecide(false)}
        className={`rounded-md border px-3 py-2 text-sm ${isDarkMode ? 'border-slate-600 hover:bg-slate-700' : 'border-gray-300 hover:bg-white'}`}>
        {t('chat_jev_reject')}
      </button>
    </div>
  </div>
);
