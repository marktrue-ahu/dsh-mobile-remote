// Host credentials are scoped to the explicit loopback origin and update routes, not to arbitrary release URLs.
export async function fetchUpdateResource(url, {
  fetchImpl = fetch, token = '', trustedOrigin = '', headers = {}, signal, maxRedirects = 5,
} = {}) {
  let target = new URL(url);
  for (let hops = 0; hops <= maxRedirects; hops++) {
    if (target.username || target.password || !(['https:'].includes(target.protocol) ||
      (target.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(target.hostname)))) throw new Error('update-url-not-allowed');
    const authAllowed = token && trustedOrigin && target.origin === trustedOrigin &&
      /\/api\/update\/(manifest|plugin|apk)$/.test(target.pathname);
    const response = await fetchImpl(target.toString(), {
      headers: { ...headers, ...(authAllowed ? { 'x-mobile-token': token } : {}) }, redirect: 'manual', signal,
    });
    if (![301,302,303,307,308].includes(response.status)) return { response, finalUrl: target.toString() };
    const location = response.headers.get('location');
    if (!location) throw new Error('update-redirect-missing');
    await response.body?.cancel?.();
    target = new URL(location, target);
  }
  throw new Error('update-redirect-limit');
}
