import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { employeeInitials } from '../utils/trainingForm';
import {
  TRAINING_GAP_NOTIFY_WEEKS,
  formatGapOpportunityMessage,
  groupGapOpportunitiesByTeam,
  pickClosestGapOpportunity,
} from '../utils/trainingGapNotifications';

function formatLowLoadMessage(row) {
  return formatGapOpportunityMessage(row);
}

function OpportunityCardDetails({ row }) {
  return (
    <p className="trainings-gap-notify-card-meta">{formatLowLoadMessage(row)}</p>
  );
}

function OpportunityCard({ row, onAssign, showTeamInMeta = false }) {
  const openSlots = row.openSlotDays || 0;

  const handleCardActivate = () => {
    onAssign?.(row);
  };

  return (
    <li className="trainings-gap-notify-card">
      <button
        type="button"
        className="trainings-gap-notify-card-main"
        onClick={handleCardActivate}
        disabled={!onAssign}
      >
        <span className="trainings-gap-notify-card-avatar" aria-hidden="true">
          {employeeInitials(row.name)}
        </span>
        <div className="trainings-gap-notify-card-body">
          {openSlots > 0 ? (
            <div className="trainings-gap-notify-card-top">
              <span className="trainings-gap-notify-card-badge">
                {openSlots}
                {' free '}
                {openSlots === 1 ? 'day' : 'days'}
              </span>
            </div>
          ) : null}
          {showTeamInMeta ? (
            <p className="trainings-gap-notify-card-meta trainings-gap-notify-card-meta--team">
              {row.teamName || 'NRM section'}
            </p>
          ) : null}
          <OpportunityCardDetails row={row} />
        </div>
      </button>
      {onAssign ? (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => onAssign(row)}
        >
          Assign
        </button>
      ) : null}
    </li>
  );
}

function OpportunityList({ opportunities, onAssign, groupByTeam = true, listId }) {
  if (!groupByTeam) {
    return (
      <ul id={listId} className="trainings-gap-notify-cards">
        {opportunities.map((row) => (
          <OpportunityCard
            key={row.employeeId}
            row={row}
            onAssign={onAssign}
            showTeamInMeta
          />
        ))}
      </ul>
    );
  }

  const groups = groupGapOpportunitiesByTeam(opportunities);

  return (
    <div id={listId} className="trainings-gap-notify-team-groups">
      {groups.map((group) => (
        <section key={group.teamName} className="trainings-gap-notify-team-group">
          <h4 className="trainings-gap-notify-team-heading">{group.teamName}</h4>
          <ul className="trainings-gap-notify-cards trainings-gap-notify-cards--grouped">
            {group.rows.map((row) => (
              <OpportunityCard
                key={row.employeeId}
                row={row}
                onAssign={onAssign}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function GapClosestPopup({
  opportunity,
  onAssign,
  onDismiss,
  autoDismissMs = 8000,
}) {
  useEffect(() => {
    if (!opportunity || !onDismiss || !autoDismissMs || autoDismissMs <= 0) {
      return undefined;
    }

    const timerId = window.setTimeout(() => {
      onDismiss();
    }, autoDismissMs);

    return () => window.clearTimeout(timerId);
  }, [opportunity, onDismiss, autoDismissMs]);

  if (!opportunity) {
    return null;
  }

  return (
    <div className="trainings-gap-closest-popup" role="status">
      <button
        type="button"
        className="trainings-gap-closest-popup__main"
        onClick={() => onAssign?.(opportunity)}
      >
        <span className="trainings-gap-closest-popup__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="16" height="16" focusable="false">
            <path
              fill="currentColor"
              d="M12 22a2.2 2.2 0 0 0 2.2-2.2h-4.4A2.2 2.2 0 0 0 12 22Zm7.2-6.2V11a7.2 7.2 0 0 0-5.4-7V3.4a1.8 1.8 0 1 0-3.6 0V4A7.2 7.2 0 0 0 4.8 11v4.8L3 17.6V18.8h18v-1.2l-1.8-1.8Z"
            />
          </svg>
        </span>
        <span className="trainings-gap-closest-popup__copy">
          <span className="trainings-gap-closest-popup__message">
            {formatGapOpportunityMessage(opportunity, { closestOnly: true })}
          </span>
        </span>
      </button>
      <button
        type="button"
        className="trainings-gap-closest-popup__dismiss"
        aria-label="Dismiss low-load alert"
        onClick={() => onDismiss?.()}
      >
        ×
      </button>
    </div>
  );
}

function formatNoticeWhen(value) {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function NoticeList({ items, onOpenNotice, onDismissNotice }) {
  return (
    <ul className="trainings-gap-notify-cards bell-notify-list">
      {items.map((item) => {
        const when = formatNoticeWhen(item.created_at);
        const body = String(item.body || '');
        const [leadLine, ...restLines] = body.split('\n');
        const rest = restLines.join('\n').replace(/^\n+/, '').trim();
        const href = typeof item.href === 'string' && item.href.trim() !== ''
          ? item.href.trim()
          : null;
        const content = (
          <div className="trainings-gap-notify-card-body">
            <strong className="bell-notify-card-title">{item.title}</strong>
            {leadLine ? (
              <p className="trainings-gap-notify-card-meta bell-notify-card-lead">{leadLine}</p>
            ) : null}
            {rest ? (
              <p className="trainings-gap-notify-card-meta">{rest}</p>
            ) : null}
            {when ? (
              <p className="trainings-gap-notify-card-meta bell-notify-card-when">{when}</p>
            ) : null}
          </div>
        );

        return (
          <li key={item.id} className="trainings-gap-notify-card bell-notify-card">
            {href ? (
              <button
                type="button"
                className="trainings-gap-notify-card-main bell-notify-card-link"
                onClick={() => onOpenNotice?.(href)}
              >
                {content}
              </button>
            ) : content}
            {onDismissNotice ? (
              <button
                type="button"
                className="bell-notify-card-dismiss"
                aria-label="Dismiss notification"
                title="Dismiss"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onDismissNotice(item.id);
                }}
              >
                ×
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function LowLoadSection({ opportunities, onAssign, onClose }) {
  const count = opportunities.length;
  if (count === 0) {
    return null;
  }
  const weekLabel = TRAINING_GAP_NOTIFY_WEEKS === 1 ? 'week' : 'weeks';

  return (
    <>
      <p className="bell-notify-section-label">Low-load opportunities</p>
      <p className="trainings-gap-notify-panel-copy">
        NRM section operatives with free capacity in the next
        {' '}
        {TRAINING_GAP_NOTIFY_WEEKS}
        {' '}
        {weekLabel}
        .
      </p>
      <OpportunityList
        opportunities={opportunities}
        onAssign={onAssign
          ? (opportunity) => {
            onClose?.();
            onAssign(opportunity);
          }
          : undefined}
      />
    </>
  );
}

function GapNotifyBell({
  opportunities,
  trainingNotices = [],
  systemNotices = [],
  unreadCount = null,
  onDismiss,
  onAssignOne,
  onOpen,
  onOpenNotice,
  onDismissNotice,
  className = '',
  defaultTab = 'trainings',
  showTrainingTab = true,
  gapsInSystemTab = false,
}) {
  const [open, setOpen] = useState(false);
  const [menuTab, setMenuTab] = useState(defaultTab);
  const rootRef = useRef(null);
  const onOpenRef = useRef(onOpen);
  const count = opportunities.length;
  const unread = unreadCount == null ? count : unreadCount;
  const trainingCount = gapsInSystemTab
    ? trainingNotices.length
    : trainingNotices.length + count;
  const systemCount = gapsInSystemTab
    ? systemNotices.length + count
    : systemNotices.length;
  const badgeCount = unread + systemNotices.length + trainingNotices.length;

  useEffect(() => {
    setMenuTab(defaultTab);
  }, [defaultTab]);

  onOpenRef.current = onOpen;

  const toggleOpen = () => {
    setOpen((current) => !current);
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    onOpenRef.current?.();
  }, [open]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleClickOutside = (event) => {
      if (rootRef.current?.contains(event.target)) {
        return;
      }
      setOpen(false);
    };

    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={`trainings-gap-notify${open ? ' is-open' : ''}${className ? ` ${className}` : ''}`}
    >
      <button
        type="button"
        className="trainings-gap-notify-bell"
        aria-label={`${badgeCount} notifications`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Notifications"
        onClick={toggleOpen}
      >
        <svg
          className="trainings-gap-notify-bell-icon"
          viewBox="0 0 24 24"
          width="18"
          height="18"
          aria-hidden="true"
          focusable="false"
        >
          <path
            fill="currentColor"
            d="M12 22a2.2 2.2 0 0 0 2.2-2.2h-4.4A2.2 2.2 0 0 0 12 22Zm7.2-6.2V11a7.2 7.2 0 0 0-5.4-7V3.4a1.8 1.8 0 1 0-3.6 0V4A7.2 7.2 0 0 0 4.8 11v4.8L3 17.6V18.8h18v-1.2l-1.8-1.8Z"
          />
        </svg>
        {badgeCount > 0 ? (
          <span
            className={`trainings-gap-notify-badge${unread > 0 ? ' is-unread' : ''}`}
            aria-hidden="true"
          >
            {badgeCount > 9 ? '9+' : badgeCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          className="trainings-gap-notify-panel card"
          role="dialog"
          aria-label="Notifications"
        >
          <div className="trainings-gap-notify-panel-head">
            <strong>Notifications</strong>
          </div>
          {showTrainingTab ? (
            <div
              className="trainings-view-toggle bell-notify-tabs"
              role="tablist"
              aria-label="Notification types"
              data-active-view={menuTab}
            >
              <button
                type="button"
                role="tab"
                aria-selected={menuTab === 'system'}
                className={`btn btn-secondary btn-sm trainings-view-tab${menuTab === 'system' ? ' is-active' : ''}`}
                onClick={() => setMenuTab('system')}
              >
                System
                <span className="bell-notify-tab-count">{systemCount}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={menuTab === 'trainings'}
                className={`btn btn-secondary btn-sm trainings-view-tab${menuTab === 'trainings' ? ' is-active' : ''}`}
                onClick={() => setMenuTab('trainings')}
              >
                Trainings
                <span className="bell-notify-tab-count">{trainingCount}</span>
              </button>
            </div>
          ) : null}
          {showTrainingTab && menuTab === 'trainings' ? (
            <div className="bell-notify-body">
              {trainingNotices.length > 0 ? (
                <NoticeList
                  items={trainingNotices}
                  onDismissNotice={onDismissNotice}
                  onOpenNotice={(href) => {
                    setOpen(false);
                    onOpenNotice?.(href);
                  }}
                />
              ) : null}
              {!gapsInSystemTab ? (
                <LowLoadSection
                  opportunities={opportunities}
                  onAssign={onAssignOne}
                  onClose={() => setOpen(false)}
                />
              ) : null}
              {trainingCount === 0 ? (
                <p className="bell-notify-empty">No training notifications.</p>
              ) : null}
            </div>
          ) : (
            <div className="bell-notify-body">
              {systemNotices.length > 0 ? (
                <NoticeList
                  items={systemNotices}
                  onDismissNotice={onDismissNotice}
                  onOpenNotice={(href) => {
                    setOpen(false);
                    onOpenNotice?.(href);
                  }}
                />
              ) : null}
              {gapsInSystemTab ? (
                <LowLoadSection
                  opportunities={opportunities}
                  onAssign={onAssignOne}
                  onClose={() => setOpen(false)}
                />
              ) : null}
              {systemCount === 0 ? (
                <p className="bell-notify-empty">No system notifications.</p>
              ) : null}
            </div>
          )}
          {((gapsInSystemTab && menuTab === 'system') || (!gapsInSystemTab && menuTab === 'trainings'))
            && count > 0 ? (
              <div className="trainings-gap-notify-banner__actions">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    setOpen(false);
                    onDismiss?.();
                  }}
                >
                  Not now
                </button>
              </div>
            ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function TrainingGapNotifyBanner({
  opportunities = [],
  unreadCount = null,
  onDismiss,
  onAssignOne,
  onOpenBell,
  showBell = true,
  showClosestPopup = false,
  className = '',
  defaultTab = 'trainings',
  showTrainingTab = true,
  gapsInSystemTab = false,
}) {
  const navigate = useNavigate();
  const gapOpportunities = Array.isArray(opportunities) ? opportunities : [];
  const [trainingNotices, setTrainingNotices] = useState([]);
  const [systemNotices, setSystemNotices] = useState([]);
  const closestOpportunity = useMemo(
    () => pickClosestGapOpportunity(gapOpportunities),
    [gapOpportunities],
  );

  const handleOpenNotice = useCallback((href) => {
    if (!href) {
      return;
    }
    navigate(href);
  }, [navigate]);

  const noticeHasContent = useCallback((item) => {
    if (!item || typeof item !== 'object') {
      return false;
    }
    return String(item.title || '').trim() !== ''
      || String(item.body || '').trim() !== '';
  }, []);

  const loadInbox = useCallback(() => {
    api.get('/notifications/inbox')
      .then((response) => {
        const payload = response.data?.data || {};
        const trainings = Array.isArray(payload.trainings) ? payload.trainings : [];
        const system = Array.isArray(payload.system) ? payload.system : [];
        setTrainingNotices(trainings.filter(noticeHasContent));
        setSystemNotices(system.filter(noticeHasContent));
      })
      .catch(() => {
        setTrainingNotices([]);
        setSystemNotices([]);
      });
  }, [noticeHasContent]);

  useEffect(() => {
    if (!showBell) {
      return undefined;
    }
    loadInbox();
    return undefined;
  }, [loadInbox, showBell]);

  const handleOpenBell = () => {
    onOpenBell?.();
    loadInbox();
  };

  const handleDismissNotice = useCallback((noticeId) => {
    if (!noticeId) {
      return;
    }
    setTrainingNotices((current) => current.filter((item) => item.id !== noticeId));
    setSystemNotices((current) => current.filter((item) => item.id !== noticeId));
    api.post('/notifications/inbox/dismiss', { id: noticeId }).catch(() => {
      loadInbox();
    });
  }, [loadInbox]);

  return (
    <>
      {showClosestPopup && gapOpportunities.length > 0 ? (
        <GapClosestPopup
          opportunity={closestOpportunity}
          onAssign={onAssignOne}
          onDismiss={onDismiss}
        />
      ) : null}
      {showBell ? (
        <GapNotifyBell
          className={className}
          opportunities={gapOpportunities}
          trainingNotices={trainingNotices}
          systemNotices={systemNotices}
          unreadCount={unreadCount}
          onDismiss={onDismiss}
          onOpen={handleOpenBell}
          onOpenNotice={handleOpenNotice}
          onDismissNotice={handleDismissNotice}
          onAssignOne={onAssignOne}
          defaultTab={defaultTab}
          showTrainingTab={showTrainingTab}
          gapsInSystemTab={gapsInSystemTab}
        />
      ) : null}
    </>
  );
}
