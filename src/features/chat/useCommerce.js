import { useChatStore } from '../../store/chatStore';
import { db, patchMessage, saveMessage } from '../../db';
import { scopedGet, scopedSet } from '../../lib/storage';
import { addressSpokenFor, getOrderPaymentMethods, markConsumed, readConsumedLedger, readPaymentAddresses, txidSpokenFor } from '../../lib/vendorPayments';
import { getAuthenticatedPool } from '../../lib/pool';
import { generalRelays } from '../../lib/relays';
import { ORDER_STATUS, RECEIPT_OUTCOME, acceptAmount, acceptanceDemand, amountCovers, nextPaymentState, orderCoinAmount } from '../../lib/paymentState';
import { checkPayment } from '../../lib/paymentWatch';
import { readCachedProducts } from '../../lib/listing';
import { activeUrl, entryById } from '../../lib/egress';
import { publicReceipt, rememberPublicView, receiptBindsOrder, signPublicView, signReceipt } from '../../lib/proofOfTrade';
import { frozenIssuedMethods, issuedPaymentMethods, newestOwnIssuedMethods, orderPaymentDetails, orderRecordForReceipt, orderState, reopenedStatus } from '../../lib/orderActions';
import { stampArrival } from './media';

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

  // The vendor's own published menus, cached on this device at publish time.
  // Wallet keeps them under a plain, account-wide key, so the order's listing
  // id is only ever matched against rows this account itself published —
  // another account's menu prices nothing on this device. (security F5)
  // One reader helper for the key: two JSON.parse sites were how the
  // duplicate-state mess started.
  const readOwnMenu = () => (
    readCachedProducts().filter((row) => row && row.vendorPubkey === identity.pk)
  );

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
    // The delivery door: open the buyer's sealed note, check the address
    // locally, save it into the order record, and only THEN burn the
    // transit copy (deadDrop's hold-open exists for exactly this order —
    // burning before the save would destroy the address on a save
    // failure). An unreadable or incomplete note saves nothing and stays
    // openable on this device; nothing here touches encryption of the
    // chat itself.
    if (action === 'open_delivery_note') {
      const noteUrl = msg.data?.delivery?.note;
      if (!noteUrl || msg.data?.delivery?.address) {
        setSelectedMessage(null);
        return true;
      }
      const fragment = String(noteUrl).split('#')[1] || '';
      if (!fragment) {
        setToast({ type: 'error', message: 'That note link is broken. Nothing was saved.' });
        setSelectedMessage(null);
        return true;
      }
      try {
        const pool = await getAuthenticatedPool(identity);
        const [{ openDeadDropNote }, { deliveryFromNoteText, addressFromForm }] = await Promise.all([
          import('../../lib/deadDrop'),
          import('../../lib/deliveryAddress'),
        ]);
        const opened = await openDeadDropNote({ identity, fragment, pool, relays: generalRelays, hold: true, author: msg.pubkey });
        const { form, misses } = deliveryFromNoteText(opened.text);
        if (misses.length) {
          setToast({ type: 'error', message: `${misses[0].message} Nothing was saved, and the note is still open.` });
          setSelectedMessage(null);
          return true;
        }
        const saved = await updateLocalOrder(msg.pubkey, msg.id, {
          delivery: { note: noteUrl, address: addressFromForm(form) },
        });
        if (!saved) {
          setToast({ type: 'error', message: 'The address did not save. The note is still open — try again.' });
          return true;
        }
        await opened.burn();
        setToast({ type: 'success', message: 'Address saved. The note will not open again on this device.' });
        setSelectedMessage(null);
        return true;
      } catch (error) {
        console.error('[orders] The delivery note would not open:', error);
        setToast({ type: 'error', message: error?.message || 'The note would not open. Nothing was saved.' });
        return true;
      }
    }
    if (!['accept_order', 'decline_order', 'cancel_order', 'confirm_payment', 'check_chain', 'mark_shipped', 'confirm_delivery', 'report_issue', 'mark_refunded', 'resume_order'].includes(action)) {
      return false;
    }
  
      if (action === 'accept_order') {
        // The order card is this vendor's own message, but its payload words
        // are the buyer's text. A card whose stated order ID differs from the
        // message it rides on could name a slot in the derivation record
        // belonging to another order and get that order's address served as
        // its own — the acceptance refuses rather than resolves the
        // disagreement. (security re-attack)
        if (msg.data.orderId && String(msg.data.orderId) !== String(msg.id)) {
          setToast({ type: 'error', message: 'This order card does not name its own order. Nothing was accepted.' });
          setSelectedMessage(null);
          return true;
        }
        // Once an address is issued for an order it is frozen on the order
        // card (security S5): acceptance reuses the pair this device issued —
        // the card's local patch, its own earlier write — and never derives a
        // fresh one, so a buyer who already paid the first issued address is
        // never strafed by a newer one. The pair on the fresh received card
        // never freezes: paymentMethods authored on an order request is the
        // buyer's word, and freezing it would let the acceptance adopt and
        // receipt-bind whatever address the buyer typed. (security S5)
        let frozen = frozenIssuedMethods(msg, readPaymentAddresses());
        if (!frozen) {
          // S5 re-attack (round three): this device may share the chat but
          // hold neither the card's patch nor the derivation slot — deriving
          // fresh here issued a second address while the buyer had already
          // paid the first. The freeze falls back to the newest own-sent
          // acceptance this device put in the chat, the same source the
          // chain check reads. No such update — derive fresh, as before.
          try {
            const history = await db.messages.where('chatId').equals(msg.pubkey).toArray();
            frozen = newestOwnIssuedMethods(history, readPaymentAddresses(), msg.id);
          } catch (error) {
            console.error('[orders] Could not read the order history for the frozen pair:', error);
          }
        }
        const sendAcceptance = async (rawAmount, coinCurrency) => {
          // An acceptance only locks in an amount the chain can express. A
          // string finer than the coin counts would sit 'short of the order'
          // forever, and rail the vendor onto their own wallet. (security S7)
          let coinAmount;
          try {
            coinAmount = acceptAmount(rawAmount, coinCurrency);
          } catch (error) {
            console.error('[orders] Acceptance amount rejected:', error);
            setToast({ type: 'error', message: error?.message || 'The amount could not be read as coins.' });
            setSelectedMessage(null);
            return;
          }
          let paymentMethods = frozen;
          if (!paymentMethods) {
            const { btc: baseBtc, xmr: baseXmr } = readPaymentAddresses();
            try {
              paymentMethods = await getOrderPaymentMethods(
                identity,
                // The derivation slot is the order card's message ID — this
                // device's own write — never a buyer-authored payload field.
                // (security re-attack)
                msg.id,
                { btc: baseBtc, xmr: baseXmr },
                msg.data.paymentMethod || 'btc',
              );
            } catch (error) {
              console.error('[orders] Could not prepare private payment addresses:', error);
              setToast({ type: 'error', message: error?.message || 'Could not create order payment addresses.' });
              setSelectedMessage(null);
              return;
            }
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
          // When this order's address was issued. The chain check holds every
          // transfer to it: one recorded earlier cannot pay this order, and
          // the mark is written to the order record so it survives a reload.
          // (security S1)
          const issuedAt = Math.floor(Date.now() / 1000);
          const payload = {
            type: 'order_update', orderId: msg.id,
            productName: msg.data.product?.title || msg.data.productName,
            product: msg.data.product || null,
            status: ORDER_STATUS.ACCEPTED,
            paymentState: nextPaymentState('created', 'issue'),
            paymentMethods,
            coinAmount,
            coinCurrency,
            // When this order's address was issued. It rides on the
            // acceptance so every side — the buyer's chain check, a vendor
            // on a second device — can refuse a transfer the chain dates
            // before the address existed, on any device. (security S1)
            issuedAt,
          };
          const result = await sendDM(msg.pubkey, payload);
          if (!result.success) {
            setToast({ type: 'error', message: result.error || 'Could not send order acceptance.' });
            setSelectedMessage(null);
            return;
          }
          const saved = await updateLocalOrder(msg.pubkey, msg.id, {
            status: ORDER_STATUS.ACCEPTED,
            paymentState: payload.paymentState,
            paymentMethods: payload.paymentMethods,
            coinAmount,
            coinCurrency,
            issuedAt,
          });
          const acceptedText = result.queued ? 'Acceptance queued; it will send when connected.' : 'Order accepted';
          setToast(saved ? { type: 'success', message: acceptedText } : { type: 'error', message: `${acceptedText} ${NOT_SAVED}` });
          setSelectedMessage(null);
        };
        const preference = msg.data.paymentMethod || 'btc';
        const coinCurrency = preference === 'xmr' || preference === 'both' ? 'xmr' : 'btc';
        // A demanded amount starts from the menu this device published, never
        // from what the buyer wrote into the order. (security F5)
        const demand = acceptanceDemand(msg.data.product, readOwnMenu(), coinCurrency);
        if (demand.kind === 'dollars') {
          setToast({ type: 'error', message: 'This order is priced in dollars. Price the menu in coins for chain-checked orders; a coin amount demanded here would not be tied to anything.' });
          setSelectedMessage(null);
          return true;
        }
        if (demand.kind === 'unit') {
          setToast({ type: 'error', message: `Your menu prices this item in ${demand.currency.toUpperCase()}. Accept it in ${demand.currency.toUpperCase()}, or price the menu in ${coinCurrency.toUpperCase()}.` });
          setSelectedMessage(null);
          return true;
        }
        if (demand.kind === 'listing') {
          const wrote = orderCoinAmount(msg.data.product, coinCurrency);
          if (wrote && amountCovers(wrote, demand.amount, demand.currency)) {
            await sendAcceptance(wrote, demand.currency);
            return true;
          }
          useChatStore.getState().openDialog({
            title: `Accept for ${demand.amount} ${demand.currency.toUpperCase()}`,
            message: `This item is on your menu for ${demand.amount} ${demand.currency.toUpperCase()}. The amount stays at the menu price so the payment can be checked on chain.`,
            hasInput: true,
            inputDefault: demand.amount,
            inputLocked: true,
            confirmText: 'Accept',
            onConfirm: () => sendAcceptance(demand.amount, demand.currency),
          });
          setSelectedMessage(null);
          return true;
        }
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
        const payload = { type: 'order_update', orderId: msg.id, productName: msg.data.product?.title, status: ORDER_STATUS.CANCELLED };
        await deliverOrderUpdate(msg.pubkey, payload, { status: ORDER_STATUS.CANCELLED }, 'Order cancelled');
        return true;
      }
      if (action === 'confirm_payment') {
        let paymentState;
        try {
          // F7: the current payment state comes from the order's evidence,
          // not from whatever a received card once wrote into itself.
          const history = await db.messages.where('chatId').equals(msg.pubkey).toArray();
          // N2: the chat peer is named explicitly — a sent subject card
          // defaults to this device's own key, which never matches a receipt.
          const current = orderState(history, msg.id, msg, identity.pk, msg.pubkey).paymentState;
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
          status: ORDER_STATUS.PAID,
          paymentState,
          paymentSeenBy: 'vendor',
          shippingAddress: msg.data.shippingAddress,
        };
        await deliverOrderUpdate(
          msg.pubkey,
          payload,
          { status: ORDER_STATUS.PAID, paymentState, paymentSeenBy: 'vendor', shippingAddress: msg.data.shippingAddress },
          'Marked seen in your wallet. The chain was not checked.',
        );
        return true;
      }
      if (action === 'check_chain') {
        const isBuyer = !!msg.isSender;
        let details = null;
        let chainedState;
        let vendorPair = null;
        try {
          const history = await db.messages.where('chatId').equals(msg.pubkey).toArray();
          // Either side runs this (security S6): a buyer is party to the
          // receiving address by definition — they paid it. The buyer's own
          // card never carried an address (the buyer wrote the request), so
          // their check reads the acceptance the vendor sent, off the stored
          // messages, the way F7 reads the state.
          details = isBuyer ? orderPaymentDetails(history, msg.id, identity.pk, msg.pubkey) : null;
          // The pair a vendor checks is the one it issued: the card's local
          // patch — its own write when it accepted — or its own acceptance
          // update in history. The received card is the buyer's word: a
          // paymentMethods, coin amount or currency typed on an order request
          // never reaches a chain check, so a buyer cannot aim this vendor's
          // confirmation and receipt at an address the vendor never issued.
          // (security S5)
          if (!isBuyer) {
            const own = issuedPaymentMethods(msg.localPatch)
              ? msg.localPatch
              : ([...history].reverse().find((m) => m?.isSender
                && m?.data?.type === 'order_update' && m.data.orderId === msg.id
                && issuedPaymentMethods(m.data))?.data || null);
            if (own) {
              vendorPair = {
                paymentMethods: issuedPaymentMethods(own),
                coinCurrency: String(own.coinCurrency || ''),
                coinAmount: own.coinAmount,
                issuedAt: own.issuedAt,
              };
            }
          }
          // F7: chain the watcher report off the order's real evidence, away
          // from a claim a peer wrote into the card.
          chainedState = orderState(history, msg.id, msg, identity.pk, msg.pubkey).paymentState;
        } catch {
          chainedState = 'address_issued';
        }
        const methods = details?.paymentMethods || vendorPair?.paymentMethods || {};
        const currency = details?.coinCurrency || vendorPair?.coinCurrency || (methods.xmr ? 'xmr' : (methods.btc ? 'btc' : ''));
        const address = currency ? methods[currency] : '';
        const amount = details?.coinAmount ?? vendorPair?.coinAmount;
        if (!amount) {
          setToast({ type: 'info', message: 'This order has no coin amount, so it cannot be checked.' });
          setSelectedMessage(null);
          return true;
        }
        // An order issued the account's shared address can never be separated
        // on chain: one transfer could pay many such orders. Orders from
        // before per-order derivation was required may carry one, so the
        // check refuses rather than guessing which payment it was. (security S1)
        if (!isBuyer) {
          // Bech32 is case-insensitive: the same address can arrive uppercase.
          // An exact compare would let a mixed-case twin of the shared
          // address pass as a fresh per-order one. (security S1)
          const shared = String(readPaymentAddresses()[currency] || '').trim().toLowerCase();
          if (shared && String(address || '').trim().toLowerCase() === shared) {
            setToast({ type: 'error', message: 'This order was issued the shared account address, so one transfer could pay many orders. Turn on address derivation in Profile, then accept the order again to give it its own address.' });
            setSelectedMessage(null);
            return true;
          }
          // A legacy order carries no issuance date, so the transfer-date
          // gate below has nothing to hold the watcher report to. Such an
          // order may also sit on a shared address the profile has since
          // rotated, which the compare above no longer names. An undated
          // order cannot be told apart from money that arrived for something
          // else, so it confirms nothing: accept the order again to date and
          // re-address it. (security re-attack)
          const issuedAtSec = Number(details?.issuedAt ?? vendorPair?.issuedAt);
          if (!Number.isFinite(issuedAtSec) || issuedAtSec <= 0) {
            setToast({ type: 'error', message: 'This order predates payment dating, so its chain check cannot tell its payment from older deposits. Accept the order again to give it a dated address of its own.' });
            setSelectedMessage(null);
            return true;
          }
        }
        try {
          const outcome = await checkPayment({
            watcherUrl: activeUrl(entryById('explorer')),
            address,
            currency,
            amount,
            state: chainedState,
            // When the order's address was issued: the acceptance carried
            // it, the vendor's own patch carries it on their devices. The
            // buyer's request card never dated the address and no longer
            // feeds the gate. (security S1)
            issuedAt: details?.issuedAt ?? vendorPair?.issuedAt,
          });
          if (outcome.short) {
            setToast({ type: 'info', message: 'The payment is short of the order.' });
            setSelectedMessage(null);
            return true;
          }
          if (outcome.stale) {
            setToast({ type: 'info', message: 'The transfer the watcher saw was recorded before this order\'s address was issued. It cannot pay this order.' });
            setSelectedMessage(null);
            return true;
          }
          if (!outcome.moved) {
            setToast({ type: 'info', message: 'Your watcher has not seen this payment yet.' });
            setSelectedMessage(null);
            return true;
          }
          const confirmed = outcome.state === 'confirmed';
          // The buyer signs no receipt — the vendor signs. Their own watcher
          // check lands on their order card, persisted, and goes no further:
          // an update a device sends about its own payment would rail the
          // other side's state on a claim, and that fix (F7) is separate.
          if (isBuyer) {
            const statePatch = { paymentState: outcome.state, paymentSeenBy: 'watcher' };
            const saved = await updateLocalOrder(msg.pubkey, msg.id, statePatch);
            const okText = confirmed ? 'Your watcher confirmed the payment.' : 'Your watcher has seen the payment. It is not confirmed yet.';
            setToast(saved ? { type: 'success', message: okText } : { type: 'error', message: `${okText} ${NOT_SAVED}` });
            setSelectedMessage(null);
            return true;
          }
          if (confirmed) {
            if (!identity?.sk) throw new Error('Unlock the account before confirming. The receipt was not signed.');
            // One transfer speaks for one order. A txid already on a receipt,
            // or an address already paid for another order, confirms nothing
            // here. The ledger lives in this account's storage, so it
            // survives a reload and a history fetch. (security S1)
            const read = readConsumedLedger();
            if (!read.ok) {
              throw new Error('The payment ledger on this device could not be read, so this device cannot prove what a transfer paid. Nothing was confirmed. Reinstall or clear this app\'s storage, then check the chain again.');
            }
            const ledger = read.ledger;
            const taken = txidSpokenFor(ledger, { currency, txid: outcome.report.txid, orderId: msg.id })
              || addressSpokenFor(ledger, { address, orderId: msg.id });
            if (taken) {
              throw new Error('That payment already confirmed another order. A transaction pays one order, and its receipt names it. Nothing was confirmed.');
            }
            // An order consumes only a transfer the chain dates at or after
            // its address was issued. An older transfer on the same address
            // was money that arrived for something else. The date is the one
            // this device wrote at issuance — the card, then the acceptance
            // — never a field the buyer could type. (security S1)
            const issuedAtSec = Number(details?.issuedAt ?? vendorPair?.issuedAt);
            if (Number.isFinite(issuedAtSec) && issuedAtSec > 0) {
              const transferTime = Number(outcome.report?.time);
              if (!Number.isFinite(transferTime) || transferTime < issuedAtSec) {
                throw new Error('The watcher could not date the transfer, or it was recorded before this order\'s address was issued. Nothing was confirmed. Update your watcher and check again.');
              }
            }
            // The receipt binds the covering sum the watcher reported — every
            // output owed to the payee in scope — not merely its largest
            // output. (security S1)
            const paid = outcome.report?.amount ?? outcome.report?.outputAmount;
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
              outcome: RECEIPT_OUTCOME.CONFIRMED,
            });
            scopedSet(`receipt_${msg.id}`, signed);
            // The envelope { v: 1, entries } lets a future build tell a
            // corrupt ledger from an empty one. (security S1)
            scopedSet('consumed_txids', { v: 1, entries: markConsumed(ledger, {
              currency,
              txid: outcome.report.txid,
              orderId: msg.id,
              address,
              at: Math.floor(Date.now() / 1000),
            }) });
            const payload = {
              type: 'order_update',
              orderId: msg.id,
              productName: msg.data.product?.title || msg.data.productName,
              status: ORDER_STATUS.PAID,
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
              status: msg.data.status || ORDER_STATUS.ACCEPTED,
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
        const payload = { type: 'order_update', orderId: msg.id, productName: msg.data.product?.title || msg.data.productName, status: ORDER_STATUS.SHIPPED, tracking };
        await deliverOrderUpdate(msg.pubkey, payload, { status: ORDER_STATUS.SHIPPED, tracking }, tracking ? 'Shipped' : 'Marked shipped');
        return true;
      }
      if (action === 'confirm_delivery') {
        const payload = { type: 'order_update', orderId: msg.id, productName: msg.data.product?.title || msg.data.productName, status: ORDER_STATUS.COMPLETED };
        const sent = await deliverOrderUpdate(msg.pubkey, payload, { status: ORDER_STATUS.COMPLETED }, 'Delivered');
        if (sent && scopedGet('auto_vouch_on_delivery', true)) {
          // S8: the auto-vouch carries the receipt hash of the trade it
          // confirms, and the trade's vendor and buyer under this signature.
          // No receipt on this device, no vouch — the delivery alone is
          // still sent either way.
          const stored = scopedGet(`receipt_${msg.id}`, null);
          const trade = stored?.body ? {
            vendor: String(stored.body.vendor || '').toLowerCase(),
            buyer: String(stored.body.buyer || '').toLowerCase(),
          } : null;
          const vouchResult = await sendVouch(msg.pubkey, stored?.hash || '', trade);
          if (!vouchResult?.success) {
            console.error('[orders] Automatic delivery vouch failed:', vouchResult?.error);
            setToast({ type: 'error', message: vouchResult?.error || 'The delivery was sent. The vouch was not.' });
          }
        }
        return true;
      }
      if (action === 'mark_refunded' || action === 'resume_order') {
        // A dispute keeps its exit on the chain (security S6): a refund marks
        // the order refunded and stays there, and reopening restores the
        // status the payment had already reached. Both sides see the same
        // update, so neither card is left on a dead end. The payment state
        // itself never moves here — a refund is a transaction a watcher
        // reports for itself, not a step this table takes.
        const refunding = action === 'mark_refunded';
        let reopenedFrom = '';
        if (!refunding) {
          // What the reopening returns to is the payment state this device
          // earned, read the way every other gate reads it. The card's own
          // field on a received request is the buyer's word: a claimed
          // 'confirmed' would reopen an order the vendor never saw paid.
          // (security S6)
          try {
            const history = await db.messages.where('chatId').equals(msg.pubkey).toArray();
            reopenedFrom = orderState(history, msg.id, msg, identity.pk, msg.pubkey).paymentState;
          } catch {
            reopenedFrom = '';
          }
        }
        const status = refunding ? ORDER_STATUS.REFUNDED : reopenedStatus(reopenedFrom);
        const payload = {
          type: 'order_update',
          orderId: msg.id,
          productName: msg.data.product?.title || msg.data.productName,
          status,
        };
        await deliverOrderUpdate(msg.pubkey, payload, { status }, refunding ? 'Order refunded' : 'Order reopened');
        return true;
      }
      if (action === 'report_issue') {
        useChatStore.getState().openDialog({
          title: 'Report an Issue', hasInput: true, placeholder: 'e.g. Not shipped, wrong item, damaged',
          type: 'danger', confirmText: 'Submit',
          onConfirm: async (reason) => {
            if (!reason || !reason.trim()) return;
            // Audit F4/S10: this device re-signs a stored receipt only when
            // it countersigned it after the receipt passed the order binding
            // on arrival, and the receipt still binds the live order record.
            // A receipt planted by a fabricated update never qualifies, so
            // the dispute sends without a signature rather than signing it.
            let receipt = null;
            const stored = scopedGet(`receipt_${msg.id}`, null);
            if (stored?.body && identity?.sk) {
              let binds = false;
              try {
                const messages = await db.messages.where('chatId').equals(msg.pubkey).toArray();
                const record = orderRecordForReceipt(messages, msg.id, identity.pk);
                binds = !!record
                  && scopedGet(`bound_receipt_${msg.id}`, '') === stored.hash
                  && receiptBindsOrder({
                    receipt: stored,
                    orderId: msg.id,
                    orderCoinAmount: record.coinAmount,
                    issuedAddress: record.issuedAddress,
                    orderCurrency: record.coinCurrency,
                    buyerPubkey: record.isBuyer ? identity.pk : msg.pubkey,
                    vendorPubkey: record.isBuyer ? msg.pubkey : identity.pk,
                  });
              } catch (error) {
                console.warn('[orders] The stored receipt could not be re-checked:', error);
              }
              if (binds) {
                try {
                  receipt = signReceipt(identity.sk, stored.body, stored);
                  scopedSet(`receipt_${msg.id}`, receipt);
                } catch (error) {
                  console.error('[orders] Receipt was not co-signed:', error);
                  receipt = stored;
                }
              } else {
                console.warn('[orders] The stored receipt does not bind this order, so the dispute sends without it.');
              }
            }
            const payload = {
              type: 'order_update',
              orderId: msg.id,
              productName: msg.data.product?.title || msg.data.productName,
              status: ORDER_STATUS.DISPUTED,
              disputeReason: reason.trim(),
              ...(receipt ? { receipt } : {}),
            };
            await deliverOrderUpdate(msg.pubkey, payload, { status: ORDER_STATUS.DISPUTED, disputeReason: reason.trim() }, 'Issue reported');
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
    const payload = { type: 'order_request', status: ORDER_STATUS.PENDING, paymentState: 'created', paymentMethod, product: orderProduct };
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const optimisticMessage = stampArrival({
      id: tempId,
      clientId: tempId,
      isSender: true,
      isGroup: false,
      pubkey: identity.pk,
      timestamp: Math.floor(Date.now() / 1000),
      local_timestamp: Date.now(),
      deliveryStatus: 'sending',
      data: payload,
    });

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
    handleBroadcastSubmit,
  };
}
