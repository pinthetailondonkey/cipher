export function paymentUri(currency, address, price, priceCurrency) {
  if (!address) return '';
  const currencyMatches = String(priceCurrency || '').toUpperCase() === currency;
  const amount = currencyMatches && /^\d+(?:\.\d+)?$/.test(String(price).trim())
    ? String(price).trim()
    : '';
  if (currency === 'BTC') {
    const valid = amount && Number(amount) > 0 && (!amount.includes('.') || amount.split('.')[1].length <= 8);
    return `bitcoin:${address}${valid ? `?amount=${amount}` : ''}`;
  }
  if (currency === 'XMR') {
    const valid = amount && Number(amount) > 0 && (!amount.includes('.') || amount.split('.')[1].length <= 12);
    return `monero:${address}${valid ? `?tx_amount=${amount}` : ''}`;
  }
  return address;
}

// What a buyer needs to pay without asking: the coin, the amount in that coin,
// the address, and a URI that carries both. When the vendor named a coin
// amount, only that coin is offered, because the chain check looks only there.
export function paymentRowsFor(content) {
  if (content?.type !== 'order_update' || content.status !== 'accepted') return [];
  const methods = content.paymentMethods || {};
  const coin = String(content.coinCurrency || '').toUpperCase();
  const offered = [['BTC', methods.btc], ['XMR', methods.xmr]].filter(([, address]) => address);
  const rows = offered.some(([currency]) => currency === coin)
    ? offered.filter(([currency]) => currency === coin)
    : offered;
  return rows.map(([currency, address]) => {
    const amount = currency === coin && content.coinAmount ? String(content.coinAmount).trim() : '';
    const uri = amount
      ? paymentUri(currency, address, amount, currency)
      : paymentUri(currency, address, content.product?.price, content.product?.currency);
    return { currency, address, amount, uri };
  });
}
