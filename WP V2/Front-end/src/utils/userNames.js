export function userDisplayName(user) {
  if (!user) return '';
  if (user.name) return user.name;
  return [user.first_name, user.last_name].filter(Boolean).join(' ');
}

export function userFirstName(user) {
  if (!user) return '';
  if (user.first_name) {
    return String(user.first_name).trim();
  }
  const display = userDisplayName(user);
  return display.split(/\s+/)[0] || '';
}

export function userInitials(user) {
  if (!user) return '?';
  const first = userFirstName(user);
  const lastInitial = user.last_name ? String(user.last_name).trim()[0] : '';
  if (first && lastInitial) {
    return `${first[0]}${lastInitial}`.toUpperCase();
  }
  if (first) {
    return first.slice(0, 2).toUpperCase();
  }
  return '?';
}

export function userNameKey(name) {
  return String(name || '').trim().toLowerCase();
}

export function userMatchesName(user, value) {
  if (!user || !value) return false;
  const needle = userNameKey(value);
  return userNameKey(userDisplayName(user)) === needle;
}

export function sortUsersByName(users) {
  return [...users].sort((a, b) =>
    userDisplayName(a).localeCompare(userDisplayName(b)),
  );
}
