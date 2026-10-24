import { useChatStore } from '../../store/chatStore';
import { db, saveMessage } from '../../db';
import { scopedGet } from '../../lib/storage';
import { getOrderPaymentMethods } from '../../lib/vendorPayments';

export function useCommerce({ identity, sendDM, sendGroupMessage, sendVouch, openChat }) {
  const setToast = useChatStore((s) => s.setToast);
  const setSelectedMessage = useChatStore((s) => s.setSelectedMessage);
  const setDms = useChatStore((s) => s.setDms);
  const setVendorStorefrontPubkey = useChatStore((s) => s.setVendorStorefrontPubkey);
  const editingProduct = useChatStore((s) => s.editingProduct);
  const setEditingProduct = useChatStore((s) => s.setEditingProduct);
  const activeGroup = useChatStore((s) => s.activeGroup);
  const activeDm = useChatStore((s) => s.activeDm);
  const setBroadcastProduct = useChatStore((s) => s.setBroadcastProduct);

  const updateLocalOrder = (peerPubkey, orderId, updateData) => {
    useChatStore.getState().setDms(prev => {
      const msgs = prev[peerPubkey] || [];
      const updated = msgs.map(m => m.id === orderId ? { ...m, data: { ...m.data, ...updateData } } : m);
      return { ...prev, [peerPubkey]: updated };
    });
  };
  const handleOrderAction = async (action, msg) => {
    if (!['accept_order', 'decline_order', 'cancel_order', 'confirm_payment', 'mark_shipped', 'confirm_delivery', 'report_issue'].includes(action)) {
      return false;
    }
  
      if (action === 'accept_order') {
        const baseBtc = scopedGet('btc_address', localStorage.getItem('cipher_btc_address') || localStorage.getItem('cipher_btc') || '');
        const baseXmr = scopedGet('xmr_address', localStorage.getItem('cipher_xmr_address') || localStorage.getItem('cipher_xmr') || '');
        let paymentMethods;
        try {
          paymentMethods = await getOrderPaymentMethods(
            identity,
            msg.data.orderId || msg.id,
            { btc: baseBtc, xmr: baseXmr },
            msg.data.paymentMethod || 'btc',
          );
        } catch (error) {
          console.error('[orders] Could not prepare private payment addresses:', error);
          setToast({ type: 'error', message: error?.message || 'Could not create order payment addresses.' });
          setSelectedMessage(null);
          return true;
        }
        if (!paymentMethods.btc && !paymentMethods.xmr) {
          setToast({ type: 'error', message: 'Set payment addresses in Profile first' });
          setSelectedMessage(null);
          return true;
        }
        const payload = {
          type: 'order_update', orderId: msg.id,
          productName: msg.data.product?.title || msg.data.productName,
          product: msg.data.product || null,
          status: 'accepted', paymentMethods,
        };
        const result = await sendDM(msg.pubkey, payload);
        if (!result.success) {
          setToast({ type: 'error', message: result.error || 'Could not send order acceptance.' });
          setSelectedMessage(null);
          return true;
        }
        updateLocalOrder(msg.pubkey, msg.id, { status: 'accepted', paymentMethods: payload.paymentMethods });
        setToast({ type: 'success', message: result.queued ? 'Acceptance queued; it will send when connected.' : 'Order accepted' });
        setSelectedMessage(null); return;
      }
      if (action === 'decline_order' || action === 'cancel_order') {
        const payload = { type: 'order_update', orderId: msg.id, productName: msg.data.product?.title, status: 'cancelled' };
        await sendDM(msg.pubkey, payload);
        updateLocalOrder(msg.pubkey, msg.id, { status: 'cancelled' });
        setToast({ type: 'success', message: 'Order cancelled' });
        setSelectedMessage(null); return;
      }
      if (action === 'confirm_payment') {
        const payload = { type: 'order_update', orderId: msg.id, productName: msg.data.product?.title || msg.data.productName, status: 'paid', shippingAddress: msg.data.shippingAddress };
        await sendDM(msg.pubkey, payload);
        updateLocalOrder(msg.pubkey, msg.id, { status: 'paid', shippingAddress: msg.data.shippingAddress });
        setToast({ type: 'success', message: 'Payment confirmed' });
        setSelectedMessage(null); return;
      }
      if (action === 'mark_shipped') {
        const tracking = msg.data?.tracking || '';
        const payload = { type: 'order_update', orderId: msg.id, productName: msg.data.product?.title || msg.data.productName, status: 'shipped', tracking };
        await sendDM(msg.pubkey, payload);
        updateLocalOrder(msg.pubkey, msg.id, { status: 'shipped', tracking });
        setToast({ type: 'success', message: tracking ? 'Shipped' : 'Marked shipped' });
        setSelectedMessage(null); return;
      }
      if (action === 'confirm_delivery') {
        const payload = { type: 'order_update', orderId: msg.id, productName: msg.data.product?.title || msg.data.productName, status: 'completed' };
        await sendDM(msg.pubkey, payload);
        updateLocalOrder(msg.pubkey, msg.id, { status: 'completed' });
        if (scopedGet('auto_vouch_on_delivery', true)) {
          const vouchResult = await sendVouch(msg.pubkey);
          if (!vouchResult.success) console.error('[orders] Automatic delivery vouch failed:', vouchResult.error);
        }
        setToast({ type: 'success', message: 'Delivered' });
        setSelectedMessage(null); return;
      }
      if (action === 'report_issue') {
        useChatStore.getState().openDialog({
          title: 'Report an Issue', hasInput: true, placeholder: 'e.g. Not shipped, wrong item, damaged',
          type: 'danger', confirmText: 'Submit',
          onConfirm: async (reason) => {
            if (!reason || !reason.trim()) return;
            const payload = { type: 'order_update', orderId: msg.id, productName: msg.data.product?.title, status: 'disputed', disputeReason: reason.trim() };
            await sendDM(msg.pubkey, payload);
            updateLocalOrder(msg.pubkey, msg.id, { status: 'disputed', disputeReason: reason.trim() });
            setToast({ type: 'success', message: 'Issue reported' });
          },
        });
        setSelectedMessage(null); return;
      }
  
    return true;
  };

  const startOrderWithVendor = async (vendorPubkey, product, listingId) => {
    if (!identity?.sk || !vendorPubkey) {
      setToast({ type: 'error', message: 'Unlock your account to contact the seller.' });
      return;
    }
    if (vendorPubkey === identity.pk) {
      setToast({ type: 'error', message: 'You cannot place an order with yourself.' });
      return;
    }

    const orderProduct = {
      id: listingId || product.id || null,
      title: product.title || product.name || 'Product',
      price: product.price || product.priceUsd || '',
      currency: product.currency || (product.priceUsd ? 'USD' : ''),
      priceUsd: product.priceUsd,
      image: product.image || '',
      description: product.description || '',
    };
    const paymentMethod = scopedGet('preferred_payment_method', 'btc');
    const payload = { type: 'order_request', status: 'pending', paymentMethod, product: orderProduct };
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const optimisticMessage = {
      id: tempId,
      clientId: tempId,
      isSender: true,
      isGroup: false,
      pubkey: identity.pk,
      timestamp: Math.floor(Date.now() / 1000),
      local_timestamp: Date.now(),
      deliveryStatus: 'sending',
      data: payload,
    };

    openChat('dm', vendorPubkey);
    setVendorStorefrontPubkey(null);
    setDms((current) => ({
      ...current,
      [vendorPubkey]: [...(current[vendorPubkey] || []), optimisticMessage],
    }));
    await saveMessage(vendorPubkey, optimisticMessage);

    const result = await sendDM(vendorPubkey, payload, tempId);
    if (!result.success) {
      setDms((current) => ({
        ...current,
        [vendorPubkey]: (current[vendorPubkey] || []).filter((message) => message.clientId !== tempId),
      }));
      await db.messages.delete(tempId);
      setToast({ type: 'error', message: result.error || 'The order request could not be sent.' });
      return;
    }

    let confirmedMessage = {
      ...optimisticMessage,
      id: result.event.id,
      timestamp: result.event.created_at,
      deliveryStatus: result.queued ? 'queued' : 'sent',
    };
    await saveMessage(vendorPubkey, confirmedMessage);
    if (result.queued && !(await db.outbox.get(result.event.id))) {
      confirmedMessage = { ...confirmedMessage, deliveryStatus: 'sent' };
      await saveMessage(vendorPubkey, confirmedMessage);
    }
    setDms((current) => ({
      ...current,
      [vendorPubkey]: (current[vendorPubkey] || []).map((message) => (
        message.clientId === tempId ? confirmedMessage : message
      )),
    }));
    setToast({
      type: 'success',
      message: result.queued ? 'Order saved and will send when connected.' : 'Order request sent to seller.',
    });
  };
  const handleSaveEditedProduct = async (updatedProduct) => {
    if (!editingProduct) return;
    try {
      const { msg } = editingProduct;
      const payload = {
        type: 'product', title: updatedProduct.title, priceUsd: updatedProduct.priceUsd,
        image: updatedProduct.image, description: updatedProduct.description, updatedFrom: msg.id,
      };
      if (msg.isGroup && activeGroup) await sendGroupMessage(activeGroup.id, payload);
      else if (activeDm) await sendDM(activeDm, payload);
      setToast({ type: 'success', message: 'Product updated!' });
      setEditingProduct(null);
    } catch (e) {
      setToast({ type: 'error', message: 'Failed to update product' });
    }
  };
  const handlePostListing = async (listingData) => {
    const state = useChatStore.getState();
    if (!state.postListingGroup) return;
    const payload = {
      type: 'product', title: listingData.title, priceUsd: listingData.priceUsd,
      image: listingData.image, description: listingData.description,
      dropUntil: listingData.dropUntil || null, stock: listingData.stock || null,
    };
    const res = await sendGroupMessage(state.postListingGroup.id, payload);
    if (res.success) setToast({ type: 'success', message: 'Listing posted to group!' });
    else setToast({ type: 'error', message: 'Failed to post listing' });
  };

  const handleBroadcastSubmit = async (groupIds, product) => {
    const payload = {
      type: 'product',
      title: product.title || product.name,
      priceUsd: product.priceUsd || product.price,
      currency: product.currency,
      image: product.image,
      description: product.description,
    };
    const results = await Promise.allSettled([...new Set(groupIds)].map((groupId) => sendGroupMessage(groupId, payload)));
    const delivered = results.filter((result) => result.status === 'fulfilled' && result.value?.success && !result.value.queued).length;
    const queued = results.filter((result) => result.status === 'fulfilled' && result.value?.success && result.value.queued).length;
    const failed = results.length - delivered - queued;
    results.forEach((result, index) => {
      if (result.status === 'rejected') console.error(`[broadcast] Failed to post to ${groupIds[index]}:`, result.reason);
      else if (!result.value?.success) console.error(`[broadcast] Failed to post to ${groupIds[index]}:`, result.value?.error);
    });
    setToast({
      type: failed ? 'error' : 'success',
      message: `Posted to ${delivered}; queued ${queued}; failed ${failed}.`,
    });
    setBroadcastProduct(null);
  };
  return {
    handleOrderAction,
    startOrderWithVendor,
    handleSaveEditedProduct,
    handlePostListing,
    handleBroadcastSubmit,
  };
}
