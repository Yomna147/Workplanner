import { userDisplayName, userNameKey } from './userNames';

/** Set to true when the Review assignments UI should be visible. */
export const ALGORITHM_ASSIGNMENT_REVIEW_ENABLED = false;

export function isAlgorithmAssignmentReviewUser(user) {
  if (!ALGORITHM_ASSIGNMENT_REVIEW_ENABLED || !user) return false;

  const candidates = [
    userDisplayName(user),
    user.login_name,
    [user.first_name, user.last_name].filter(Boolean).join(' '),
  ]
    .map((value) => userNameKey(value))
    .filter(Boolean);

  return candidates.some(
    (candidate) => candidate.includes('mohamed') && candidate.includes('khal'),
  );
}
