import { useEffect, useRef, useState } from 'react';
import { userFirstName, userInitials } from '../utils/userNames';

export default function UserProfileMenu({ user, onLogout, onMenuToggle, closeSignal = null }) {
  const menuRef = useRef(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (closeSignal) {
      setIsOpen(false);
    }
  }, [closeSignal]);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const handleClickOutside = (event) => {
      const target = event.target;
      if (!(target instanceof Node) || menuRef.current?.contains(target)) {
        return;
      }
      setIsOpen(false);
    };

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside, { passive: true });
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  if (!user) {
    return null;
  }

  const firstName = userFirstName(user);
  const initials = userInitials(user);
  const loginName = user.login_name || firstName;
  const accessRole = user.role?.name || (user.is_admin ? 'Admin' : 'User');
  const accountStatus = user.active === false ? 'Inactive' : 'Active';

  const handleToggle = () => {
    setIsOpen((open) => {
      const next = !open;
      if (next) {
        onMenuToggle?.();
      }
      return next;
    });
  };

  const handleLogout = () => {
    setIsOpen(false);
    onLogout?.();
  };

  return (
    <div className={`user-profile-menu${isOpen ? ' is-open' : ''}`} ref={menuRef}>
      <button
        type="button"
        className="user-profile-trigger"
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        onClick={handleToggle}
      >
        <span className="user-profile-trigger-avatar" aria-hidden="true">
          {initials}
        </span>
        <span className="user-profile-trigger-name">{firstName}</span>
        <span className="user-profile-trigger-chevron" aria-hidden="true" />
      </button>

      {isOpen ? (
        <div className="user-profile-panel" role="dialog" aria-label="User profile">
          <div className="user-profile-panel-header">
            <span className="user-profile-avatar" aria-hidden="true">
              {initials}
            </span>
            <div className="user-profile-panel-heading">
              <strong>{firstName}</strong>
              <span className="user-profile-login">Login: {loginName}</span>
            </div>
          </div>

          <dl className="user-profile-meta">
            <div className="user-profile-meta-row">
              <dt>Access role</dt>
              <dd>{accessRole}</dd>
            </div>
            <div className="user-profile-meta-row">
              <dt>CRM responsible</dt>
              <dd>{firstName}</dd>
            </div>
            <div className="user-profile-meta-row">
              <dt>Account</dt>
              <dd>{accountStatus}</dd>
            </div>
          </dl>

          <button type="button" className="user-profile-logout-btn" onClick={handleLogout}>
            Log out
          </button>
        </div>
      ) : null}
    </div>
  );
}
