import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { navMenus } from '../constants/navMenus';
import { useAuth } from '../context/AuthContext';
import { filterNavMenus } from '../utils/userPermissions';
import tsaLogo from '../assets/tsa-logo.png';
import NavDropdown from './NavDropdown';
import BriefInfoLink from './BriefInfoLink';
import GlobalTrainingGapNotify from './GlobalTrainingGapNotify';
import UserProfileMenu from './UserProfileMenu';

export default function Navbar() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [openDropdown, setOpenDropdown] = useState(null);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    setOpenDropdown(null);
  }, []);

  const toggleDropdown = (id) => {
    setOpenDropdown((current) => (current === id ? null : id));
  };

  useEffect(() => {
    closeMenu();
  }, [location.pathname, closeMenu]);

  useEffect(() => {
    document.body.classList.toggle('nav-menu-open', menuOpen);
    return () => document.body.classList.remove('nav-menu-open');
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen && openDropdown === null) {
      return undefined;
    }

    const handlePointerDown = (event) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (navRef.current?.contains(target)) {
        return;
      }

      closeMenu();
    };

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        closeMenu();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown, { passive: true });
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen, openDropdown, closeMenu]);

  const handleLogout = () => {
    closeMenu();
    logout();
  };

  const visibleMenus = filterNavMenus(navMenus, user);

  return (
    <header className="navbar" ref={navRef}>
      <div className="navbar-inner">
        <NavLink to="/" className="navbar-brand" onClick={closeMenu}>
          <img className="navbar-logo" src={tsaLogo} alt="TSA Trevor Sadd Associates" />
          <span className="navbar-brand-text">
            <strong>Workplanner</strong>
            <span className="navbar-brand-version">2.0</span>
          </span>
        </NavLink>

        <div className="navbar-top-controls">
          <div className="navbar-mobile-notify">
            <GlobalTrainingGapNotify />
          </div>
          <div className="navbar-mobile-profile">
            <UserProfileMenu
              user={user}
              onLogout={handleLogout}
              onMenuToggle={() => setOpenDropdown(null)}
              closeSignal={openDropdown}
            />
          </div>
          <button
            type="button"
            className={`navbar-toggle${menuOpen ? ' is-open' : ''}`}
            aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span />
            <span />
            <span />
          </button>
        </div>

        <div className={`navbar-collapse${menuOpen ? ' is-open' : ''}`} id="navbar-menu">
          <nav className="navbar-links" aria-label="Main navigation">
            {visibleMenus.map((menu) =>
              menu.id === 'admin' ? (
                <div key={menu.id} className="navbar-admin-group">
                  <NavDropdown
                    menu={menu}
                    isOpen={openDropdown === menu.id}
                    onToggle={() => toggleDropdown(menu.id)}
                    onClose={() => setOpenDropdown(null)}
                    onNavigate={closeMenu}
                  />
                  <BriefInfoLink />
                </div>
              ) : (
                <NavDropdown
                  key={menu.id}
                  menu={menu}
                  isOpen={openDropdown === menu.id}
                  onToggle={() => toggleDropdown(menu.id)}
                  onClose={() => setOpenDropdown(null)}
                  onNavigate={closeMenu}
                />
              ),
            )}
          </nav>

          <div className="navbar-actions">
            <div className="navbar-desktop-notify">
              <GlobalTrainingGapNotify />
            </div>
            <div className="navbar-desktop-profile">
              <UserProfileMenu
                user={user}
                onLogout={handleLogout}
                onMenuToggle={() => setOpenDropdown(null)}
                closeSignal={openDropdown}
              />
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
