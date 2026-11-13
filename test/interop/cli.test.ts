// Interoperability with the official SimpleX Chat CLI over a local SMP router, and for files a local
// XFTP server:
//   SMP_SERVER=smp://<fingerprint>@localhost:7001 XFTP_SERVER=xftp://<fingerprint>@localhost:7002 npm run test:interop
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ChatClient, type ChatEvent, type ChatItem } from '../../src/app/chat';
import { FIXED_IMAGE_PREVIEW } from '../../src/app/files';
import { fromB64, randomBytes } from '../../src/core/util/bytes';
import { MemoryBackend, Vault } from '../../src/app/vault';
import { parseServer } from '../../src/core/smp/server';
import { tcpConnector } from '../helpers/tcp';
import { Cli, itemTexts } from '../helpers/cli';

const SERVER = process.env.SMP_SERVER;
// with another router for the CLI, Duplex sends to its queues with private message routing
const CLI_SERVER = process.env.SMP_SERVER2 ?? SERVER;
const XFTP = process.env.XFTP_SERVER;
let cli: Cli;
let chat: ChatClient;
const events: ChatEvent[] = [];

async function until<T>(f: () => T | undefined | false, ms = 30000, label = 'condition'): Promise<T> {
  for (let i = 0; i < ms / 100; i++) {
    const v = f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${label}`);
}

before(async () => {
  if (!SERVER) return;
  cli = await Cli.start('carol', 5310, CLI_SERVER, XFTP ? ['--xftp-server', XFTP] : []);
  const vault = await Vault.create(new MemoryBackend(), 'test', { t: 1, m: 256, p: 1 });
  chat = new ChatClient(
    vault,
    { profile: { displayName: 'dave', fullName: 'Dave Duplex' }, servers: [SERVER], sendReceipts: true, shortLinks: true, xftpServers: XFTP ? [XFTP] : undefined },
    tcpConnector,
    [parseServer(SERVER).server],
  );
  chat.on((e) => events.push(e));
  await chat.start();
});

after(() => {
  const st = chat?.agent.network.stats;
  chat?.stop();
  cli?.stop();
  // all commands to the queues of the CLI went through Duplex's own router
  if (st && CLI_SERVER !== SERVER) {
    assert.equal(st.direct + st.fallback, 0, `sent directly: ${JSON.stringify(st)}`);
    assert.ok(st.proxied > 0, `sent via private routing: ${JSON.stringify(st)}`);
  }
});

// events of the CLI that a previous test did not wait for (e.g. contactConnected after /ac) must not
// be taken for the events of the next test
beforeEach(() => {
  if (cli) cli.events.length = 0;
});

async function items(contactId: string) {
  return (await chat.chatItems(contactId)).filter((i) => i.dir !== 'event');
}

test('connect via the CLI invitation and exchange messages', { skip: !SERVER }, async () => {
  const r = await cli.cmd('/c');
  const link = r.connLinkInvitation.connShortLink;
  const preview = await chat.previewLink(link);
  assert.equal(preview.kind, 'invitation');
  assert.equal(preview.profile?.displayName, 'carol');
  const contact = await chat.connect(link, { resolved: preview.resolved });
  await cli.waitType('contactConnected');
  await until(() => chat.contact(contact.id)?.status === 'active', 30000, 'contact active');
  assert.equal(chat.contact(contact.id)!.profile.displayName, 'carol');

  // CLI -> Duplex
  await cli.cmd('@dave hello dave');
  await until(() => events.some((e) => e.type === 'newItem' && e.contactId === contact.id && e.item.dir === 'rcv'), 30000, 'message from CLI');
  const rcv = (await items(contact.id)).find((i) => i.dir === 'rcv')!;
  assert.equal(rcv.content.text, 'hello dave');

  // Duplex -> CLI, with a quote; the CLI sends a delivery receipt
  const sent = await chat.sendText(contact.id, 'hello carol', rcv.id);
  const got = await cli.waitType('newChatItems', 30000, (e) => itemTexts(e).includes('hello carol'));
  assert.equal(got.chatItems[0].chatItem.quotedItem?.content?.text, 'hello dave');
  await until(() => chat['items'].get(contact.id)?.find((i) => i.id === sent.id)?.status === 'delivered', 30000, 'delivery receipt');

  // both sides agreed on post-quantum encryption (the CLI proposes it for contacts)
  await until(() => chat.contact(contact.id)?.pq, 30000, 'post-quantum encryption');
  const info = await cli.cmd('/i @dave');
  const ac = info.contact?.activeConn;
  assert.ok(ac?.pqSndEnabled && ac?.pqRcvEnabled, `CLI: ${JSON.stringify({ pqSupport: ac?.pqSupport, pqEncryption: ac?.pqEncryption, snd: ac?.pqSndEnabled, rcv: ac?.pqRcvEnabled })}`);

  // edit, react, delete
  await chat.editItem(contact.id, sent.id, 'hello carol (edited)');
  await cli.waitType('chatItemUpdated', 30000);
  await chat.react(contact.id, rcv.id, '👍', true);
  await cli.waitType('chatItemReaction', 30000);
  await chat.deleteItem(contact.id, sent.id, true);
  await cli.wait((e) => e.type === 'chatItemsDeleted' || e.type === 'chatItemDeleted', 30000, 'deletion');

});

test('the CLI connects via a Duplex invitation and address', { skip: !SERVER }, async () => {
  const inv = await chat.createInvitation();
  const r = await cli.cmd(`/c ${inv.link}`);
  assert.equal(r.type, 'sentConfirmation');
  await cli.waitType('contactConnected');
  const c1 = await until(() => chat.contacts().find((c) => c.via === 'invitation-created' && c.status === 'active'), 30000, 'contact via invitation');
  assert.equal(c1.profile.displayName, 'carol');
  assert.equal(chat.state.invitations[inv.id], undefined);

  const addr = await chat.createAddress();
  await chat.setAutoAccept(true);
  const r2 = await cli.cmd(`/c ${addr.link}`);
  assert.equal(r2.type, 'sentInvitation');
  await cli.waitType('contactConnected');
  const c2 = await until(() => chat.contacts().find((c) => c.via === 'address-accepted' && c.status === 'active'), 30000, 'contact via address');
  assert.ok(c2);
});

test('Duplex sends a contact request to the CLI address', { skip: !SERVER }, async () => {
  const ad = await cli.cmd('/ad');
  const link = ad.connLinkContact?.connShortLink;
  assert.ok(link, JSON.stringify(ad).slice(0, 300));
  const preview = await chat.previewLink(link);
  assert.equal(preview.kind, 'contact');
  const c = await chat.connect(link, { resolved: preview.resolved, message: 'hi, it is dave' });
  const req = await cli.waitType('receivedContactRequest');
  assert.equal(req.contactRequest.localDisplayName.startsWith('dave'), true);
  await cli.cmd(`/ac ${req.contactRequest.localDisplayName}`);
  await until(() => chat.contact(c.id)?.status === 'active', 30000, 'request accepted');
  await chat.sendText(c.id, 'thanks for accepting');
  await cli.waitType('newChatItems', 30000, (e) => itemTexts(e).includes('thanks for accepting'));
});

/** a new contact connected via a 1-time link of the CLI; returns it and the CLI's name for it */
async function newPair(opts: { incognito?: boolean } = {}) {
  const r = await cli.cmd('/c');
  const contact = await chat.connect(r.connLinkInvitation.connShortLink, opts);
  const con = await cli.waitType('contactConnected');
  await until(() => chat.contact(contact.id)?.status === 'active', 30000, 'contact active');
  return { contact: chat.contact(contact.id)!, cliName: con.contact.localDisplayName as string, cliContact: con.contact };
}

const itemsOf = (contactId: string) => chat['items'].get(contactId) ?? [];

test('incognito: the contact sees a random profile', { skip: !SERVER }, async () => {
  // a 1-time link of Duplex, made incognito after it was created (before it is used)
  const inv0 = await chat.createInvitation();
  const inv = await chat.setInvitationIncognito(inv0.id, true);
  const name = inv.incognito!.displayName;
  assert.match(name, /^[A-Z][a-z]+[A-Z][a-z]+$/);
  assert.equal((await cli.cmd(`/c ${inv.link}`)).type, 'sentConfirmation');
  const con = await cli.waitType('contactConnected');
  assert.equal(con.contact.profile.displayName, name);
  const c = await until(() => chat.contacts().find((x) => x.incognito?.displayName === name && x.status === 'active'), 30000, 'incognito contact');
  assert.equal(c.profile.displayName, 'carol');
  // joining the CLI's link incognito
  const p = await newPair({ incognito: true });
  assert.ok(p.contact.incognito);
  assert.notEqual(p.contact.incognito!.displayName, name);
  assert.equal(p.cliContact.profile.displayName, p.contact.incognito!.displayName);
});

test('security codes are the same as in the official client', { skip: !SERVER }, async () => {
  const { contact, cliName } = await newPair();
  const code = chat.securityCode(contact.id)!;
  assert.match(code, /^\d{5}( \d{1,5})+$/);
  const cc = await cli.cmd(`/code @${cliName}`);
  assert.equal(cc.type, 'contactCode', JSON.stringify(cc).slice(0, 300));
  assert.equal(cc.connectionCode, code);
  const v = await cli.cmd(`/verify @${cliName} ${code}`);
  assert.equal(v.type, 'connectionVerified');
  assert.equal(v.verified, true);
  assert.equal(chat.isVerified(contact), false);
  await chat.setVerified(contact.id, true);
  assert.equal(chat.isVerified(chat.contact(contact.id)!), true);
});

test('address changes: Duplex and the CLI change their receiving addresses', { skip: !SERVER }, async () => {
  const { contact, cliName } = await newPair();
  const eventTexts = () => itemsOf(contact.id).filter((i) => i.dir === 'event').map((i) => i.content.text);
  // Duplex moves its receive queue (to the CLI's router when there is a second one)
  const before = chat.contactQueues(contact.id)!;
  await chat.agent.switchConnection(contact.connId, CLI_SERVER !== SERVER ? parseServer(CLI_SERVER!).server : undefined);
  await until(() => eventTexts().includes('started changing address…'), 10000, 'started event');
  const cliDone = await cli.waitType('contactSwitch', 60000, (e) => e.switchProgress?.queueDirection === 'snd' && e.switchProgress?.switchPhase === 'completed');
  assert.ok(cliDone);
  await until(() => eventTexts().includes('you changed address'), 30000, 'completed event');
  const afterQ = chat.contactQueues(contact.id)!;
  assert.equal(afterQ.rcvSwitch, undefined);
  if (CLI_SERVER !== SERVER) assert.notEqual(afterQ.rcvServer!.port, before.rcvServer!.port);
  await cli.cmd(`@${cliName} after your change`);
  await until(() => itemsOf(contact.id).some((i) => i.content.text === 'after your change'), 30000, 'message to the new queue');
  await chat.sendText(contact.id, 'and from me');
  await cli.waitType('newChatItems', 30000, (e) => itemTexts(e).includes('and from me'));
  // the CLI changes its receiving address: Duplex sends to the new queue
  const sndBefore = chat.agent.getConn(contact.connId)!.snd!.sndId;
  const r = await cli.cmd(`/switch @${cliName}`);
  assert.equal(r.type, 'contactSwitchStarted', JSON.stringify(r).slice(0, 300));
  await cli.waitType('contactSwitch', 60000, (e) => e.switchProgress?.queueDirection === 'rcv' && e.switchProgress?.switchPhase === 'completed');
  await until(() => eventTexts().includes('changed address for you'), 30000, 'changed address for you');
  assert.notDeepEqual(chat.agent.getConn(contact.connId)!.snd!.sndId, sndBefore);
  await chat.sendText(contact.id, 'to your new address');
  await cli.waitType('newChatItems', 30000, (e) => itemTexts(e).includes('to your new address'));
  await cli.cmd(`@${cliName} it works`);
  await until(() => itemsOf(contact.id).some((i) => i.content.text === 'it works'), 30000, 'reply');
});

test('calls: the signalling and the media key are the same as in the official client', { skip: !SERVER }, async () => {
  const { contact, cliName } = await newPair();
  chat.callEncryption = () => true;
  const signals: any[] = [];
  chat.calls.onSignal = (sig) => signals.push(sig);
  // Duplex calls the CLI
  const call = await chat.calls.start(contact.id, 'video', true);
  const inv = await cli.waitType('callInvitation', 30000);
  assert.equal(inv.callInvitation.callType.media, 'video');
  assert.ok(inv.callInvitation.sharedKey, 'the CLI agreed a key');
  const cliContactId = inv.callInvitation.contact.contactId;
  const offer = { callType: { media: 'video', capabilities: { encryption: true } }, rtcSession: { rtcSession: 'offer-sdp', rtcIceCandidates: 'offer-ice' } };
  assert.equal((await cli.cmd(`/_call offer @${cliContactId} ${JSON.stringify(offer)}`)).type, 'cmdOk');
  await until(() => signals.find((x) => x.type === 'offer'), 30000, 'offer');
  assert.equal(call.status, 'connecting');
  // both sides derive the same key of the media frames (HKDF of the DH secret, call version 2)
  assert.equal(call.aesKey, inv.callInvitation.sharedKey);
  assert.deepEqual(signals.find((x) => x.type === 'offer').offer, offer.rtcSession);
  await chat.calls.sendAnswer({ rtcSession: 'answer-sdp', rtcIceCandidates: 'answer-ice' });
  const ans = await cli.waitType('callAnswer', 30000);
  assert.deepEqual(ans.answer, { rtcSession: 'answer-sdp', rtcIceCandidates: 'answer-ice' });
  await chat.calls.sendExtra('more-ice');
  assert.equal((await cli.waitType('callExtraInfo', 30000)).extraInfo.rtcIceCandidates, 'more-ice');
  await cli.cmd(`/_call extra @${cliContactId} ${JSON.stringify({ rtcIceCandidates: 'cli-ice' })}`);
  await until(() => signals.find((x) => x.type === 'extra' && x.iceCandidates === 'cli-ice'), 30000, 'extra');
  await chat.calls.connected();
  await chat.calls.end();
  await cli.waitType('callEnded', 30000);
  chat.calls.dismiss();
  // the CLI calls Duplex
  await cli.cmd(`/_call invite @${cliContactId} ${JSON.stringify({ media: 'audio', capabilities: { encryption: true } })}`);
  const rcv = await until(() => chat.calls.active?.status === 'ringing' && chat.calls.active, 30000, 'incoming call');
  assert.equal(rcv.media, 'audio');
  chat.calls.accept();
  await chat.calls.sendOffer({ rtcSession: 'duplex-offer', rtcIceCandidates: 'duplex-ice' }, true);
  const off = await cli.waitType('callOffer', 30000);
  assert.deepEqual(off.offer, { rtcSession: 'duplex-offer', rtcIceCandidates: 'duplex-ice' });
  assert.equal(off.sharedKey, rcv.aesKey);
  assert.equal(off.askConfirmation, false);
  await cli.cmd(`/_call answer @${cliContactId} ${JSON.stringify({ rtcSession: 'cli-answer', rtcIceCandidates: 'cli-ice2' })}`);
  await until(() => signals.find((x) => x.type === 'answer' && x.answer.rtcSession === 'cli-answer'), 30000, 'answer');
  await cli.cmd(`/_call end @${cliContactId}`);
  await until(() => chat.calls.active?.status === 'ended', 30000, 'ended by the CLI');
  chat.calls.dismiss();
  const events = itemsOf(contact.id).filter((i) => i.call).map((i) => i.content.text);
  assert.deepEqual(events, ['outgoing video call: 0:00', 'incoming audio call: ended by the contact']);
  void cliName;
});

test('disappearing messages work both ways', { skip: !SERVER }, async () => {
  const { contact, cliName } = await newPair();
  // the CLI turns them on: Duplex uses the same time for its messages
  await cli.cmd(`/set disappear @${cliName} yes 1h`);
  await until(() => chat.contact(contact.id)?.ttl === 3600, 30000, 'TTL from the CLI');
  await chat.sendText(contact.id, 'this one disappears');
  const got = await cli.waitType('newChatItems', 30000, (e) => itemTexts(e).includes('this one disappears'));
  assert.equal(got.chatItems[0].chatItem.meta.itemTimed?.ttl, 3600);
  // received ones disappear after they are read
  await cli.cmd(`@${cliName} mine disappears too`);
  const rcv = await until(() => itemsOf(contact.id).find((i) => i.dir === 'rcv' && i.content.text === 'mine disappears too'), 30000, 'timed message from the CLI');
  assert.equal(rcv.ttl, 3600);
  assert.equal(rcv.deleteAt, undefined);
  await chat.markRead(contact.id);
  assert.ok(rcv.deleteAt && rcv.deleteAt > Date.now() + 3500_000);
  // Duplex changes the time: the CLI adopts it
  await chat.setDisappearing(contact.id, 300);
  await cli.waitType('contactUpdated', 30000, (e) => e.toContact?.profile?.preferences?.timedMessages?.ttl === 300);
  await cli.cmd(`@${cliName} after the change`);
  const rcv2 = await until(() => itemsOf(contact.id).find((i) => i.dir === 'rcv' && i.content.text === 'after the change'), 30000, 'message after the change');
  assert.equal(rcv2.ttl, 300);
  // the CLI does not allow them anymore
  await cli.cmd(`/set disappear @${cliName} no`);
  await until(() => !chat.peerAllowsTimed(chat.contact(contact.id)!), 30000, 'disappearing messages turned off');
  await chat.sendText(contact.id, 'this one stays');
  const got2 = await cli.waitType('newChatItems', 30000, (e) => itemTexts(e).includes('this one stays'));
  assert.equal(got2.chatItems[0].chatItem.meta.itemTimed, undefined);
  await assert.rejects(chat.setDisappearing(contact.id, 300), /does not allow/);
});

async function untilAsync<T>(f: () => Promise<T | undefined | false>, ms = 30000, label = 'condition'): Promise<T> {
  for (let i = 0; i < ms / 100; i++) {
    const v = await f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${label}`);
}

const fileOf = (e: any) => e?.chatItems?.[0]?.chatItem?.file;
const blobOf = (b: Uint8Array) => new Blob([b as BlobPart]);
const PNG = fromB64(FIXED_IMAGE_PREVIEW.split(',')[1]);

/** the CLI downloads a file into its folder and returns the content */
async function cliReceive(fileId: number): Promise<Uint8Array> {
  const dir = path.join(cli.dir, `received-${fileId}`);
  fs.mkdirSync(dir, { recursive: true });
  const r = await cli.cmd(`/fr ${fileId} approved_relays=on ${dir}`);
  assert.equal(r.type, 'rcvFileAccepted', JSON.stringify(r).slice(0, 300));
  const done = await cli.waitType('rcvFileComplete', 60000, (e) => e.chatItem?.chatItem?.file?.fileId === fileId);
  const p = done.chatItem.chatItem.file.fileSource.filePath as string;
  return new Uint8Array(fs.readFileSync(path.isAbsolute(p) ? p : path.join(dir, p)));
}

async function rcvItem(contactId: string, pred: (i: ChatItem) => boolean, label: string): Promise<ChatItem> {
  return until(() => itemsOf(contactId).find((i) => i.dir === 'rcv' && pred(i)), 30000, label);
}

test('files: Duplex sends a file and an image, the CLI receives them', { skip: !SERVER || !XFTP }, async () => {
  const { contact } = await newPair();
  // two chunks of different sizes
  const data = randomBytes(300_000);
  const sent = await chat.sendFile(contact.id, { blob: blobOf(data), name: 'report 1.bin', kind: 'file' }, 'the report');
  const got = await cli.waitType('newChatItems', 30000, (e) => fileOf(e)?.fileName === 'report 1.bin');
  const ci = got.chatItems[0].chatItem;
  assert.equal(ci.content.msgContent.type, 'file');
  assert.equal(ci.content.msgContent.text, 'the report');
  assert.equal(ci.file.fileSize, data.length);
  assert.deepEqual(await cliReceive(ci.file.fileId), data);
  await until(() => itemsOf(contact.id).find((i) => i.id === sent.id)?.file?.status === 'sndComplete', 30000, 'upload complete');
  // an image with a preview, received automatically by the apps
  await chat.sendFile(contact.id, { blob: blobOf(PNG), name: 'IMG_20261113_120000.png', kind: 'image', preview: FIXED_IMAGE_PREVIEW });
  const gotImg = await cli.waitType('newChatItems', 30000, (e) => fileOf(e)?.fileName === 'IMG_20261113_120000.png');
  const img = gotImg.chatItems[0].chatItem;
  assert.equal(img.content.msgContent.type, 'image');
  assert.equal(img.content.msgContent.image, FIXED_IMAGE_PREVIEW);
  assert.deepEqual(await cliReceive(img.file.fileId), PNG);
});

test('files: the CLI sends a file and an image, Duplex receives them', { skip: !SERVER || !XFTP }, async () => {
  const { contact, cliName } = await newPair();
  const data = randomBytes(1_200_000);
  const src = path.join(cli.dir, 'from cli.bin');
  fs.writeFileSync(src, data);
  await cli.cmd(`/f @${cliName} ${src}`);
  const it = await rcvItem(contact.id, (i) => i.file?.name === 'from cli.bin', 'file from the CLI');
  assert.equal(it.file!.size, data.length);
  assert.equal(it.file!.status, 'rcvInvitation');
  // files are not downloaded without asking
  await untilAsync(async () => (await chat.files.getMeta(it.file!.id))?.descrComplete, 60000, 'file description');
  assert.equal(it.file!.status, 'rcvInvitation');
  await chat.receiveFile(contact.id, it.id);
  await until(() => it.file!.status === 'rcvComplete' || it.file!.status === 'rcvError', 60000, 'download');
  assert.equal(it.file!.status, 'rcvComplete', it.file!.error);
  assert.deepEqual(new Uint8Array(await (await chat.fileBlob(it.file!)).arrayBuffer()), data);
  // images are downloaded automatically, like in the apps
  const imgPath = path.join(cli.dir, 'picture.png');
  fs.writeFileSync(imgPath, PNG);
  await cli.cmd(`/img @${cliName} ${imgPath}`);
  const img = await rcvItem(contact.id, (i) => i.content.type === 'image', 'image from the CLI');
  await until(() => img.file?.status === 'rcvComplete' || img.file?.status === 'rcvError', 60000, 'image download');
  assert.equal(img.file!.status, 'rcvComplete', img.file!.error);
  assert.equal(img.file!.mime, 'image/png');
  assert.deepEqual(new Uint8Array(await (await chat.fileBlob(img.file!, true)).arrayBuffer()), PNG);
  assert.equal((await chat.fileBlob(img.file!, true)).type, 'image/png');
});

test('files: cancelled and revoked files', { skip: !SERVER || !XFTP }, async () => {
  const { contact, cliName } = await newPair();
  // Duplex revokes a sent file before the CLI downloads it
  const sent = await chat.sendFile(contact.id, { blob: blobOf(randomBytes(100_000)), name: 'revoked.bin', kind: 'file' });
  const got = await cli.waitType('newChatItems', 30000, (e) => fileOf(e)?.fileName === 'revoked.bin');
  await until(() => itemsOf(contact.id).find((i) => i.id === sent.id)?.file?.status === 'sndComplete', 30000, 'upload complete');
  await chat.revokeFile(contact.id, sent.id);
  assert.equal(itemsOf(contact.id).find((i) => i.id === sent.id)?.file?.status, 'sndCancelled');
  await cli.waitType('rcvFileSndCancelled', 30000, (e) => e.chatItem?.chatItem?.file?.fileId === fileOf(got).fileId);
  // the CLI cancels a file it sent
  const src = path.join(cli.dir, 'cancelled.bin');
  fs.writeFileSync(src, randomBytes(50_000));
  const r = await cli.cmd(`/f @${cliName} ${src}`);
  const cliFileId = fileOf(r)?.fileId;
  assert.ok(cliFileId, JSON.stringify(r).slice(0, 300));
  const it = await rcvItem(contact.id, (i) => i.file?.name === 'cancelled.bin', 'file to be cancelled');
  await cli.waitType('sndFileCompleteXFTP', 60000);
  await cli.cmd(`/fc ${cliFileId}`);
  await until(() => it.file?.status === 'rcvCancelled', 30000, 'file cancelled by the sender');
  await assert.rejects(chat.receiveFile(contact.id, it.id), /deleted the file/);
});

test('files: a message with a file deleted for everyone', { skip: !SERVER || !XFTP }, async () => {
  const { contact } = await newPair();
  const sent = await chat.sendFile(contact.id, { blob: blobOf(randomBytes(70_000)), name: 'deleted.bin', kind: 'file' });
  const got = await cli.waitType('newChatItems', 30000, (e) => fileOf(e)?.fileName === 'deleted.bin');
  await until(() => itemsOf(contact.id).find((i) => i.id === sent.id)?.file?.status === 'sndComplete', 30000, 'upload complete');
  const fileId = sent.file!.id;
  assert.ok((await chat.files.getMeta(fileId))?.sndDescr);
  await chat.deleteItem(contact.id, sent.id, true);
  await cli.wait((e) => e.type === 'chatItemsDeleted' || e.type === 'chatItemDeleted', 30000, 'deletion');
  // the keys and the local copy are gone, and the CLI cannot download the file anymore
  assert.equal(await chat.files.getMeta(fileId), undefined);
  assert.equal(itemsOf(contact.id).find((i) => i.id === sent.id)?.file, undefined);
  const dir = path.join(cli.dir, 'deleted');
  fs.mkdirSync(dir, { recursive: true });
  const r = await cli.cmd(`/fr ${got.chatItems[0].chatItem.file.fileId} approved_relays=on ${dir}`);
  if (r.type === 'rcvFileAccepted') await cli.wait((e) => e.type === 'rcvFileError' || e.type === 'chatError' || e.type === 'rcvFileWarning', 60000, 'download error');
});
