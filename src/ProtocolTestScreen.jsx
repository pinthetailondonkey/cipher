import React, { useEffect, useMemo, useState } from 'react';
import { PROTOCOL_TEST_BUILD, PROTOCOL_TEST_DM_ENABLED, PROTOCOL_TEST_MLS_ENABLED,
  PROTOCOL_TEST_RELAY_ALLOWLIST, deleteProtocolTestDatabase,
  listProtocolTestDatabases, parseProtocolTestRelayAllowlist, startProtocolTestMode } from './lib/protocolTestMode.js';

export default function ProtocolTestScreen() {
  const [controller, setController] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [testDatabases, setTestDatabases] = useState([]);
  const config = useMemo(() => {
    try { return { relays: parseProtocolTestRelayAllowlist(PROTOCOL_TEST_RELAY_ALLOWLIST), error: '' }; }
    catch (error) { return { relays: [], error: error.message }; }
  }, []);
  const refreshTestDatabases = async () => {
    try { setTestDatabases(await listProtocolTestDatabases()); }
    catch (error) { setMessage(error.message || 'Test run list is unavailable.'); }
  };
  useEffect(() => {
    let mounted = true;
    listProtocolTestDatabases().then((names) => {
      if (mounted) setTestDatabases(names);
    }).catch((error) => {
      if (mounted) setMessage(error.message || 'Test run list is unavailable.');
    });
    return () => { mounted = false; };
  }, []);
  const start = async () => {
    setBusy(true);
    setMessage('');
    try {
      const next = await startProtocolTestMode({ buildEnabled: PROTOCOL_TEST_BUILD,
        relayAllowlist: PROTOCOL_TEST_RELAY_ALLOWLIST });
      setController(next);
      await refreshTestDatabases();
    } catch (error) {
      setMessage(error.message || 'Test mode could not start.');
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    if (!controller) return;
    setBusy(true);
    try {
      await controller.stop();
      setMessage('Test mode is off. The run is held for review or explicit deletion.');
    } catch (error) {
      setMessage(error.message || 'Test mode could not be disabled cleanly.');
    } finally {
      setBusy(false);
    }
  };
  const forget = async () => {
    if (!controller) return;
    setBusy(true);
    try {
      await controller.forget();
      setController(null);
      await refreshTestDatabases();
      setMessage('This disposable test run was deleted.');
    } catch (error) {
      setMessage(error.message || 'Test data could not be deleted.');
    } finally {
      setBusy(false);
    }
  };
  const forgetOldRun = async (databaseName) => {
    setBusy(true);
    try {
      await deleteProtocolTestDatabase(databaseName);
      await refreshTestDatabases();
      setMessage('This disposable test run was deleted.');
    } catch (error) {
      setMessage(error.message || 'Test data could not be deleted.');
    } finally {
      setBusy(false);
    }
  };
  const active = Boolean(controller?.active);

  return (
    <main className="min-h-[100dvh] bg-base px-4 py-8 text-ink">
      <section className="mx-auto w-full max-w-xl rounded-2xl border border-line bg-panel p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-warning">Test build</p>
        <h1 className="mt-2 text-xl font-semibold">Experimental protocol tests</h1>
        <p className="mt-3 text-sm text-muted">
          This build is for disposable test identities only. It does not load a saved Cipher account, production messages, or production groups.
          Protocol tests are experimental and may have different history and recovery behavior.
        </p>
        <p className="mt-3 text-sm text-muted">Only configured local relay addresses can be used. This scaffold does not send messages yet.</p>

        <div className="mt-5 rounded-xl border border-line bg-panel-strong p-4" aria-live="polite">
          <h2 className="text-sm font-semibold">Protocol test paths</h2>
          <p className="mt-2 text-sm text-muted">
            Double Ratchet DM: {PROTOCOL_TEST_DM_ENABLED ? 'enabled' : 'disabled pending wire-profile review and isolated app integration.'}
          </p>
          <p className="mt-2 text-sm text-muted">
            MLS groups: {PROTOCOL_TEST_MLS_ENABLED ? 'enabled' : 'disabled pending governance review and isolated app integration.'}
          </p>
        </div>

        <div className="mt-5 rounded-xl border border-line bg-panel-strong p-4" aria-live="polite">
          <h2 className="text-sm font-semibold">Local relay allowlist</h2>
          {config.relays.length ? (
            <ul className="mt-2 space-y-1 break-all text-sm text-muted">
              {config.relays.map((relay) => <li key={relay}>{relay}</li>)}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-warning">Test mode is unavailable because its local relay allowlist is missing or invalid.</p>
          )}
          {config.error && <p className="mt-2 text-sm text-warning">{config.error}</p>}
        </div>

        {controller && (
          <div className="mt-5 rounded-xl border border-line bg-panel-strong p-4" aria-live="polite">
            <h2 className="text-sm font-semibold">Disposable test identity</h2>
            <p className="mt-2 break-all text-xs text-muted">Identity: {controller.identity.pubkey}</p>
            <p className="mt-2 break-all text-xs text-muted">Test device: {controller.device.pubkey}</p>
            <p className="mt-2 break-all text-xs text-muted">Isolated state: {controller.databaseName}</p>
            {active ? <p className="mt-3 text-sm text-warning">Test mode is on. Use the stop control before leaving this test run.</p>
              : <p className="mt-3 text-sm text-muted">Test mode is off. This run remains held in its isolated database.</p>}
          </div>
        )}

        {testDatabases.length > 0 && (
          <div className="mt-5 rounded-xl border border-line bg-panel-strong p-4">
            <h2 className="text-sm font-semibold">Saved test runs</h2>
            <ul className="mt-2 space-y-2">
              {testDatabases.map((databaseName) => (
                <li key={databaseName} className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                  <span className="break-all">{databaseName}</span>
                  <button type="button" onClick={() => forgetOldRun(databaseName)}
                    disabled={busy || (active && controller?.databaseName === databaseName)}
                    className="rounded-lg border border-line px-3 py-2 text-xs font-semibold disabled:opacity-50">
                    Delete held run
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {message && <p className="mt-4 text-sm text-muted" role="status">{message}</p>}

        <div className="mt-5 flex flex-wrap gap-3">
          {!controller ? (
            <button type="button" onClick={start} disabled={busy || !PROTOCOL_TEST_BUILD || !config.relays.length}
              className="rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-accent-ink disabled:opacity-50">
              {busy ? 'Starting' : 'Start test mode'}
            </button>
          ) : (
            <>
              <button type="button" onClick={stop} disabled={busy || !active}
                className="rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-accent-ink disabled:opacity-50">
                Disable test mode
              </button>
              <button type="button" onClick={forget} disabled={busy}
                className="rounded-xl border border-line px-4 py-3 text-sm font-semibold disabled:opacity-50">
                Delete this test run
              </button>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
