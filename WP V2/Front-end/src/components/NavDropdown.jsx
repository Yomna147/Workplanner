import { useEffect, useRef } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

export default function NavDropdown({ menu, isOpen, onToggle, onClose, onNavigate }) {
  const ref = useRef(null);
  const location = useLocation();

  const isActive = menu.items.some(
    (item) => item.to && (item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to)),
  );

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const handleClickOutside = (event) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (ref.current?.contains(target)) {
        return;
      }
      // Let the other dropdown's trigger handle the switch on click — closing here
      // on mousedown collapses the open panel and shifts layout before the click lands.
      if (target instanceof Element && target.closest('.nav-dropdown-trigger')) {
        return;
      }
      onClose();
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside, { passive: true });
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, [isOpen, onClose]);

  return (
    <div className={`nav-dropdown${isOpen ? ' is-open' : ''}`} ref={ref}>
      <button
        type="button"
        className={`nav-dropdown-trigger${isActive ? ' active' : ''}`}
        aria-expanded={isOpen}
        aria-haspopup="true"
        onClick={onToggle}
      >
        {menu.label}
        <span className="nav-dropdown-chevron" aria-hidden="true" />
      </button>

      {isOpen ? (
        <div className="nav-dropdown-panel" role="menu">
          {menu.items.map((item) =>
            item.disabled ? (
              <span key={item.label} className="nav-dropdown-item disabled" role="menuitem">
                {item.label}
                <span className="nav-soon-badge">Soon</span>
              </span>
            ) : (
              <NavLink
                key={item.label}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive: linkActive }) =>
                  `nav-dropdown-item${linkActive ? ' active' : ''}`
                }
                role="menuitem"
                onClick={() => {
                  onClose();
                  onNavigate?.();
                }}
              >
                {item.label}
              </NavLink>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
