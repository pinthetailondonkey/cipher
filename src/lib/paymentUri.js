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
