// End-to-end test: the production build in headless Chrome, connecting to the preset SimpleX servers
// through a Wisp relay and chatting with the official SimpleX Chat CLI.
//   npm run build && npm run relay &      # the page and a relay on this computer
//   SIMPLEX_CHAT_BIN=/path/to/simplex-chat CHROME_PATH=/path/to/chrome npm run e2e
// or against the published page and its default public relays:
//   APP_URL=https://portbuster.codeberg.page/duplex/ npm run e2e
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
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
/** a chat in the list by its exact name */
const chatRow = (name: string) => page.locator('.chat-list .row').filter({ has: page.locator('.row-name', { hasText: new RegExp(`^${name}$`) }) });

async function openPeer() {
  await chatRow(PEER).filter({ hasNot: page.locator('.incog') }).first().click();
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
  await shot('3-new-chat');
  await page.getByRole('button', { name: /^Create a 1-time link/ }).click();
  const linkEl = page.locator('.link-box .mono');
  await linkEl.waitFor({ timeout: NET });
  // the other options stay in the window
  for (const o of [/^Connect via a link/, /^Your contact address/, /^Create a group/]) assert.ok(await page.getByRole('button', { name: o }).isVisible());
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
  // the quote goes to the message it quotes
  await page.locator('.msg.rcv .quote', { hasText: 'running entirely in a browser' }).click();
  await page.locator('.msg.flash', { hasText: 'running entirely in a browser' }).filter({ hasNot: page.locator('.quote') }).waitFor({ timeout: 5000 });
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
  await page.getByRole('button', { name: /^Create a 1-time link/ }).click();
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

test('the receiving address can be changed, and the official CLI follows', async () => {
  await openPeer();
  await page.getByLabel('Contact info').click();
  await page.getByRole('button', { name: 'Change receiving address' }).click();
  await page.getByRole('button', { name: 'Change', exact: true }).click();
  await page.locator('.address-change', { hasText: 'Changing the receiving address' }).waitFor({ timeout: NET });
  await cli.waitType('contactSwitch', NET, (e) => e.switchProgress?.queueDirection === 'snd' && e.switchProgress?.switchPhase === 'completed');
  await page.getByLabel('Close').click();
  await page.locator('.messages .event', { hasText: 'you changed address' }).waitFor({ timeout: NET });
  await cli.cmd(`@${ME} to your new address`);
  await page.locator('.msg.rcv', { hasText: 'to your new address' }).waitFor({ timeout: NET });
});

test('the official CLI invites the browser to a group, which it joins', async () => {
  await cli.cmd('/g #team');
  await cli.cmd(`/a #team @${ME}`);
  await openPeer();
  // the invitation is shown in the chat with the contact
  await page.getByRole('button', { name: 'Join group' }).click({ timeout: NET });
  await page.locator('.chat-head .chat-name', { hasText: 'team' }).waitFor({ timeout: 30000 });
  await page.locator('.messages .event', { hasText: 'you joined the group' }).waitFor({ timeout: NET });
  await cli.cmd('#team hello group');
  const m = page.locator('.msg.rcv.in-group', { hasText: 'hello group' });
  await m.waitFor({ timeout: NET });
  assert.equal((await m.locator('.sender').textContent())?.replace('owner', '').trim(), PEER);
  const input = page.getByLabel('Message', { exact: true });
  await input.fill('hi team');
  await input.press('Enter');
  await cli.waitType('newChatItems', NET, (e) => itemTexts(e).includes('hi team') && e.chatItems[0].chatInfo.type === 'group');
  // the members panel
  await page.getByLabel('Group info').click();
  await page.locator('.members .member', { hasText: PEER }).waitFor({ timeout: 30000 });
  await shot('13-group');
  await page.getByLabel('Close').click();
});

test('the browser creates a group, adds the CLI user and makes a group link', async () => {
  await page.getByLabel('New chat').first().click();
  await page.getByRole('button', { name: /^Create a group/ }).click();
  await page.getByLabel('Group name').fill('browser group');
  await page.getByLabel('Welcome message (optional)').fill('Welcome to the group of the browser');
  await page.getByRole('button', { name: 'Create group' }).click();
  await page.locator('.chat-head .chat-name', { hasText: 'browser group' }).waitFor({ timeout: 30000 });
  await page.getByLabel('Group info').click();
  await page.getByRole('button', { name: 'Add members' }).click();
  await page.locator('.pick-row', { hasText: PEER }).first().locator('input').check();
  await page.getByRole('button', { name: /^Invite/ }).click();
  const inv = await cli.waitType('receivedGroupInvitation', NET, (e) => e.groupInfo?.groupProfile?.displayName === 'browser group');
  assert.equal(inv.groupInfo.groupProfile.description, 'Welcome to the group of the browser');
  // names with spaces are quoted in CLI commands
  const gname = `'${inv.groupInfo.localDisplayName}'`;
  const j = await cli.cmd(`/j #${gname}`);
  assert.equal(j.type, 'userAcceptedGroupSent', JSON.stringify(j).slice(0, 300));
  await cli.waitType('userJoinedGroup', NET);
  await page.locator('.members .member', { hasText: PEER }).filter({ hasNot: page.locator('.muted', { hasText: 'connecting' }) }).waitFor({ timeout: NET });
  await page.getByRole('button', { name: 'Create group link' }).click();
  const link = (await page.locator('.group-link .link-box .mono').textContent({ timeout: NET }))!.trim();
  assert.match(link, /\/g#/);
  await page.getByLabel('Close').click();
  await cli.cmd(`#${gname} thanks for adding me`);
  await page.locator('.msg.rcv.in-group', { hasText: 'thanks for adding me' }).waitFor({ timeout: NET });
  await cli.cmd(`#${gname} and a second message`);
  await page.locator('.msg.rcv.in-group', { hasText: 'and a second message' }).waitFor({ timeout: NET });
  await shot('14-group-chat');
});

test('the browser reviews who joins its group link, and chats with them first', async () => {
  await page.getByLabel('New chat').first().click();
  await page.getByRole('button', { name: /^Create a group/ }).click();
  await page.getByLabel('Group name').fill('reviewed');
  await page.getByRole('button', { name: 'Create group' }).click();
  await page.locator('.chat-head .chat-name', { hasText: 'reviewed' }).waitFor({ timeout: 30000 });
  await page.getByLabel('Group info').click();
  await page.locator('.toggle-row', { hasText: 'Review new members' }).locator('input').check();
  await page.getByRole('button', { name: 'Create group link' }).click();
  const link = (await page.locator('.group-link .link-box .mono').textContent({ timeout: NET }))!.trim();
  await page.getByLabel('Close').click();
  await cli.cmd(`/c ${link}`);
  // the page says who waits, and the moderators chat with them before accepting
  await page.locator('.chat-banner', { hasText: `${PEER} wants to join` }).waitFor({ timeout: NET });
  await page.locator('.chat-banner').getByRole('button', { name: 'Review' }).click();
  await page.locator('.member', { hasText: PEER }).getByRole('button', { name: 'Chat' }).click();
  await page.locator('.chat-head .chat-sub', { hasText: 'waiting for review' }).waitFor({ timeout: 30000 });
  await page.locator('.composer textarea').fill('Hi! Why would you like to join?');
  await page.keyboard.press('Enter');
  const q = await cli.waitType('newChatItems', NET, (e) => e.chatItems?.[0]?.chatItem?.content?.msgContent?.text === 'Hi! Why would you like to join?');
  assert.ok(q.chatItems[0].chatInfo.groupChatScope, 'in the chat with the moderators');
  const gid = q.chatItems[0].chatInfo.groupInfo.groupId;
  await cli.cmd(`/_send #${gid}(_support) text I read about it`);
  await page.locator('.msg.rcv', { hasText: 'I read about it' }).waitFor({ timeout: NET });
  await shot('18-member-review');
  await page.locator('.chat-head').getByRole('button', { name: 'Accept' }).click();
  await cli.waitType('userJoinedGroup', NET, (e) => e.groupInfo?.groupProfile?.displayName === 'reviewed');
  await page.locator('.chat-head .chat-sub', { hasText: 'only this member and the moderators' }).waitFor({ timeout: 30000 });
});

test('the browser subscribes to a channel of the CLI, served by a CLI chat relay', async () => {
  // a second CLI runs as a chat relay; the CLI user owns the channel
  const relay = await Cli.start('relay', 5330, SERVER, ['--relay', '--headless']);
  try {
    const sa = await relay.cmd('/sa');
    const rl = sa.contactLink?.connLinkContact;
    assert.equal((await cli.cmd(`/relays name=relay ${rl?.connShortLink ?? rl?.connFullLink}`)).type, 'cmdOk');
    const rs = await cli.cmd('/relays');
    const relayId = (rs.userServers ?? []).flatMap((u: any) => u.chatRelays ?? []).find((c: any) => !c.preset && c.relayProfile?.displayName === 'relay')?.chatRelayId;
    assert.equal((await cli.cmd(`/public group relays=${relayId} #bulletin`)).type, 'publicGroupCreated');
    await cli.waitType('groupLinkDataUpdated', NET);
    const gl = (await cli.cmd('/show link #bulletin')).groupLink?.connLinkContact;
    const link = gl?.connShortLink ?? gl?.connFullLink;
    await cli.cmd('#bulletin The first post of the bulletin');
    await page.getByLabel('New chat').first().click();
    await page.getByRole('button', { name: /^Connect via a link/ }).click();
    await page.locator('.connect textarea').fill(link);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Join channel' }).click({ timeout: NET });
    await page.locator('.chat-head .chat-name', { hasText: 'bulletin' }).waitFor({ timeout: NET });
    // the history, then a new post, shown as the channel's
    await page.locator('.msg.rcv', { hasText: 'The first post of the bulletin' }).waitFor({ timeout: NET });
    await cli.cmd('#bulletin A second post');
    await page.locator('.msg.rcv:not(.in-group)', { hasText: 'A second post' }).waitFor({ timeout: NET });
    await page.locator('.composer textarea[disabled]').waitFor();
    await shot('19-channel');
    await page.getByLabel('Channel info').click();
    await page.locator('.kv', { hasText: 'connected' }).waitFor({ timeout: 30000 });
    await page.getByLabel('Close').click();
  } finally {
    relay.stop();
  }
});

/** serves a directory on 127.0.0.1 (a secure context for getUserMedia) */
function serveDir(dir: string): Promise<{ url: string; close: () => void }> {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript' };
  const server = http.createServer((req, res) => {
    const f = path.join(dir, path.normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^(\.\.[/\\])+/, ''));
    if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' }).end(fs.readFileSync(f));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, close: () => server.close() })));
}

test('a video call with the official CLI, whose media run in the call page of the apps', async () => {
  // the call page of the apps does WebRTC for the CLI user, which does the signalling
  const site = await serveDir(path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures/official-call'));
  const peer = await browser.newPage();
  try {
    await peer.goto(site.url + 'index.html');
    // processCommand is a top-level const of call.js, reached by name
    const official = (command: object) => peer.evaluate((c) => (0, eval)('processCommand')({ command: c }).then((r: any) => r.resp), command);
    const caps = await official({ type: 'capabilities', media: 'video' });
    assert.equal(caps.capabilities?.encryption, true, JSON.stringify(caps));
    const tail = await cli.cmd(`/tail @${ME} 1`);
    const contactId = tail.chatItems[0].chatInfo.contact.contactId;
    await cli.cmd(`/_call invite @${contactId} ${JSON.stringify({ media: 'video', capabilities: { encryption: true } })}`);
    // the browser rings, and its user accepts with video
    await page.getByLabel('Accept with video').click({ timeout: NET });
    const offer = await cli.waitType('callOffer', NET);
    assert.ok(offer.sharedKey, 'both sides encrypt the media');
    const ans = await official({ type: 'offer', offer: offer.offer.rtcSession, iceCandidates: offer.offer.rtcIceCandidates, media: 'video', aesKey: offer.sharedKey, relay: true });
    assert.equal(ans.type, 'answer', JSON.stringify(ans).slice(0, 300));
    await cli.cmd(`/_call answer @${contactId} ${JSON.stringify({ rtcSession: ans.answer, rtcIceCandidates: ans.iceCandidates })}`);
    // the later ICE candidates, in both directions
    let relaying = true;
    const relay = (async () => {
      while (relaying) {
        for (const m of await peer.evaluate(() => (window as any).messages.splice(0))) {
          if (m.resp?.type === 'ice') await cli.cmd(`/_call extra @${contactId} ${JSON.stringify({ rtcIceCandidates: m.resp.iceCandidates })}`);
        }
        const i = cli.events.findIndex((e) => e?.type === 'callExtraInfo');
        if (i >= 0) await official({ type: 'ice', iceCandidates: cli.events.splice(i, 1)[0].extraInfo.rtcIceCandidates });
        else await new Promise((r) => setTimeout(r, 300));
      }
    })();
    // connected through the TURN server of SimpleX Chat: both sides decrypt and show the video of the other
    await page.locator('.call-status', { hasText: /^\d+:\d\d$/ }).waitFor({ timeout: NET });
    await page.waitForFunction(() => ((document.querySelector('.remote-video') as HTMLVideoElement | null)?.videoWidth ?? 0) > 0, null, { timeout: NET });
    await peer.waitForFunction(() => ((document.getElementById('remote-video-stream') as HTMLVideoElement | null)?.videoWidth ?? 0) > 0, null, { timeout: NET });
    assert.match((await page.locator('.call-enc').textContent()) ?? '', /end-to-end encrypted/);
    await shot('15-call');
    // screen sharing, both ways: the apps see it from the bytes on the screen transceiver
    const peerSources = () => peer.evaluate(() => (0, eval)('activeCall')?.peerMediaSources as Record<string, boolean>);
    await page.getByLabel('Share your screen').click();
    await page.locator('.local-screen video').waitFor({ timeout: 30000 });
    await peer.waitForFunction(() => ((document.getElementById('remote-screen-video-stream') as HTMLVideoElement | null)?.videoWidth ?? 0) > 0 && (0, eval)('activeCall')?.peerMediaSources?.screenVideo, null, { timeout: NET });
    await page.getByLabel('Stop sharing your screen').click();
    await peer.waitForFunction(() => !(0, eval)('activeCall')?.peerMediaSources?.screenVideo, null, { timeout: 30000 });
    await peer.evaluate(() => (0, eval)('toggleScreenShare')());
    await page.waitForFunction(() => ((document.querySelector('.remote-screen:not(.hidden)') as HTMLVideoElement | null)?.videoWidth ?? 0) > 0, null, { timeout: NET });
    await page.getByText('sharing their screen').waitFor({ timeout: 5000 });
    await shot('16-call-screen');
    await peer.evaluate(() => (0, eval)('toggleScreenShare')());
    await page.locator('.remote-screen.hidden').waitFor({ state: 'attached', timeout: 30000 });
    // the camera off: nothing is sent, and the apps show the picture of the profile
    await page.getByLabel('Turn the camera off').click();
    await peer.waitForFunction(() => !(0, eval)('activeCall')?.peerMediaSources?.camera, null, { timeout: 30000 });
    await page.getByLabel('Turn the camera on').click();
    await peer.waitForFunction(() => (0, eval)('activeCall')?.peerMediaSources?.camera, null, { timeout: 30000 });
    assert.ok((await peerSources()).mic);
    await page.getByLabel('End call').click();
    await cli.waitType('callEnded', NET);
    relaying = false;
    await relay;
    // the call in the chat with the contact
    await page.locator('.call-screen').waitFor({ state: 'detached', timeout: 30000 });
    await openPeer();
    await page.locator('.messages .event', { hasText: /^incoming video call: \d+:\d\d$/ }).waitFor({ timeout: NET });
  } finally {
    await peer.close();
    site.close();
  }
});

test('themes and icon packs, kept after a reload and on the lock screen', async () => {
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  const iconBox = () => page.locator('.chat-head svg.icon').first().getAttribute('viewBox');
  await openPeer();
  assert.equal(await iconBox(), '0 0 24 24');
  await page.getByTitle('Settings').first().click();
  await page.getByRole('button', { name: /^Appearance/ }).click();
  await page.locator('.theme-card', { hasText: /^SimpleX/ }).click();
  assert.equal(await theme(), 'simplex');
  await page.getByRole('radio', { name: 'Purple' }).click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.accent), 'purple');
  await page.locator('.pack-card', { hasText: /^PhosphorMIT/ }).click();
  await page.keyboard.press('Escape');
  // Phosphor draws on a 256 grid
  await page.waitForFunction(() => document.querySelector('.chat-head svg.icon')?.getAttribute('viewBox') === '0 0 256 256', null, { timeout: 10000 });
  await shot('17-theme-simplex');
  await page.reload();
  await page.locator('input[type=password]').waitFor({ timeout: 30000 });
  assert.equal(await theme(), 'simplex');
  await page.locator('input[type=password]').fill('a long test passphrase');
  await page.getByText('Unlock', { exact: true }).click();
  await openPeer();
  assert.equal(await iconBox(), '0 0 256 256');
  // back to the defaults
  await page.getByTitle('Settings').first().click();
  await page.getByRole('button', { name: /^Appearance/ }).click();
  await page.locator('.theme-card', { hasText: /^System/ }).click();
  await page.getByRole('radio', { name: 'Theme colour' }).click();
  await page.locator('.pack-card', { hasText: /^LucideISC/ }).click();
  await page.keyboard.press('Escape');
  assert.equal(await iconBox(), '0 0 24 24');
  assert.equal(await theme(), 'light');
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
