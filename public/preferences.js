// Only preferences are synced. Identity keys, pairing/verification decisions,
// advertising consent, messages, and files remain local to this browser.
const KEYS = ['evakage-theme', 'evakage-incoming', 'evakage-verified-only', 'evakage-force-relay'];
/** @param {string} route @param {object | undefined} [body] @param {string} [method] */
async function request(route, body, method = 'POST') {
  const response = await fetch(`/account/${route}`, body ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Account request failed.');
  return value;
}
/** @param {{onSession: (username: string) => Promise<void>, onSignOut: () => void}} callbacks */
export function setupAccounts(callbacks) {
  const dialog = /** @type {HTMLDialogElement} */ (document.querySelector('#accountDialog'));
  const form = /** @type {HTMLFormElement} */ (document.querySelector('#accountForm'));
  const username = /** @type {HTMLInputElement} */ (document.querySelector('#accountUsername'));
  const password = /** @type {HTMLInputElement} */ (document.querySelector('#accountPassword'));
  const status = /** @type {HTMLElement} */ (document.querySelector('#accountStatus'));
  const save = /** @type {HTMLButtonElement} */ (document.querySelector('#accountSave'));
  const load = /** @type {HTMLButtonElement} */ (document.querySelector('#accountLoad'));
  const logout = /** @type {HTMLButtonElement} */ (document.querySelector('#accountLogout'));
  let revision = 0;
  let signedIn = false;
  let busy = false;
  const update = async (/** @type {{username?: string | null, revision?: number}} */ value) => {
    const wasSignedIn = signedIn;
    signedIn = !!value.username;
    revision = value.revision || 0;
    save.disabled = load.disabled = logout.disabled = !signedIn;
    status.textContent = signedIn ? `Signed in as ${value.username}. Your online account devices connect automatically. Save preferences here, then load them on another device.` : 'No account needed. Sign in to connect your devices and sync preferences.';
    form.hidden = signedIn;
    if (value.username) await callbacks.onSession(value.username);
    else if (wasSignedIn) callbacks.onSignOut();
  };
  const run = async (/** @type {() => Promise<void>} */ action) => {
    if (busy) return;
    busy = true;
    try { await action(); } catch (error) { status.textContent = error.message || 'Account unavailable.'; }
    finally { busy = false; password.value = ''; }
  };
  document.querySelector('#accountBtn')?.addEventListener('click', () => {
    dialog.showModal();
    run(async () => update(await request('session')));
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const submitter = /** @type {HTMLButtonElement | null} */ (event.submitter);
    run(async () => update(await request(submitter?.value === 'register' ? 'register' : 'login', { username: username.value, password: password.value })));
  });
  save.addEventListener('click', () => run(async () => {
    const preferences = Object.fromEntries(KEYS.map(key => [key, localStorage.getItem(key) || (key === 'evakage-theme' ? 'system' : key === 'evakage-incoming' ? 'new' : '0')]));
    const value = await request('preferences', { preferences, revision }, 'PUT');
    revision = value.revision;
    status.textContent = 'Preferences saved. Load them on your other signed-in browsers.';
  }));
  load.addEventListener('click', () => run(async () => {
    const value = await request('session');
    if (!value.username) { update(value); return; }
    for (const key of KEYS) if (typeof value.preferences?.[key] === 'string') localStorage.setItem(key, value.preferences[key]);
    location.reload();
  }));
  logout.addEventListener('click', () => run(async () => {
    await request('logout', {});
    callbacks.onSignOut();
  }));
  dialog.addEventListener('close', () => { password.value = ''; });
  update({ username: null });
  return { refresh: () => run(async () => update(await request('session'))) };
}

/** @param {string} deviceId */
export async function accountSocketTicket(deviceId) {
  return request('connect', { deviceId });
}
