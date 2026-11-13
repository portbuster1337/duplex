// End-to-end test: the production build in headless Chrome, connecting to the preset SimpleX servers
// through a Wisp relay and chatting with the official SimpleX Chat CLI.
//   npm run build && npm run relay &      # the page and a relay on this computer
//   SIMPLEX_CHAT_BIN=/path/to/simplex-chat CHROME_PATH=/path/to/chrome npm run e2e
// or against the published page and its default public relays:
//   APP_URL=https://portbuster.codeberg.page/duplex/ npm run e2e
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
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
  // a fake microphone (a tone) for recording voice messages
  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
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

/** an RGB PNG with a gradient and a text chunk that must not be sent */
function png(w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = Math.floor((x * 255) / w);
      raw[o + 1] = Math.floor((y * 255) / h);
      raw[o + 2] = (x ^ y) & 0xff;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const td = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('tEXt', Buffer.from('Comment\0secret location 51.5N 0.1W')), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const fileOf = (e: any) => e?.chatItems?.[0]?.chatItem?.file;

/** opens the chat with the CLI's first contact (not the incognito one) */
async function openPeer() {
  await page.locator('.chat-list .row', { hasText: PEER }).filter({ hasNot: page.locator('.incog') }).first().click();
  await page.locator('.chat-head .chat-name', { hasText: PEER }).waitFor({ timeout: 30000 });
}

/** the CLI downloads a file and returns its content */
async function cliReceive(fileId: number): Promise<Buffer> {
  const dir = path.join(cli.dir, `received-${fileId}`);
  fs.mkdirSync(dir, { recursive: true });
  const r = await cli.cmd(`/fr ${fileId} approved_relays=on ${dir}`);
  assert.equal(r.type, 'rcvFileAccepted', JSON.stringify(r).slice(0, 300));
  const done = await cli.waitType('rcvFileComplete', NET, (e) => e.chatItem?.chatItem?.file?.fileId === fileId);
  const p = done.chatItem.chatItem.file.fileSource.filePath as string;
  return fs.readFileSync(path.isAbsolute(p) ? p : path.join(dir, p));
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
  // the official client accepts the post-quantum key of the 1-time link
  await page.locator('.messages .event', { hasText: 'connected — messages are quantum resistant end-to-end encrypted' }).waitFor({ timeout: NET });
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

test('an image and a file sent from the browser reach the official CLI', async () => {
  await openPeer();
  const input = page.locator('.composer input[type=file]');
  await input.setInputFiles({ name: 'holiday.png', mimeType: 'image/png', buffer: png(1600, 1000) });
  await page.locator('.attachments .att img').waitFor({ timeout: 30000 });
  await page.getByLabel('Message', { exact: true }).fill('A picture from Duplex');
  await shot('9-attachment');
  await page.getByLabel('Send', { exact: true }).click();
  const got = await cli.waitType('newChatItems', NET, (e) => fileOf(e) && itemTexts(e).includes('A picture from Duplex'));
  const ci = got.chatItems[0].chatItem;
  assert.equal(ci.content.msgContent.type, 'image');
  assert.match(ci.content.msgContent.image, /^data:image\/jpg;base64,/);
  assert.ok(ci.content.msgContent.image.length <= 14000);
  assert.match(ci.file.fileName, /^IMG_\d{8}_\d{6}\.jpg$/);
  // the image was resized and re-encoded in the page: a JPEG without the text of the original
  const img = await cliReceive(ci.file.fileId);
  assert.equal(img.length, ci.file.fileSize);
  assert.ok(img[0] === 0xff && img[1] === 0xd8 && img.length <= 261120, `a JPEG of at most 255 KB, got ${img.length} bytes`);
  assert.ok(!img.includes('secret location'));
  await page.locator('.msg.snd .media img.msg-img[src^="blob:"]').last().waitFor({ timeout: NET });
  // a file of two chunks
  const data = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 7919) & 0xff));
  await input.setInputFiles({ name: 'notes.bin', mimeType: 'application/octet-stream', buffer: data });
  await page.locator('.attachments .att', { hasText: 'notes.bin' }).waitFor({ timeout: 30000 });
  await page.getByLabel('Send', { exact: true }).click();
  const gotFile = await cli.waitType('newChatItems', NET, (e) => fileOf(e)?.fileName === 'notes.bin');
  assert.equal(gotFile.chatItems[0].chatItem.content.msgContent.type, 'file');
  assert.deepEqual(await cliReceive(fileOf(gotFile).fileId), data);
  await shot('10-sent-files');
});

test('images from the official CLI are shown, and files can be downloaded and saved', async () => {
  await openPeer();
  const imgPath = path.join(cli.dir, 'from-cli.png');
  fs.writeFileSync(imgPath, png(400, 300));
  await cli.cmd(`/img @${ME} ${imgPath}`);
  // images are downloaded automatically, like in the apps
  await page.locator('.msg.rcv .media img.msg-img[src^="blob:"]').last().waitFor({ timeout: NET });
  const data = Buffer.from(Array.from({ length: 200_000 }, (_, i) => (i * 104729) & 0xff));
  const filePath = path.join(cli.dir, 'report.pdf');
  fs.writeFileSync(filePath, data);
  await cli.cmd(`/f @${ME} ${filePath}`);
  const row = page.locator('.msg.rcv .file-row', { hasText: 'report.pdf' });
  await row.waitFor({ timeout: NET });
  // other files only when the user asks
  await row.getByLabel('Download').click();
  await row.getByLabel('Save').waitFor({ timeout: NET });
  const [download] = await Promise.all([page.waitForEvent('download'), row.getByLabel('Save').click()]);
  assert.equal(download.suggestedFilename(), 'report.pdf');
  assert.deepEqual(fs.readFileSync((await download.path())!), data);
  await shot('11-received-files');
  assert.deepEqual(
    pageErrors.filter((e) => !/WebSocket connection to .* failed/.test(e)),
    [],
  );
});

/** the duration of an audio element once its metadata is loaded */
const audioDuration = (a: HTMLAudioElement) =>
  new Promise<number>((resolve, reject) => {
    if (a.readyState >= 1) return resolve(a.duration);
    a.addEventListener('loadedmetadata', () => resolve(a.duration), { once: true });
    a.addEventListener('error', () => reject(new Error(`cannot play: ${a.error?.message}`)), { once: true });
  });

test('voice messages are recorded in the browser and played from the official CLI', async () => {
  await openPeer();
  await page.getByLabel('Record a voice message').click();
  await page.locator('.recording').waitFor({ timeout: 30000 });
  await page.waitForTimeout(2600);
  await page.getByLabel('Stop recording').click();
  await page.locator('.voice-preview audio').waitFor({ timeout: 30000 });
  await page.getByLabel('Send', { exact: true }).click();
  const got = await cli.waitType('newChatItems', NET, (e) => e?.chatItems?.[0]?.chatItem?.content?.msgContent?.type === 'voice');
  const ci = got.chatItems[0].chatItem;
  assert.ok(ci.content.msgContent.duration >= 2, `duration ${ci.content.msgContent.duration}`);
  const data = await cliReceive(ci.file.fileId);
  // Chrome on Linux has no AAC encoder, so the recording is an 8 kHz μ-law WAV file, which the apps play
  if (ci.file.fileName.endsWith('.wav')) {
    assert.equal(data.subarray(0, 4).toString(), 'RIFF');
    assert.equal(data.readUInt16LE(20), 7);
    assert.equal(data.readUInt32LE(24), 8000);
    assert.ok(data.length > 2 * 8000, `${data.length} bytes`);
  } else assert.equal(data.subarray(4, 12).toString(), 'ftypM4A ');
  // the browser plays its own recording
  const own = page.locator('.msg.snd .voice audio[src^="blob:"]').last();
  await own.waitFor({ timeout: NET });
  assert.ok((await own.evaluate(audioDuration)) >= 2);
  // a voice message like the apps record: AAC in M4A
  const tail = await cli.cmd(`/tail @${ME} 1`);
  const contactId = tail.chatItems[0].chatInfo.contact.contactId;
  const src = path.join(cli.dir, 'voice_20261113_120000.m4a');
  fs.copyFileSync(new URL('./fixtures/voice.m4a', import.meta.url), src);
  const r = await cli.cmd(`/_send @${contactId} json ${JSON.stringify([{ filePath: src, msgContent: { type: 'voice', text: '', duration: 2 } }])}`);
  assert.equal(r.type, 'newChatItems', JSON.stringify(r).slice(0, 300));
  // downloaded automatically, like in the apps
  const audio = page.locator('.msg.rcv .voice audio[src^="blob:"]').last();
  await audio.waitFor({ timeout: NET });
  const d = await audio.evaluate(audioDuration);
  assert.ok(d > 1.5 && d < 3, `duration ${d}`);
  await shot('12-voice');
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
