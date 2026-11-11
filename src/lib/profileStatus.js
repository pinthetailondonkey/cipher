// The public status line: what a profile publishes beside its display
// name. Public by choice, so the text is cleaned before it ever reaches
// the wire: control characters stripped, whitespace collapsed, and a
// length cap that fits a name plate.
export const STATUS_MAX = 60;

export function sanitizeStatus(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, STATUS_MAX);
}
