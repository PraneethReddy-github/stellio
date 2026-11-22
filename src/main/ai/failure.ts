import { CANCELLED_MESSAGE } from '@shared/messages';

/** User-facing message for a failed Claude run (status from the runner). */
export function aiFailureMessage(status: string, error: string): string {
  switch (status) {
    case 'auth':
      return 'Claude CLI is not logged in. Run `claude` in a terminal and log in, then try again.';
    case 'usage_limit':
      return 'Your Claude usage limit is reached. Try again after it resets.';
    case 'bad_model':
      return 'The configured model id is not recognised. Check Settings → AI.';
    case 'timeout':
      return 'Claude took too long and the run was stopped. Try again.';
    case 'cancelled':
      return CANCELLED_MESSAGE;
    case 'invalid_output':
      return 'Claude returned output in the wrong shape twice. Try again; details are in Activity.';
    default:
      return `Claude run failed: ${error.slice(0, 300)}`;
  }
}
