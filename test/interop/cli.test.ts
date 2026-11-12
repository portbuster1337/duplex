// Interoperability with the official SimpleX Chat CLI over a local SMP router:
//   SMP_SERVER=smp://<fingerprint>@localhost:7001 npm run test:interop
import { test, before, after } from 'node:test';
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
