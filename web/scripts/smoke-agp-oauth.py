#!/usr/bin/env python3
"""Exercise the built console's copied-link OAuth with isolated browser/API fixtures."""
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading

ROOT = Path(__file__).resolve().parents[1]
INIT = """
window.fixture = { starts: 0, status: 'pending', opened: 0, copied: '', denyCopy: false, exchanges: [] };
window.open = () => { fixture.opened++; throw new Error('Unexpected browser launch'); };
Object.defineProperty(navigator, 'clipboard', {value: {writeText: async (text) => {
  if (fixture.denyCopy) throw new Error('Fixture clipboard denied');
  fixture.copied = text;
}}});
window.fetch = async (url, options = {}) => {
  const path = new URL(url, location.origin).pathname;
  let result;
  if (path === '/admin/session') result = {loggedIn: true, csrfToken: 'fixture'};
  else if (path.endsWith('/oauth/start')) {
    fixture.starts++; fixture.status = 'pending';
    result = {url: 'https://accounts.google.com/o/oauth2/auth?state=fixture-' + fixture.starts,
      state: 'fixture-' + fixture.starts, instructions: 'fixture'};
  } else if (path.endsWith('/oauth/status')) result = {status: fixture.status};
  else if (path.endsWith('/oauth/exchange')) {
    fixture.exchanges.push(JSON.parse(options.body)); result = {id: 'fixture'};
  } else if (path.endsWith('/accounts')) result = [];
  else if (path.endsWith('/statistics')) result = {accounts: []};
  else throw new Error('Unexpected fixture request: ' + path);
  return new Response(JSON.stringify(result), {status: 200, headers: {'Content-Type': 'application/json'}});
};
"""
CHECK = """(async () => {
  const wait = async (condition) => {
    for (let i = 0; i < 150; i++) {
      if (condition()) return;
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('UI condition timed out');
  };
  const button = (name) => Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === name);
  const click = async (name) => { await wait(() => button(name) && !button(name).disabled); button(name).click(); };
  const field = (name) => {
    const label = Array.from(document.querySelectorAll('label')).find(l => l.textContent === name);
    return label && document.getElementById(label.htmlFor);
  };
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  await click('Добавить аккаунт');
  await click('Получить ссылку для входа Google');
  await wait(() => field('Ссылка для входа Google'));
  const link = field('Ссылка для входа Google');
  assert(link.readOnly && link.value.endsWith('fixture-1'), 'Visible read-only link missing');
  await click('Копировать ссылку');
  await wait(() => button('Ссылка скопирована'));
  assert(fixture.copied === link.value, 'Clipboard differs from displayed link');
  await click('Получить новую ссылку');
  await wait(() => field('Ссылка для входа Google').value.endsWith('fixture-2'));
  fixture.denyCopy = true;
  await click('Копировать ссылку');
  await wait(() => document.body.textContent.includes('Скопируйте вручную') || document.body.textContent.includes('скопируйте вручную'));
  assert(field('Ссылка для входа Google').value.endsWith('fixture-2'), 'Clipboard failure lost link');
  const code = field('Код или полный адрес после входа Google');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(code, '  http://localhost/callback?state=fixture-2&code=manual-code  ');
  code.dispatchEvent(new Event('input', {bubbles: true}));
  await click('Завершить OAuth');
  await wait(() => !document.querySelector('[role=dialog]'));
  assert(fixture.exchanges[0].state === 'fixture-2', 'Wrong attempt submitted');
  assert(fixture.exchanges[0].code === 'http://localhost/callback?state=fixture-2&code=manual-code', 'Manual callback not trimmed');
  await click('Добавить аккаунт');
  await click('Получить ссылку для входа Google');
  await wait(() => field('Ссылка для входа Google'));
  fixture.status = 'completed';
  await wait(() => !document.querySelector('[role=dialog]'));
  assert(fixture.opened === 0, 'A popup was opened');
  assert(fixture.exchanges.length === 1, 'Automatic completion submitted manual exchange');
  return {passed: ['copy link', 'new link', 'clipboard denial', 'manual return URL', 'automatic callback polling', 'no popup']};
})()"""


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def main():
    from playwright.sync_api import sync_playwright

    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT / 'dist')))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            try:
                context = browser.new_context()
                context.add_init_script(INIT)
                page = context.new_page()
                page.goto(f'http://127.0.0.1:{server.server_port}/index.html#/accounts')
                print(json.dumps(page.evaluate(CHECK), ensure_ascii=False))
            finally:
                browser.close()
    finally:
        server.shutdown()
        thread.join()
        server.server_close()


if __name__ == '__main__':
    main()
