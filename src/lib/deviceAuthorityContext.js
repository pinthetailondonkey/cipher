// Standalone authority databases do not share the main account DB's durable
// transaction marker. Require the active incarnation capability and recheck
// it at async boundaries and inside each write request callback.
import { withSharedSecurityContext } from './securityContextCoordination.js';

export function assertDeviceAuthorityContext(securityFence) {
  if (!securityFence || typeof securityFence.assertCurrent !== 'function'
    || typeof securityFence.context?.owner !== 'string'
    || !/^[0-9a-f]{64}$/i.test(securityFence.context.owner)) {
    throw new Error('A current account security context is required for device authority storage.');
  }
  securityFence.assertCurrent();
}

export function withDeviceAuthorityContext(securityFence, operation) {
  return withSharedSecurityContext(securityFence, operation);
}
