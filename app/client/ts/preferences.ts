// Only preferences are synced. Identity keys, pairing/verification decisions,
// advertising consent, messages, and files remain local to this browser.
const KEYS = ['evakage-theme', 'evakage-incoming', 'evakage-verified-only', 'evakage-force-relay'];
const DEFAULTS: Record<string, string> = { 'evakage-theme': 'system', 'evakage-incoming': 'new' };

type AccountReply = {
  username?: string | null;
  revision?: number;
  preferences?: Record<string, unknown>;
};

async function request(route: string, body?: object | undefined, method: string = 'POST') {
  const response = await fetch(
    `/account/${route}`,
    body
      ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : { cache: 'no-store' },
  );
  const value = await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(value.error || 'Account request failed.'), {
      status: response.status,
      reply: value,
    });
  }
  return value;
}

function localPreferences() {
  return Object.fromEntries(
    KEYS.map((key) => {
      let value: string | null = null;
      try {
        value = localStorage.getItem(key);
      } catch {}
      return [key, value || DEFAULTS[key] || '0'];
    }),
  );
}

export function setupAccounts(callbacks: {
  onSession: (username: string) => Promise<void>;
  onSignOut: () => void;
  /** Synced preferences were written to localStorage; apply them in place. */
  onPreferences: () => void;
}) {
  const dialog = document.querySelector('#accountDialog') as HTMLDialogElement;
  const form = document.querySelector('#accountForm') as HTMLFormElement;
  const username = document.querySelector('#accountUsername') as HTMLInputElement;
  const password = document.querySelector('#accountPassword') as HTMLInputElement;
  const status = document.querySelector('#accountStatus') as HTMLElement;
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
  let saving: Promise<void> | null = null;
  let unsaved = false;

  // The most recently saved settings win everywhere: a change here is pushed
  // at once, and any newer revision from the account replaces local settings.
  const push = () => {
    if (!signedIn) return;
    unsaved = true;
    saving ||= (async () => {
      while (unsaved && signedIn) {
        unsaved = false;
        const preferences = localPreferences();
        try {
          revision = (await request('preferences', { preferences, revision }, 'PUT')).revision;
        } catch (error) {
          // Another device saved first. This change is newer, so save over it.
          if (error.status !== 409) throw error;
          revision = error.reply.revision;
          unsaved = true;
        }
      }
    })()
      .catch(() => {
        status.textContent = 'Settings could not be saved to your account.';
      })
      .finally(() => {
        saving = null;
      });
  };
  const adopt = (value: AccountReply) => {
    const latest = value.revision || 0;
    if (!value.username) return;
    // A new account starts from this device's settings.
    if (latest === 0) {
      push();
      return;
    }
    if (latest <= revision || saving || unsaved) return;
    revision = latest;
    let changed = false;
    for (const key of KEYS) {
      const next = value.preferences?.[key];
      if (typeof next !== 'string') continue;
      try {
        if (localStorage.getItem(key) === next) continue;
        localStorage.setItem(key, next);
        changed = true;
      } catch {}
    }
    if (changed) callbacks.onPreferences();
  };
  const update = async (value: AccountReply) => {
    const wasSignedIn = signedIn;
    signedIn = !!value.username;
    accountButton.setAttribute('aria-label', signedIn ? 'Account' : 'Login');
    accountButton.title = signedIn ? 'Account' : 'Login';
    if (!signedIn) revision = 0;
    adopt(value);
    logout.disabled = deleteButton.disabled = busy || !signedIn;
    status.textContent = signedIn ? `Signed in as ${value.username}` : '';
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
      logout.disabled = deleteButton.disabled = !signedIn;
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
  return {
    refresh: () => run(async () => update(await request('session'))),
    /** Picks up settings saved on another device, without reconnecting. */
    pull: async () => {
      if (!signedIn) return;
      try {
        const value: AccountReply = await request('session');
        if (value.username) adopt(value);
        else await update(value);
      } catch {}
    },
    /** Saves this device's settings to the account, if signed in. */
    push,
  };
}

export async function accountSocketTicket(deviceId: string) {
  return request('connect', { deviceId });
}
