import { z } from 'zod';
import { profilePlaceholders, type Profile } from '../profile';

/** What the first-run Setup checklist remembers (`settings_kv`). Step status itself is always live. */
export const SetupStateSchema = z.object({
  /** The user closed the checklist. */
  dismissed: z.boolean(),
  /** Every required step was done once; the checklist stays away afterwards. */
  completed: z.boolean(),
  /** The Rules screen was opened (there is nothing to detect: reading is the step). */
  rulesReviewed: z.boolean(),
});
export type SetupState = z.infer<typeof SetupStateSchema>;
export const DEFAULT_SETUP: SetupState = { dismissed: false, completed: false, rulesReviewed: false };
export const SetupPatchSchema = SetupStateSchema.partial();

export type SetupStepId = 'claude' | 'profile' | 'rules' | 'search' | 'latex' | 'scan';
export type StepStatus = 'done' | 'todo' | 'checking';

export interface SetupStep {
  id: SetupStepId;
  title: string;
  status: StepStatus;
  optional: boolean;
  /** Honest one-liner: what is true now, or what is missing. */
  detail: string;
  /** Label of the one action, and where it goes (`section` = a Settings section). */
  action: { label: string; to: string; section?: string };
}

/** `undefined` = not loaded yet. */
export interface SetupInputs {
  ai: { installed: boolean; loggedIn?: boolean; error?: string } | undefined;
  profile: Profile | undefined;
  rulesReviewed: boolean;
  searchProfiles: number | undefined;
  latex: { engine: object | null; sandbox?: 'bwrap' | null; installSupported: boolean } | undefined;
  scanEnabled: boolean | undefined;
}

const unknown = (v: unknown): boolean => v === undefined;

/** The checklist rows with live status. Pure. */
export function setupSteps(i: SetupInputs): SetupStep[] {
  const st = (loaded: boolean, done: boolean): StepStatus => (!loaded ? 'checking' : done ? 'done' : 'todo');

  const ai = i.ai;
  const aiOk = ai?.installed === true && ai.loggedIn === true;
  const claudeDetail = !ai
    ? 'Checking the Claude CLI.'
    : !ai.installed
      ? 'The Claude CLI was not found. Install it, then run `claude` once to log in.'
      : ai.loggedIn !== true
        ? 'The Claude CLI is installed but not logged in. Run `claude` in a terminal and log in.'
        : 'The Claude CLI is installed and logged in.';

  const problems = i.profile ? profilePlaceholders(i.profile) : [];
  const profileDetail = !i.profile
    ? 'Reading your profile.'
    : problems.length === 0
      ? 'Your profile has a name and an email and no example entries.'
      : `${(problems[0]?.message ?? '').replace(' in Profile first', '')}${
          problems.length > 1 ? ` ${String(problems.length - 1)} more to fix.` : ''
        }`;

  const l = i.latex;
  const latexOk = l?.engine != null && l.sandbox === 'bwrap';
  const latexDetail = !l
    ? 'Checking the LaTeX engine.'
    : l.engine == null
      ? l.installSupported
        ? 'No LaTeX engine found. Install Tectonic in Settings (a small local download).'
        : 'No LaTeX engine found. Install one, then check again in Settings.'
      : l.sandbox !== 'bwrap'
        ? 'The engine is there, but the compile sandbox is not working. Install bubblewrap (see Settings).'
        : 'The LaTeX engine and the compile sandbox are ready.';

  return [
    {
      id: 'claude',
      title: 'Claude CLI installed and logged in',
      status: st(!unknown(ai), aiOk),
      optional: false,
      detail: claudeDetail,
      action: { label: 'Open AI settings', to: '/settings', section: 'ai' },
    },
    {
      id: 'profile',
      title: 'Profile filled in',
      status: st(!unknown(i.profile), i.profile !== undefined && problems.length === 0),
      optional: false,
      detail: profileDetail,
      action: { label: 'Open Profile', to: '/profile' },
    },
    {
      id: 'rules',
      title: 'Rules reviewed',
      status: i.rulesReviewed ? 'done' : 'todo',
      optional: false,
      detail: i.rulesReviewed
        ? 'You have looked at your rules.'
        : 'Rules decide how Stellio writes for you. Skim them; you can edit them any time.',
      action: { label: 'Review rules', to: '/rules' },
    },
    {
      id: 'search',
      title: 'Search profile created',
      status: st(!unknown(i.searchProfiles), (i.searchProfiles ?? 0) > 0),
      optional: false,
      detail: !unknown(i.searchProfiles)
        ? (i.searchProfiles ?? 0) > 0
          ? 'You have a search profile.'
          : 'No search profile yet. A scan needs one: roles, places, remote.'
        : 'Checking your search profiles.',
      action: { label: 'Add a search profile', to: '/settings', section: 'profiles' },
    },
    {
      id: 'latex',
      title: 'LaTeX engine and sandbox ready',
      status: st(!unknown(l), latexOk),
      optional: false,
      detail: latexDetail,
      action: { label: 'Open LaTeX settings', to: '/settings', section: 'latex' },
    },
    {
      id: 'scan',
      title: 'Daily scan on (optional)',
      status: st(!unknown(i.scanEnabled), i.scanEnabled === true),
      optional: true,
      detail:
        i.scanEnabled === true
          ? 'Stellio scans once a day while it is open.'
          : 'Off. Scans then run only when you start one. Turning it on uses Claude usage each day.',
      action: { label: 'Open Schedule', to: '/settings', section: 'schedule' },
    },
  ];
}

/** Every required step is done. */
export const setupComplete = (steps: readonly SetupStep[]): boolean =>
  steps.every((s) => s.optional || s.status === 'done');
