'use strict';

(() => {
  const relays = new Map();

  function close(frame) {
    const relay = relays.get(frame);
    if (!relay) return;
    relays.delete(frame);
    relay.channel.close();
    relay.port.close();
  }

  function attach(frame, event) {
    const url = new URL(frame.dataset.url);
    const port = event.ports?.[0];
    if (event.source !== frame.contentWindow || event.origin !== url.origin || !port) return;
    const parts = url.pathname.split('/');
    if (parts[1] !== 'view' || parts.length !== 5) return;
    close(frame);
    const channel = window.mygo.channel();
    const relay = { port, channel };
    relays.set(frame, relay);
    const current = () => relays.get(frame) === relay;
    const report = error => {
      if (!current()) return;
      port.postMessage({ error: String(error) });
      console.error('Claude native view bridge:', error);
    };
    const fail = error => {
      if (!current()) return;
      report(error);
      close(frame);
    };
    channel.onmessage = message => { if (current()) port.postMessage({ message }); };
    let outgoing = Promise.resolve();
    port.onmessage = event => {
      if (!current()) return;
      const { endpoint, value } = event.data ?? {};
      if (endpoint === 'close') { close(frame); return; }
      if (!['message', 'state', 'external'].includes(endpoint)) return;
      // MyGo calls run concurrently in Go; preserve the plugin's send order.
      outgoing = outgoing.then(() => {
        if (current()) return window.mygo.call('ViewBridge.Post', parts[2], parts[3], endpoint, value ?? null);
      }).catch(report);
    };
    port.start();
    window.mygo.call('ViewBridge.Stream', parts[2], parts[3], channel).then(() => {
      if (current()) fail('The conversation view was closed');
    }, fail);
  }

  window.goViewRelay = Object.freeze({ attach, close });
  window.addEventListener('pagehide', () => { for (const frame of relays.keys()) close(frame); });
})();
