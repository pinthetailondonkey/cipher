const REQUEST_TYPES = new Set(['order_request', 'cipher_order']);
const CLOSED = new Set(['cancelled', 'completed', 'disputed']);

function isRequest(data) {
  return REQUEST_TYPES.has(data?.type);
}

// The order's state is the newest update either side sent for it. The
// request card itself only carries what this device changed locally.
export function orderState(messages, orderId, request) {
  const updates = (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.data?.type === 'order_update' && message.data.orderId === orderId)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0) || String(a.id).localeCompare(String(b.id)));
  const latest = updates[updates.length - 1] || null;
  const status = latest?.data?.status || request?.data?.status || 'pending';
  const paid = status === 'paid'
    || request?.data?.paymentState === 'confirmed'
    || updates.some((update) => update.data.paymentState === 'confirmed');
  return { status, paid, latestId: latest?.id || null };
}

// Buttons for one order card. `target` says which message the action is
// about: the request, so the handler gets the buyer's or the vendor's key,
// or the order itself, named by its id and sent to the vendor.
export function orderActionsFor(message, messages) {
  const data = message?.data;
  if (!data) return [];
  if (isRequest(data)) {
    const { status, paid } = orderState(messages, message.id, message);
    if (CLOSED.has(status)) return [];
    if (!message.isSender) {
      const actions = [];
      if (status === 'pending') actions.push({ action: 'decline_order', label: 'Decline', target: 'request' });
      if (paid && status !== 'shipped') actions.push({ action: 'mark_shipped', label: 'Mark shipped', target: 'request' });
      return actions;
    }
    return status === 'pending' ? [{ action: 'cancel_order', label: 'Cancel order', target: 'peer' }] : [];
  }
  if (data.type !== 'order_update' || message.isSender) return [];
  const request = (Array.isArray(messages) ? messages : []).find((item) => item?.id === data.orderId && isRequest(item.data));
  // Only the buyer acts on the vendor's updates, and only on the newest one.
  if (!request?.isSender) return [];
  const { status, latestId } = orderState(messages, data.orderId, request);
  if (latestId !== message.id || CLOSED.has(status)) return [];
  const actions = [];
  if (status === 'shipped') actions.push({ action: 'confirm_delivery', label: 'Confirm delivery', target: 'order' });
  if (['accepted', 'paid', 'shipped'].includes(status)) actions.push({ action: 'report_issue', label: 'Report an issue', target: 'order' });
  return actions;
}
