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
  const signedInPanel = /** @type {HTMLElement} */ (document.querySelector('#accountSignedIn'));
  const deleteForm = /** @type {HTMLFormElement} */ (document.querySelector('#accountDeleteForm'));
  const deletePassword = /** @type {HTMLInputElement} */ (document.querySelector('#accountDeletePassword'));
  const deleteButton = /** @type {HTMLButtonElement} */ (document.querySelector('#accountDelete'));
  const deleteDetails = /** @type {HTMLDetailsElement} */ (document.querySelector('#accountDeleteDetails'));
  let revision = 0;
  let signedIn = false;
  let busy = false;
  const update = async (/** @type {{username?: string | null, revision?: number}} */ value) => {
    const wasSignedIn = signedIn;
    signedIn = !!value.username;
    revision = value.revision || 0;
    save.disabled = load.disabled = logout.disabled = deleteButton.disabled = !signedIn;
    status.textContent = signedIn ? `Signed in as ${value.username}. Save your settings here, then load them on your other devices.` : '';
    form.hidden = signedIn;
    signedInPanel.hidden = !signedIn;
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
    /** @type {HTMLDialogElement} */ (document.querySelector('#settingsDialog')).close();
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
    status.textContent = 'Preferences saved. Use Load settings on your other devices.';
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
  deleteForm.addEventListener('submit', event => {
    event.preventDefault();
    run(async () => {
      deleteButton.disabled = true;
      try {
        await request('delete', { password: deletePassword.value }, 'DELETE');
        callbacks.onSignOut();
      } finally { deletePassword.value = ''; deleteButton.disabled = !signedIn; }
    });
  });
  dialog.addEventListener('close', () => {
    password.value = ''; deletePassword.value = ''; deleteDetails.open = false;
    /** @type {HTMLButtonElement} */ (document.querySelector('#settingsBtn')).focus();
  });
  update({ username: null });
  return { refresh: () => run(async () => update(await request('session'))) };
}

/** @param {string} deviceId */
export async function accountSocketTicket(deviceId) {
  return request('connect', { deviceId });
}
