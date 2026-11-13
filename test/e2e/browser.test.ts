// End-to-end test: the production build in headless Chrome, connecting to the preset SimpleX servers
// through a Wisp relay and chatting with the official SimpleX Chat CLI.
//   npm run build && npm run relay &      # the page and a relay on this computer
//   SIMPLEX_CHAT_BIN=/path/to/simplex-chat CHROME_PATH=/path/to/chrome npm run e2e
// or against the published page and its default public relays:
//   APP_URL=https://portbuster.codeberg.page/duplex/ npm run e2e
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright-core';
import { Cli, itemTexts } from '../helpers/cli';

// a Chrome or Chromium binary; without it, the browser installed by Playwright
const CHROME = process.env.CHROME_PATH;
const APP = process.env.APP_URL ?? 'http://127.0.0.1:8745/';
// the relays the page uses by default, unless set
const RELAY = process.env.RELAY_URL;
const ME = 'alice';
const PEER = 'bob';
const SERVER = process.env.SMP_SERVER; // undefined: the preset servers of the SimpleX network
const OUT = 'test-results';
const NET = 120_000;

let browser: Browser;
let page: Page;
let cli: Cli;
const pageErrors: string[] = [];

before(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  cli = await Cli.start(PEER, 5320, SERVER);
  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 760 } });
  page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
    if (process.env.DEBUG) console.log('[page]', m.text());
  });
});

after(async () => {
  await browser?.close();
  cli?.stop();
});

async function shot(name: string) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

test('create a profile', async () => {
  await page.goto(APP);
  await page.getByPlaceholder('shown to your contacts').fill(ME);
  await page.locator('input[type=password]').nth(0).fill('a long test passphrase');
  await page.locator('input[type=password]').nth(1).fill('a long test passphrase');
  await page.getByText('Network settings').click();
  if (RELAY) await page.locator('textarea').fill(RELAY);
  await shot('1-setup');
  await page.getByText('Create profile').click();
  await page.getByText('No chats yet.').waitFor({ timeout: 60000 });
  await shot('2-empty');
});

test('the official CLI connects via a 1-time link from the browser', async () => {
  await page.getByLabel('New chat').first().click();
  const linkEl = page.locator('.link-box .mono');
  await linkEl.waitFor({ timeout: NET });
  const link = (await linkEl.textContent())!.trim();
  assert.match(link, /^https:\/\/smp\d+\.simplex\.im\/i#/);
  await shot('3-invitation');
  await page.getByText('Close and wait for the contact').click();
  const r = await cli.cmd(`/c ${link}`);
  assert.equal(r.type, 'sentConfirmation', JSON.stringify(r).slice(0, 300));
  await cli.waitType('contactConnected', NET);
  await page.locator('.chat-list .row', { hasText: PEER }).first().waitFor({ timeout: NET });
  await page.locator('.chat-list .row', { hasText: PEER }).first().click();
  await page.locator('.messages .event', { hasText: 'connected — messages are end-to-end encrypted' }).waitFor({ timeout: NET });
  await shot('4-connected');
});

test('messages in both directions with delivery receipts', async () => {
  await cli.cmd(`@${ME} Hello from the official SimpleX Chat CLI 👋`);
  await page.locator('.msg.rcv', { hasText: 'Hello from the official SimpleX Chat CLI' }).waitFor({ timeout: NET });
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('Hi! This is *Duplex*, running entirely in a browser.');
  await input.press('Enter');
  const got = await cli.waitType('newChatItems', NET, (e) => itemTexts(e).some((t) => t?.includes('running entirely in a browser')));
  assert.ok(got);
  // the CLI sends a delivery receipt
  await page.locator('.msg.snd .st[aria-hidden], .msg.snd svg.st').last().waitFor({ timeout: NET });
  await page.waitForFunction(() => document.querySelector('.msg.snd:last-of-type title')?.textContent === 'delivered' || [...document.querySelectorAll('.msg.snd title')].some((t) => t.textContent === 'delivered'), undefined, { timeout: NET });
  await shot('5-messages');
});

test('reply and reaction from the CLI are shown', async () => {
  const tail = await cli.cmd(`/tail @${ME} 1`);
  const item = tail.chatItems?.[0]?.chatItem;
  assert.ok(item, JSON.stringify(tail).slice(0, 300));
  await cli.cmd(`/_reaction @${tail.chatItems[0].chatInfo.contact.contactId} ${item.meta.itemId} on {"type":"emoji","emoji":"👍"}`);
  await page.locator('.reaction', { hasText: '👍' }).waitFor({ timeout: NET });
  // quotes the latest received message that starts with this text
  const q = await cli.cmd(`> @${ME} (Hi! This is) Impressive!`);
  assert.equal(q.type, 'newChatItems', JSON.stringify(q).slice(0, 300));
  await page.locator('.msg.rcv .quote', { hasText: 'running entirely in a browser' }).waitFor({ timeout: NET });
  await shot('6-reply-reaction');
  // relays that cannot be reached are skipped, everything else would be a bug (including CSP violations)
  assert.deepEqual(
    pageErrors.filter((e) => !/WebSocket connection to .* failed/.test(e)),
    [],
  );
});

test('the chats are restored after reload and unlock', async () => {
  await page.reload();
  await page.locator('input[type=password]').fill('a long test passphrase');
  await page.getByText('Unlock', { exact: true }).click();
  await page.locator('.chat-list .row', { hasText: PEER }).first().click();
  await page.locator('.msg.rcv', { hasText: 'Impressive!' }).waitFor({ timeout: 30000 });
  await cli.cmd(`@${ME} Still here after your reload?`);
  await page.locator('.msg.rcv', { hasText: 'Still here after your reload?' }).waitFor({ timeout: NET });
  await shot('7-after-reload');
});

test('the security code is the same as in the official client, and disappearing messages can be set', async () => {
  await page.getByLabel('Contact info').click();
  await page.locator('.security-code summary').click();
  const code = (await page.locator('.security-code .code').textContent())!.trim();
  const cc = await cli.cmd(`/code @${ME}`);
  assert.equal(cc.connectionCode, code);
  await page.getByLabel('Disappearing messages').selectOption('300');
  await cli.waitType('contactUpdated', NET, (e) => e.toContact?.profile?.preferences?.timedMessages?.ttl === 300);
  await shot('8-contact-info');
  await page.getByLabel('Close').click();
  await page.locator('.chat-sub', { hasText: 'disappearing after 5 minutes' }).waitFor({ timeout: 30000 });
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('This message disappears in 5 minutes');
  await input.press('Enter');
  const got = await cli.waitType('newChatItems', NET, (e) => itemTexts(e).includes('This message disappears in 5 minutes'));
  assert.equal(got.chatItems[0].chatItem.meta.itemTimed?.ttl, 300);
});

test('an incognito 1-time link shares a random profile', async () => {
  await page.getByLabel('New chat').first().click();
  await page.locator('.link-box .mono').waitFor({ timeout: NET });
  await page.locator('.modal .toggle-row', { hasText: 'Incognito' }).locator('input').check();
  const hint = page.locator('.modal .toggle-row', { hasText: 'Incognito' }).locator('.hint');
  await hint.filter({ hasText: 'random profile:' }).waitFor({ timeout: NET });
  const name = (await hint.textContent())!.split(': ').pop()!.trim();
  const link = (await page.locator('.link-box .mono').textContent())!.trim();
  await page.getByText('Close and wait for the contact').click();
  const r = await cli.cmd(`/c ${link}`);
  assert.equal(r.type, 'sentConfirmation');
  const con = await cli.waitType('contactConnected', NET);
  assert.equal(con.contact.profile.displayName, name);
});

test('another tab can take over, and this one disconnects', async () => {
  const page2 = await page.context().newPage();
  await page2.goto(APP);
  await page2.getByText('Duplex is open in another tab').waitFor({ timeout: 30000 });
  await page2.getByText('Use it here').click();
  await page2.locator('input[type=password]').waitFor({ timeout: 30000 });
  await page.getByText('Duplex is open in another tab').waitFor({ timeout: 30000 });
  await page2.close();
});
