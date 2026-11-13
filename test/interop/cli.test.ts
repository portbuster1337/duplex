// Interoperability with the official SimpleX Chat CLI over a local SMP router:
//   SMP_SERVER=smp://<fingerprint>@localhost:7001 npm run test:interop
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { ChatClient, type ChatEvent } from '../../src/app/chat';
import { MemoryBackend, Vault } from '../../src/app/vault';
import { parseServer } from '../../src/core/smp/server';
import { tcpConnector } from '../helpers/tcp';
import { Cli, itemTexts } from '../helpers/cli';

const SERVER = process.env.SMP_SERVER;
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
  cli = await Cli.start('carol', 5310, SERVER);
  const vault = await Vault.create(new MemoryBackend(), 'test', { t: 1, m: 256, p: 1 });
  chat = new ChatClient(vault, { profile: { displayName: 'dave', fullName: 'Dave Duplex' }, servers: [SERVER], sendReceipts: true, shortLinks: true }, tcpConnector, [parseServer(SERVER).server]);
  chat.on((e) => events.push(e));
  await chat.start();
});

after(() => {
  chat?.stop();
  cli?.stop();
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
