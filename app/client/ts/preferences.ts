// Only preferences are synced. Identity keys, pairing/verification decisions,
// advertising consent, messages, and files remain local to this browser.
const KEYS = ['evakage-theme', 'evakage-incoming', 'evakage-verified-only', 'evakage-force-relay'];

async function request(route: string, body?: object | undefined, method: string = 'POST') {
  const response = await fetch(
    `/account/${route}`,
    body
      ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : { cache: 'no-store' },
  );
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Account request failed.');
  return value;
}

export function setupAccounts(callbacks: {
  onSession: (username: string) => Promise<void>;
  onSignOut: () => void;
}) {
  const dialog = document.querySelector('#accountDialog') as HTMLDialogElement;
  const form = document.querySelector('#accountForm') as HTMLFormElement;
  const username = document.querySelector('#accountUsername') as HTMLInputElement;
  const password = document.querySelector('#accountPassword') as HTMLInputElement;
  const status = document.querySelector('#accountStatus') as HTMLElement;
  const save = document.querySelector('#accountSave') as HTMLButtonElement;
  const load = document.querySelector('#accountLoad') as HTMLButtonElement;
  const logout = document.querySelector('#accountLogout') as HTMLButtonElement;
  const signedInPanel = document.querySelector('#accountSignedIn') as HTMLElement;
  const accountButton = document.querySelector('#accountBtn') as HTMLButtonElement;
  const deleteForm = document.querySelector('#accountDeleteForm') as HTMLFormElement;
  const deletePassword = document.querySelector('#accountDeletePassword') as HTMLInputElement;
  const deleteButton = document.querySelector('#accountDelete') as HTMLButtonElement;
  const deleteDetails = document.querySelector('#accountDeleteDetails') as HTMLDetailsElement;
  let revision = 0;
  let signedIn = false;
  let busy = false;
  const update = async (value: { username?: string | null; revision?: number }) => {
    const wasSignedIn = signedIn;
    signedIn = !!value.username;
    accountButton.setAttribute('aria-label', signedIn ? 'Account' : 'Login');
    accountButton.title = signedIn ? 'Account' : 'Login';
    revision = value.revision || 0;
    save.disabled = load.disabled = logout.disabled = deleteButton.disabled = busy || !signedIn;
    status.textContent = signedIn
      ? `Signed in as ${value.username}. Save your settings here, then load them on your other devices.`
      : '';
    form.hidden = signedIn;
    signedInPanel.hidden = !signedIn;
    if (value.username) await callbacks.onSession(value.username);
    else if (wasSignedIn) callbacks.onSignOut();
  };
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    const controls = [...dialog.querySelectorAll('input, button:not(.dialog-close)')];
    for (const control of controls) {
      if (control instanceof HTMLInputElement || control instanceof HTMLButtonElement)
        {control.disabled = true;}
    }
    try {
      await action();
    } catch (error) {
      status.textContent = error.message || 'Account unavailable.';
    } finally {
      password.value = '';
      for (const control of controls) {
        if (control instanceof HTMLInputElement || control instanceof HTMLButtonElement)
          {control.disabled = false;}
      }
      busy = false;
      save.disabled = load.disabled = logout.disabled = deleteButton.disabled = !signedIn;
    }
  };
  document.querySelector('#accountBtn')?.addEventListener('click', () => {
    (document.querySelector('#settingsDialog') as HTMLDialogElement).close();
    dialog.showModal();
    run(async () => update(await request('session')));
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const submitter = event.submitter as HTMLButtonElement | null;
    run(async () =>
      update(
        await request(submitter?.value === 'register' ? 'register' : 'login', {
          username: username.value,
          password: password.value,
        }),
      ),
    );
  });
  save.addEventListener('click', () =>
    run(async () => {
      const preferences = Object.fromEntries(
        KEYS.map((key) => [
          key,
          localStorage.getItem(key) ||
            (key === 'evakage-theme' ? 'system' : key === 'evakage-incoming' ? 'new' : '0'),
        ]),
      );
      const value = await request('preferences', { preferences, revision }, 'PUT');
      revision = value.revision;
      status.textContent = 'Preferences saved. Use Load settings on your other devices.';
    }),
  );
  load.addEventListener('click', () =>
    run(async () => {
      const value = await request('session');
      if (!value.username) {
        update(value);
        return;
      }
      for (const key of KEYS)
        {if (typeof value.preferences?.[key] === 'string')
          {localStorage.setItem(key, value.preferences[key]);}}
      location.reload();
    }),
  );
  logout.addEventListener('click', () =>
    run(async () => {
      await request('logout', {});
      callbacks.onSignOut();
    }),
  );
  deleteForm.addEventListener('submit', (event) => {
    event.preventDefault();
    run(async () => {
      deleteButton.disabled = true;
      try {
        await request('delete', { password: deletePassword.value }, 'DELETE');
        callbacks.onSignOut();
      } finally {
        deletePassword.value = '';
      }
    });
  });
  dialog.addEventListener('close', () => {
    password.value = '';
    deletePassword.value = '';
    deleteDetails.open = false;
    accountButton.focus();
  });
  update({ username: null });
  return { refresh: () => run(async () => update(await request('session'))) };
}

export async function accountSocketTicket(deviceId: string) {
  return request('connect', { deviceId });
}
