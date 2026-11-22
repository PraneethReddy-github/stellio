import { profilePlaceholders, type Profile } from '@shared/profile';
import { UserError } from '../../ipc/dispatch';

/** Refuses to send example content from the seed profile to a document or message. */
export function requireRealProfile(model: Profile): void {
  const first = profilePlaceholders(model)[0];
  if (first) throw new UserError(first.message);
}
