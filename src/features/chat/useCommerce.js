import { useChatStore } from '../../store/chatStore';
import { db, patchMessage, saveMessage } from '../../db';
import { scopedGet, scopedSet } from '../../lib/storage';
import { getOrderPaymentMethods, readPaymentAddresses } from '../../lib/vendorPayments';
import { nextPaymentState, orderCoinAmount } from '../../lib/paymentState';
import { checkPayment } from '../../lib/paymentWatch';
import { activeUrl, entryById } from '../../lib/egress';
import { publicReceipt, rememberPublicView, signPublicView, signReceipt } from '../../lib/proofOfTrade';

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

  // The screen and the database both take the change. A history fetch rebuilds
  // the chat from the database, so a change kept only on screen is lost on reload.
  const updateLocalOrder = async (peerPubkey, orderId, updateData) => {
    useChatStore.getState().setDms(prev => {
      const msgs = prev[peerPubkey] || [];
      const updated = msgs.map(m => m.id === orderId
        ? { ...m, localPatch: { ...(m.localPatch || {}), ...updateData }, data: { ...m.data, ...updateData } }
        : m);
      return { ...prev, [peerPubkey]: updated };
    });
    return patchMessage(orderId, updateData);
  };
  const NOT_SAVED = 'It was not saved on this device and will be lost on reload.';

  const deliverOrderUpdate = async (peer, payload, localPatch, okText) => {
    let result;
    try {
      result = await sendDM(peer, payload);
    } catch (error) {
      console.error('[orders] Update threw:', error);
      setToast({ type: 'error', message: error?.message || 'The order update did not send.' });
      return false;
    }
    if (!result?.success) {
      console.error('[orders] Update was rejected:', result?.error);
      setToast({ type: 'error', message: result?.error || 'The order update did not send.' });
      return false;
    }
    const saved = await updateLocalOrder(peer, payload.orderId, localPatch);
    const sentText = result.queued ? `${okText} It will send when connected.` : okText;
    setToast(saved ? { type: 'success', message: sentText } : { type: 'error', message: `${sentText} ${NOT_SAVED}` });
    setSelectedMessage(null);
    return true;
  };
  const handleOrderAction = async (action, msg) => {
    if (!['accept_order', 'decline_order', 'cancel_order', 'confirm_payment', 'check_chain', 'mark_shipped', 'confirm_delivery', 'report_issue'].includes(action)) {
      return false;
    }
  
      if (action === 'accept_order') {
        const sendAcceptance = async (coinAmount, coinCurrency) => {
          const { btc: baseBtc, xmr: baseXmr } = readPaymentAddresses();
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
            return;
          }
          if (!paymentMethods.btc && !paymentMethods.xmr) {
            setToast({ type: 'error', message: 'Set payment addresses in Profile first' });
            setSelectedMessage(null);
            return;
          }
          const currency = paymentMethods.xmr ? 'xmr' : 'btc';
          if (currency !== coinCurrency) {
            setToast({ type: 'error', message: `This order is paid in ${currency.toUpperCase()}. Enter that amount in coins.` });
            setSelectedMessage(null);
            return;
          }
          const payload = {
            type: 'order_update', orderId: msg.id,
            productName: msg.data.product?.title || msg.data.productName,
            product: msg.data.product || null,
            status: 'accepted',
            paymentState: nextPaymentState('created', 'issue'),
            paymentMethods,
            coinAmount,
            coinCurrency,
          };
          const result = await sendDM(msg.pubkey, payload);
          if (!result.success) {
            setToast({ type: 'error', message: result.error || 'Could not send order acceptance.' });
            setSelectedMessage(null);
            return;
          }
          const saved = await updateLocalOrder(msg.pubkey, msg.id, {
            status: 'accepted',
            paymentState: payload.paymentState,
            paymentMethods: payload.paymentMethods,
            coinAmount,
            coinCurrency,
          });
          const acceptedText = result.queued ? 'Acceptance queued; it will send when connected.' : 'Order accepted';
          setToast(saved ? { type: 'success', message: acceptedText } : { type: 'error', message: `${acceptedText} ${NOT_SAVED}` });
          setSelectedMessage(null);
        };
        const preference = msg.data.paymentMethod || 'btc';
        const coinCurrency = preference === 'xmr' || preference === 'both' ? 'xmr' : 'btc';
        const known = orderCoinAmount(msg.data.product, coinCurrency);
        if (known) {
          await sendAcceptance(known, coinCurrency);
          return true;
        }
        useChatStore.getState().openDialog({
          title: `How many ${coinCurrency.toUpperCase()}`,
          hasInput: true,
          placeholder: coinCurrency === 'btc' ? '0.001' : '0.1',
          confirmText: 'Accept',
          onConfirm: async (value) => {
            const text = String(value || '').trim();
            if (!/^\d+(\.\d+)?$/.test(text) || Number(text) <= 0) {
              setToast({ type: 'error', message: 'Enter the amount in coins, not dollars.' });
              return;
            }
            await sendAcceptance(text, coinCurrency);
          },
        });
        setSelectedMessage(null);
        return true;
      }
      if (action === 'decline_order' || action === 'cancel_order') {
        const payload = { type: 'order_update', orderId: msg.id, productName: msg.data.product?.title, status: 'cancelled' };
        await deliverOrderUpdate(msg.pubkey, payload, { status: 'cancelled' }, 'Order cancelled');
        return true;
      }
      if (action === 'confirm_payment') {
        let paymentState;
        try {
          const current = msg.data?.paymentState || 'address_issued';
          paymentState = nextPaymentState(current, 'see');
        } catch (error) {
          setToast({ type: 'error', message: error.message });
          setSelectedMessage(null);
          return true;
        }
        const payload = {
          type: 'order_update',
          orderId: msg.id,
          productName: msg.data.product?.title || msg.data.productName,
          status: 'paid',
          paymentState,
          paymentSeenBy: 'vendor',
          shippingAddress: msg.data.shippingAddress,
        };
        await deliverOrderUpdate(
          msg.pubkey,
          payload,
          { status: 'paid', paymentState, paymentSeenBy: 'vendor', shippingAddress: msg.data.shippingAddress },
          'Marked seen in your wallet. The chain was not checked.',
        );
        return true;
      }
      if (action === 'check_chain') {
        const methods = msg.data?.paymentMethods || {};
        const currency = msg.data?.coinCurrency || (methods.xmr ? 'xmr' : (methods.btc ? 'btc' : ''));
        const address = currency ? methods[currency] : '';
        const amount = msg.data?.coinAmount;
        if (!amount) {
          setToast({ type: 'info', message: 'This order has no coin amount, so it cannot be checked.' });
          setSelectedMessage(null);
          return true;
        }
        try {
          const outcome = await checkPayment({
            watcherUrl: activeUrl(entryById('explorer')),
            address,
            currency,
            amount,
            state: msg.data?.paymentState || 'address_issued',
          });
          if (outcome.short) {
            setToast({ type: 'info', message: 'The payment is short of the order.' });
            setSelectedMessage(null);
            return true;
          }
          if (!outcome.moved) {
            setToast({ type: 'info', message: 'Your watcher has not seen this payment yet.' });
            setSelectedMessage(null);
            return true;
          }
          const confirmed = outcome.state === 'confirmed';
          if (confirmed) {
            if (!identity?.sk) throw new Error('Unlock the account before confirming. The receipt was not signed.');
            // The receipt names one transaction, so it signs the largest output,
            // not the sum that covered the order.
            const paid = outcome.report?.outputAmount ?? outcome.report?.amount;
            if (paid == null || paid === '') throw new Error('The watcher did not report an amount. The receipt was not signed.');
            const amount = typeof paid === 'number'
              ? paid.toFixed(12).replace(/0+$/, '').replace(/\.$/, '')
              : String(paid);
            const signed = signReceipt(identity.sk, {
              orderId: msg.id,
              buyer: msg.pubkey,
              vendor: identity.pk,
              currency,
              address,
              amount,
              txid: outcome.report.txid,
              at: Math.floor(Date.now() / 1000),
              outcome: 'confirmed',
            });
            scopedSet(`receipt_${msg.id}`, signed);
            const payload = {
              type: 'order_update',
              orderId: msg.id,
              productName: msg.data.product?.title || msg.data.productName,
              status: 'paid',
              paymentState: outcome.state,
              paymentSeenBy: 'watcher',
              receipt: signed,
              published: signPublicView(identity.sk, publicReceipt(signed)),
            };
            rememberPublicView(payload.published);
            await deliverOrderUpdate(
              msg.pubkey,
              payload,
              { status: payload.status, paymentState: outcome.state, paymentSeenBy: 'watcher', receipt: signed },
              'Your watcher confirmed the payment.',
            );
          } else {
            const payload = {
              type: 'order_update',
              orderId: msg.id,
              productName: msg.data.product?.title || msg.data.productName,
              status: msg.data.status || 'accepted',
              paymentState: outcome.state,
              paymentSeenBy: 'watcher',
            };
            await deliverOrderUpdate(
              msg.pubkey,
              payload,
              { status: payload.status, paymentState: outcome.state, paymentSeenBy: 'watcher' },
              'Your watcher has seen the payment. It is not confirmed yet.',
            );
          }
        } catch (error) {
          console.error('[orders] Chain check failed:', error);
          setToast({ type: 'error', message: error?.message || 'The payment watcher could not be checked.' });
          setSelectedMessage(null);
        }
        return true;
      }
      if (action === 'mark_shipped') {
        const tracking = msg.data?.tracking || '';
        const payload = { type: 'order_update', orderId: msg.id, productName: msg.data.product?.title || msg.data.productName, status: 'shipped', tracking };
        await deliverOrderUpdate(msg.pubkey, payload, { status: 'shipped', tracking }, tracking ? 'Shipped' : 'Marked shipped');
        return true;
      }
      if (action === 'confirm_delivery') {
        const payload = { type: 'order_update', orderId: msg.id, productName: msg.data.product?.title || msg.data.productName, status: 'completed' };
        const sent = await deliverOrderUpdate(msg.pubkey, payload, { status: 'completed' }, 'Delivered');
        if (sent && scopedGet('auto_vouch_on_delivery', true)) {
          const vouchResult = await sendVouch(msg.pubkey);
          if (!vouchResult?.success) {
            console.error('[orders] Automatic delivery vouch failed:', vouchResult?.error);
            setToast({ type: 'error', message: vouchResult?.error || 'The delivery was sent. The vouch was not.' });
          }
        }
        return true;
      }
      if (action === 'report_issue') {
        useChatStore.getState().openDialog({
          title: 'Report an Issue', hasInput: true, placeholder: 'e.g. Not shipped, wrong item, damaged',
          type: 'danger', confirmText: 'Submit',
          onConfirm: async (reason) => {
            if (!reason || !reason.trim()) return;
            let saved = scopedGet(`receipt_${msg.id}`, null);
            if (saved?.body && identity?.sk) {
              try {
                saved = signReceipt(identity.sk, saved.body, saved);
                scopedSet(`receipt_${msg.id}`, saved);
              } catch (error) {
                console.error('[orders] Receipt was not co-signed:', error);
              }
            }
            const payload = {
              type: 'order_update',
              orderId: msg.id,
              productName: msg.data.product?.title,
              status: 'disputed',
              disputeReason: reason.trim(),
              ...(saved ? { receipt: saved } : {}),
            };
            await deliverOrderUpdate(msg.pubkey, payload, { status: 'disputed', disputeReason: reason.trim() }, 'Issue reported');
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
    const payload = { type: 'order_request', status: 'pending', paymentState: 'created', paymentMethod, product: orderProduct };
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
      if (msg.isGroup && activeGroup) {
        const sent = await sendGroupMessage(activeGroup.id, payload);
        if (sent?.error === 'NO_KEY') {
          setToast({ type: 'success', message: 'Securing… the edit will send when the group key arrives.' });
          setEditingProduct(null);
          return;
        }
        if (sent && sent.success === false) throw new Error(sent.error || 'send failed');
      } else if (activeDm) {
        const sent = await sendDM(activeDm, payload);
        if (!sent?.success) throw new Error(sent?.error || 'The product edit did not send.');
      }
      setToast({ type: 'success', message: 'Product updated!' });
      setEditingProduct(null);
    } catch (error) {
      console.error('[orders] Product edit did not send:', error);
      setToast({ type: 'error', message: error?.message || 'Failed to update product' });
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
    if (res?.error === 'NO_KEY') setToast({ type: 'success', message: 'Securing… the listing will send when the group key arrives.' });
    else if (res.success) setToast({ type: 'success', message: 'Listing posted to group!' });
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
    const securing = results.filter((result) => result.status === 'fulfilled' && result.value?.error === 'NO_KEY').length;
    const failed = results.length - delivered - queued - securing;
    results.forEach((result, index) => {
      if (result.status === 'rejected') console.error(`[broadcast] Failed to post to ${groupIds[index]}:`, result.reason);
      else if (!result.value?.success && result.value?.error !== 'NO_KEY') console.error(`[broadcast] Failed to post to ${groupIds[index]}:`, result.value?.error);
    });
    setToast({
      type: failed ? 'error' : 'success',
      message: `Posted to ${delivered}; queued ${queued}; securing ${securing}; failed ${failed}.`,
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
