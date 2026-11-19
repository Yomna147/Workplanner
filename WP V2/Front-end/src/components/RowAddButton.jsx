export default function RowAddButton({ title, onClick, className = '' }) {
  return (
    <button
      type="button"
      className={`availability-action-btn row-add-btn ${className}`.trim()}
      style={{ borderColor: '#00a2e8' }}
      title={title}
      aria-label={title}
      onClick={onClick}
    >
      <svg height="15" viewBox="-1.7 0 20.4 20.4" aria-hidden="true">
        <path
          fill="#00a2e8"
          d="M16.416 10.283A7.917 7.917 0 1 1 8.5 2.366a7.916 7.916 0 0 1 7.916 7.917zm-2.958.01a.792.792 0 0 0-.792-.792H9.284V6.12a.792.792 0 1 0-1.583 0V9.5H4.32a.792.792 0 0 0 0 1.584H7.7v3.382a.792.792 0 0 0 1.583 0v-3.382h3.382a.792.792 0 0 0 .792-.791z"
        />
      </svg>
    </button>
  );
}
