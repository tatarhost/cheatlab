/*
 * Compatibility bridge only.
 * Login and registration already run the ring CAPTCHA in app.js via
 * humanProof(). This file must never create or inject another challenge.
 * Keep the shared credentials bridge for older modules that read window.__cl.
 */
(() => {
  const meta = document.querySelector('meta[name="cheatlab-api"]');
  const API = ((meta && meta.content) || '').replace(/\/$/, '');
  const creds = (window.__cl = window.__cl || { session: '', client: '', api: API });
  creds.api = API;
  const realFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    init = init || {};
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const headers = new Headers(init.headers || (isRequest ? input.headers : undefined));
    const session = headers.get('x-cheatlab-session');
    const client = headers.get('x-cheatlab-client');
    if (session) creds.session = session;
    if (client) creds.client = client;
    return realFetch(input, init);
  };
})();
