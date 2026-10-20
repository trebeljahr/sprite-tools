/** Standalone local setup works even when the optional web export is absent. */
export function setupHtml(nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local video setup · Sprite Tools</title><style nonce="${nonce}">
:root{font:16px/1.5 system-ui,sans-serif;color:#f0ece3;background:#151918;color-scheme:dark}*{box-sizing:border-box}body{margin:0}main{max-width:760px;margin:0 auto;padding:48px 24px}h1{font-size:2.2rem;line-height:1.15;margin:10px 0 16px}h2{font-size:1.2rem;margin:0 0 12px}p{color:#bfc8c1;max-width:62ch}a{color:#91d4b6}section{border-top:1px solid #3a4640;padding:26px 0}label{display:block;margin:14px 0 5px}input,select,button{font:inherit;border-radius:6px;padding:11px;border:1px solid #536259}input,select{width:100%;background:#202823;color:#fff}button{background:#b9e2bd;color:#152016;font-weight:600;cursor:pointer;margin-top:16px}button:disabled{opacity:.5;cursor:default}fieldset{border:0;padding:0;margin:0;min-width:0}fieldset:disabled{opacity:.55}.secondary{background:transparent;color:#d8e3d9;margin-left:8px}.eyebrow{color:#91d4b6;font-size:.8rem;letter-spacing:.12em;text-transform:uppercase}.row{display:grid;grid-template-columns:1fr 1fr;gap:18px}#message{white-space:pre-wrap;border-left:3px solid #91d4b6;padding:10px 14px;min-height:44px}small{display:block;color:#a7b8ad;margin-top:8px}output{display:block;color:#91d4b6}footer{margin-top:26px;color:#a7b8ad}@media(max-width:540px){.row{grid-template-columns:1fr}main{padding:28px 18px}}
</style></head><body><main><span class="eyebrow">Sprite Tools · This computer</span><h1>Connect video generation</h1><p>Save your provider keys, set a spending limit, then turn a prompt or reference image into sprites.</p><p id="message" role="status" aria-live="polite">Connecting to the local studio…</p>
<section><h2 id="vault-heading">1. Vault</h2><p id="vault-description">Checking for a saved vault…</p><form method="post" id="unlock" hidden><fieldset id="vault-fields" disabled><label for="passphrase">Vault passphrase</label><input id="passphrase" name="passphrase" type="password" minlength="12" maxlength="1024" autocomplete="current-password" aria-describedby="vault-description" required><div id="confirm-passphrase-row" hidden><label for="confirm-passphrase">Confirm passphrase</label><input id="confirm-passphrase" name="confirmPassphrase" type="password" minlength="12" maxlength="1024" autocomplete="new-password" disabled></div><button id="vault-submit" type="submit">Continue</button></fieldset></form><button id="lock" type="button" hidden disabled>Lock vault</button><small>Keys are encrypted on this computer. The passphrase is never saved. Restarting the studio locks the vault.</small><output id="vault-state"></output></section>
<section><h2>2. Save a provider key</h2><p>Create a dedicated API key in your provider console. Restrict its access and review the provider's spending controls.</p><p><a href="https://aistudio.google.com/api-keys" target="_blank" rel="noreferrer">Google AI Studio</a> · <a href="https://console.x.ai/" target="_blank" rel="noreferrer">xAI Console</a></p><form method="post" id="credentials"><fieldset id="credential-fields" disabled><label for="provider">Provider</label><select id="provider" name="provider"><option value="google">Google video</option><option value="xai">xAI Grok Imagine</option></select><label for="api-key">API key</label><input id="api-key" name="apiKey" type="password" autocomplete="off" minlength="8" maxlength="4096" required><button type="submit">Save encrypted key</button></fieldset></form><output id="provider-state"></output><small>Paste keys here. Do not put them in chat, prompts, MCP settings, or browser storage.</small></section>
<section><h2>3. Limit generation spend</h2><p>Both limits start at $0. The studio reserves each estimate before it sends a generation request.</p><form method="post" id="budget"><fieldset id="budget-fields" disabled><div class="row"><div><label for="limit">Total budget (USD)</label><input id="limit" type="number" min="0" max="10000" step="0.01" value="0" required></div><div><label for="per-job">Maximum per job (USD)</label><input id="per-job" type="number" min="0" max="10000" step="0.01" value="0" required></div></div><button type="submit">Save spending limits</button></fieldset></form><output id="budget-state"></output><small>This is a lifetime budget for this studio's saved jobs. Failed or uncertain attempts retain their reservations.</small><p>Provider bills may differ from estimates. Set console limits too. Google project caps can take about ten minutes to apply.</p></section>
<footer><a href="/animate">Open the video workspace →</a><p>The optional web workspace needs a local web export. This setup page always works.</p></footer></main><script nonce="${nonce}">
(() => {
  'use strict';
  const storageKey = 'sprite-tools:studio-token';
  const hash = new URLSearchParams(location.hash.slice(1));
  let token = hash.get('token');
  if (token) {
    sessionStorage.setItem(storageKey, token);
    history.replaceState(null, '', location.pathname + location.search);
  } else {
    token = sessionStorage.getItem(storageKey);
  }
  const el = id => document.getElementById(id);
  const message = text => { el('message').textContent = text; };
  let state = null;
  let busy = false;
  function render() {
    if (!state) return;
    const creating = !state.vaultExists;
    const unlocked = !state.locked;
    el('vault-heading').textContent = unlocked ? '1. Vault unlocked' : creating ? '1. Create your vault' : '1. Unlock your vault';
    el('vault-description').textContent = unlocked
      ? 'You can save provider keys and update spending limits. Lock the vault when you are done.'
      : creating
        ? 'Choose a passphrase of at least 12 characters to protect your provider keys. Keep it safe: lost passphrases cannot be recovered.'
        : 'Enter your existing passphrase to access your saved provider keys.';
    el('unlock').hidden = unlocked;
    el('vault-fields').disabled = busy || unlocked;
    el('passphrase').autocomplete = creating ? 'new-password' : 'current-password';
    el('confirm-passphrase-row').hidden = !creating;
    el('confirm-passphrase').disabled = !creating;
    el('confirm-passphrase').required = creating;
    el('vault-submit').textContent = busy
      ? creating ? 'Creating vault…' : 'Unlocking vault…'
      : creating ? 'Create vault' : 'Unlock vault';
    el('lock').hidden = !unlocked;
    el('lock').disabled = busy;
    el('vault-state').textContent = unlocked ? 'Vault unlocked' : creating ? 'No vault on this computer yet' : 'Vault locked';
    el('credential-fields').disabled = busy || state.locked || state.simulation;
    el('budget-fields').disabled = busy || state.locked;
  }
  async function api(path, body) {
    const response = await fetch('/api/studio/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + (token || ''), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: 'no-store',
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Local request failed.');
    return result;
  }
  async function refresh() {
    state = await api('status');
    render();
    el('provider-state').textContent = state.providers.map(p => (p.id === 'google' ? 'Google' : 'xAI') + ': ' + (p.configured ? 'key saved' : 'no key')).join(' · ');
    el('limit').value = state.budget.limitUsd;
    el('per-job').value = state.budget.perJobUsd;
    el('budget-state').textContent = 'Committed: $' + state.budget.committedUsd.toFixed(2) + ' · Remaining: $' + state.budget.remainingUsd.toFixed(2);
    return state;
  }
  async function action(work) {
    if (busy || !state) return;
    busy = true;
    render();
    try {
      await work();
      await refresh();
    } catch (error) {
      message(error instanceof Error ? error.message : 'Local request failed.');
    } finally {
      busy = false;
      render();
    }
  }
  el('confirm-passphrase').addEventListener('input', () => el('confirm-passphrase').setCustomValidity(''));
  el('passphrase').addEventListener('input', () => el('confirm-passphrase').setCustomValidity(''));
  el('unlock').addEventListener('submit', event => {
    event.preventDefault();
    if (!state) return;
    const field = el('passphrase');
    const confirmation = el('confirm-passphrase');
    if (!state.vaultExists && field.value !== confirmation.value) {
      confirmation.setCustomValidity('Passphrases do not match.');
      confirmation.reportValidity();
      return;
    }
    const creating = !state.vaultExists;
    action(async () => {
      try {
        await api('unlock', { passphrase: field.value });
        message(creating ? 'Vault created. Save a provider key below to get started.' : 'Vault unlocked. Saved provider jobs resume automatically.');
      } finally {
        field.value = '';
        confirmation.value = '';
        confirmation.setCustomValidity('');
      }
    });
  });
  el('lock').addEventListener('click', () => action(async () => {
    await api('lock', {});
    el('passphrase').value = '';
    el('confirm-passphrase').value = '';
    message('Vault locked. Active provider polling pauses.');
  }));
  el('credentials').addEventListener('submit', event => {
    event.preventDefault();
    action(async () => {
      const field = el('api-key');
      try {
        await api('credentials', { provider: el('provider').value, apiKey: field.value });
        message('Provider key saved in the encrypted vault.');
      } finally {
        field.value = '';
      }
    });
  });
  el('budget').addEventListener('submit', event => {
    event.preventDefault();
    action(async () => {
      await api('budget', { limitUsd: Number(el('limit').value), perJobUsd: Number(el('per-job').value) });
      message('Spending limits saved.');
    });
  });
  if (!token) {
    message('Open the setup link printed by your local studio command. It contains this session’s connection token.');
  } else {
    refresh().then(state => message(state.simulation
      ? 'Offline test: provider responses are simulated. Do not enter real API keys here.'
      : !state.locked
        ? 'Connected. Manage your provider keys and limits below.'
        : state.vaultExists
          ? 'Connected. Unlock your vault to manage provider keys and limits.'
          : 'Connected. Create your vault to save provider keys.')).catch(error => message(error.message));
  }
})();
</script></body></html>`;
}
