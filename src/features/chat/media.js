import { writeClipboard } from '../../lib/copyText';

export const copyToClipboard = (text) => writeClipboard(text);

export const sortMessages = (a, b) => {
  const timeA = a.local_timestamp || (a.timestamp * 1000);
  const timeB = b.local_timestamp || (b.timestamp * 1000);
  if (timeA !== timeB) return timeA - timeB;
  return (a.id || '').localeCompare(b.id || '');
};
