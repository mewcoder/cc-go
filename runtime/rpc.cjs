const { EventEmitter } = require('node:events');

function createPeer(send) {
  let sequence = 0;
  const pending = new Map();
  const handlers = new Map();
  const events = new EventEmitter();
  return {
    events,
    handle(method, handler) { handlers.set(method, handler); },
    call(method, args) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try { send({ kind: 'call', id, method, args }); }
        catch (error) { pending.delete(id); reject(error); }
      });
    },
    notify(method, args) { send({ kind: 'event', method, args }); },
    async receive(message) {
      if (message.kind === 'result') {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.error) request.reject(Object.assign(new Error(message.error.message), { stack: message.error.stack }));
        else request.resolve(message.value);
      } else if (message.kind === 'event') {
        events.emit(message.method, message.args);
      } else if (message.kind === 'call') {
        try {
          const handler = handlers.get(message.method);
          if (!handler) throw new Error(`Unsupported host RPC: ${message.method}`);
          send({ kind: 'result', id: message.id, value: await handler(message.args) });
        } catch (error) {
          send({ kind: 'result', id: message.id, error: { message: error.message, stack: error.stack } });
        }
      }
    },
    dispose() {
      for (const request of pending.values()) request.reject(new Error('Extension host disconnected'));
      pending.clear();
      events.removeAllListeners();
    },
  };
}

module.exports = { createPeer };
