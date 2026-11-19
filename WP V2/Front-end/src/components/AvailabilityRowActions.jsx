function ActionButton({ title, borderColor, onClick, disabled = false, children }) {
  return (
    <button
      type="button"
      className="availability-action-btn"
      style={{ borderColor }}
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export default function AvailabilityRowActions({
  isEditing = false,
  onAddBelow,
  onDelete,
  onEdit,
  onDuplicate,
  onFinishEdit,
  showEdit = true,
  showDuplicate = true,
  showAdd = true,
  showDelete = true,
  disableDelete = false,
  duplicateBeforeDelete = false,
}) {
  const duplicateButton = showDuplicate && !isEditing ? (
    <ActionButton title="Duplicate row below" borderColor="#00a2e8" onClick={onDuplicate}>
      <svg height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="8" y="8" width="12" height="14" rx="1.5" stroke="#00a2e8" strokeWidth="1.5" />
        <rect x="4" y="4" width="12" height="14" rx="1.5" stroke="#00a2e8" strokeWidth="1.5" fill="#fff" />
      </svg>
    </ActionButton>
  ) : null;

  const editButton = showEdit && !isEditing ? (
    <ActionButton title="Edit row" borderColor="#0084ff" onClick={onEdit}>
      <svg height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12 20H20.5M18 10L21 7L17 3L14 6M18 10L8 20H4V16L14 6M18 10L14 6"
          stroke="#0084ff"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </ActionButton>
  ) : null;

  return (
    <div className="availability-row-actions">
      {isEditing && (
        <ActionButton title="Done editing" borderColor="#5fec13" onClick={onFinishEdit}>
          <svg height="15" viewBox="0 0 1024 1024" aria-hidden="true">
            <path
              fill="currentColor"
              d="M512 896a384 384 0 1 0 0-768 384 384 0 0 0 0 768zm0 64a448 448 0 1 1 0-896 448 448 0 0 1 0 896z"
            />
            <path
              fill="currentColor"
              d="M745.344 361.344a32 32 0 0 1 45.312 45.312l-288 288a32 32 0 0 1-45.312 0l-160-160a32 32 0 1 1 45.312-45.312L480 626.752l265.344-265.408z"
            />
          </svg>
        </ActionButton>
      )}

      {showAdd ? (
      <ActionButton title="Add row below" borderColor="#00a2e8" onClick={onAddBelow}>
        <svg height="15" viewBox="-1.7 0 20.4 20.4" aria-hidden="true">
          <path
            fill="#00a2e8"
            d="M16.416 10.283A7.917 7.917 0 1 1 8.5 2.366a7.916 7.916 0 0 1 7.916 7.917zm-2.958.01a.792.792 0 0 0-.792-.792H9.284V6.12a.792.792 0 1 0-1.583 0V9.5H4.32a.792.792 0 0 0 0 1.584H7.7v3.382a.792.792 0 0 0 1.583 0v-3.382h3.382a.792.792 0 0 0 .792-.791z"
          />
        </svg>
      </ActionButton>
      ) : null}

      {duplicateBeforeDelete ? duplicateButton : null}

      {showDelete ? (
        <ActionButton
          title="Clear day (holiday)"
          borderColor="#c59174"
          onClick={onDelete}
          disabled={disableDelete}
        >
          <svg height="15" viewBox="0 0 1024 1024" aria-hidden="true" className="availability-action-delete">
            <path
              fill="currentColor"
              d="M160 256H96a32 32 0 0 1 0-64h256V95.936a32 32 0 0 1 32-32h256a32 32 0 0 1 32 32V192h256a32 32 0 1 1 0 64h-64v672a32 32 0 0 1-32 32H192a32 32 0 0 1-32-32V256zm448-64v-64H416v64h192zM224 896h576V256H224v640zm192-128a32 32 0 0 1-32-32V416a32 32 0 0 1 64 0v320a32 32 0 0 1-32 32zm192 0a32 32 0 0 1-32-32V416a32 32 0 0 1 64 0v320a32 32 0 0 1-32 32z"
            />
          </svg>
        </ActionButton>
      ) : null}

      {!duplicateBeforeDelete ? duplicateButton : null}
      {editButton}
    </div>
  );
}
