/**
 * createMessenger(elementId) → setMessage(msg, isError, isHint)
 *
 * Returns a function that writes a status message to the named element.
 * isError  → --color-error (red)
 * isHint   → --color-text-muted (grey)
 * default  → --color-success (green)
 */
export function createMessenger(elementId) {
    return function setMessage(msg, isError = false, isHint = false) {
        const el = document.getElementById(elementId);
        if (!el) return;
        el.textContent = msg;
        el.style.color = isError
            ? 'var(--color-error)'
            : isHint
            ? 'var(--color-text-muted)'
            : 'var(--color-success)';
    };
}
