// Channels with the official SimpleX Chat CLI: one CLI as a chat relay, one as the owner of a channel,
// and Duplex as a subscriber, over a local SMP router:
//   SMP_SERVER=smp://<fingerprint>@localhost:7001 SIMPLEX_CHAT_BIN=… npm run test:interop
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ChatClient, type ChatItem } from '../../src/app/chat';
import type { Group } from '../../src/app/groups';
import { MemoryBackend, Vault } from '../../src/app/vault';
import { parseServer } from '../../src/core/smp/server';
import { tcpConnector } from '../helpers/tcp';
import { Cli } from '../helpers/cli';

const SERVER = process.env.SMP_SERVER;
const NET = 60000;
let relay: Cli;
let owner: Cli;
let chat: ChatClient;
let link: string;

async function until<T>(f: () => T | undefined | false, ms = NET, label = 'condition'): Promise<T> {
  for (let i = 0; i < ms / 100; i++) {
    const v = f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${label}`);
}

const items = (id: string): ChatItem[] => chat['items'].get(id) ?? [];
const post = (g: Group, text: string) => items(g.id).find((i) => i.dir === 'rcv' && i.content.text === text);

before(async () => {
  if (!SERVER) return;
  relay = await Cli.start('relay', 5340, SERVER, ['--relay', '--headless', '--relay-address-server', SERVER]);
  owner = await Cli.start('owner', 5341, SERVER);
  const sa = await relay.cmd('/sa');
  const rl = sa.contactLink?.connLinkContact;
  assert.equal((await owner.cmd(`/relays name=relay ${rl?.connShortLink ?? rl?.connFullLink}`)).type, 'cmdOk');
  const rs = await owner.cmd('/relays');
  const relayId = (rs.userServers ?? []).flatMap((u: any) => u.chatRelays ?? []).find((c: any) => !c.preset && c.relayProfile?.displayName === 'relay')?.chatRelayId;
  assert.equal((await owner.cmd(`/public group relays=${relayId} #news`)).type, 'publicGroupCreated');
  await relay.waitType('userJoinedGroup', NET);
  // the link has the relay once the owner updated it
  await owner.waitType('groupLinkDataUpdated', NET);
  const gl = (await owner.cmd('/show link #news')).groupLink?.connLinkContact;
  link = gl?.connShortLink ?? gl?.connFullLink;
  assert.match(link, /\/c#/);
  const vault = await Vault.create(new MemoryBackend(), 'test', { t: 1, m: 256, p: 1 });
  chat = new ChatClient(vault, { profile: { displayName: 'dave', fullName: '' }, servers: [SERVER], sendReceipts: true, shortLinks: true }, tcpConnector, [parseServer(SERVER).server]);
  await chat.start();
});

after(() => {
  chat?.stop();
  relay?.stop();
  owner?.stop();
});

test('Duplex subscribes to a channel of the CLI, gets its history and new posts through the relay', { skip: !SERVER }, async () => {
  await owner.cmd('#news a post before you joined');
  await new Promise((r) => setTimeout(r, 1500));
  const preview = await chat.previewLink(link);
  assert.equal(preview.kind, 'channel');
  assert.equal(preview.groupProfile?.displayName, 'news');
  const g = await chat.joinGroup(link, { resolved: preview.resolved });
  assert.ok(chat.group(g.id)!.channel);
  await until(() => chat.group(g.id)?.status === 'active', NET, 'joined the channel');
  assert.equal(chat.group(g.id)!.role, 'observer');
  // the relay sends the history, and the owner sees the new subscriber
  await until(() => post(g, 'a post before you joined'), NET, 'the history');
  await owner.cmd('#news hello subscribers');
  const p = await until(() => post(g, 'hello subscribers'), NET, 'a new post');
  assert.equal(p.memberId, undefined, 'sent as the channel');
  const ms = await owner.cmd('/ms #news');
  assert.ok((ms.group?.members ?? []).some((m: any) => m.memberProfile?.displayName === 'dave'), JSON.stringify(ms).slice(0, 400));
  // subscribers do not post
  await assert.rejects(chat.sendText(g.id, 'hi'), /only the owners post/);
});

test('the owner updates the channel profile, signed, and edits and deletes a post', { skip: !SERVER }, async () => {
  const g = chat.groups.list().find((x) => x.channel)!;
  await owner.cmd('/set welcome #news Welcome to the news');
  await until(() => chat.group(g.id)?.profile.description === 'Welcome to the news', NET, 'the new profile');
  const t = await owner.cmd('/tail #news 10');
  const ci = t.chatItems.find((c: any) => c.chatItem.content?.msgContent?.text === 'hello subscribers');
  const id = ci.chatItem.meta.itemId;
  const gid = ci.chatInfo.groupInfo.groupId;
  await owner.cmd(`/_update item #${gid} ${id} text hello everyone`);
  await until(() => items(g.id).some((i) => i.content.text === 'hello everyone' && i.edited), NET, 'the edit');
  await owner.cmd(`/_delete item #${gid} ${id} broadcast`);
  await until(() => items(g.id).some((i) => i.deleted), NET, 'the deletion');
});

test('Duplex leaves the channel', { skip: !SERVER }, async () => {
  const g = chat.groups.list().find((x) => x.channel)!;
  await chat.groups.leave(g.id);
  assert.equal(chat.group(g.id)!.status, 'left');
  await owner.waitType('leftMember', NET, (e) => e.member?.memberProfile?.displayName === 'dave');
});

test('Duplex creates a channel served by the CLI relay; a CLI subscribes, and gets its posts and changes', { skip: !SERVER }, async () => {
  const sub = await Cli.start('sub', 5342, SERVER);
  try {
    const sa = await relay.cmd('/sa');
    const rl = sa.contactLink?.connLinkContact;
    const g = await chat.createChannel({ displayName: 'dnews', description: 'news from Duplex' }, [rl?.connShortLink ?? rl?.connFullLink]);
    const relayMember = () => Object.values(chat.group(g.id)!.members).find((m) => m.role === 'relay');
    await until(() => relayMember()?.status === 'connected', NET, 'the relay serves the channel');
    await chat.sendText(g.id, 'the first post from Duplex');
    const dlink = chat.group(g.id)!.channel!.link;
    assert.match(dlink, /\/c#/);
    // the relay joins its own link in the channel link once it sees it there
    let joined: any;
    for (let i = 0; i < 20 && !joined; i++) {
      const plan = await sub.cmd(`/_connect plan 1 ${dlink}`);
      if (plan.connectionPlan?.groupLinkPlan?.type === 'ok') joined = await sub.cmd(`/c ${dlink}`);
      else await new Promise((r) => setTimeout(r, 1000));
    }
    assert.equal(joined?.type, 'startedConnectionToGroup', JSON.stringify(joined).slice(0, 300));
    await sub.waitType('userJoinedGroup', NET, (e) => e.groupInfo?.groupProfile?.displayName === 'dnews');
    const groupText = (e: any, text: string) => (e?.chatItems ?? []).some((ci: any) => ci?.chatInfo?.groupInfo?.groupProfile?.displayName === 'dnews' && ci.chatItem?.content?.msgContent?.text === text);
    await sub.waitType('newChatItems', NET, (e) => groupText(e, 'the first post from Duplex'));
    const p2 = await chat.sendText(g.id, 'a second post');
    await sub.waitType('newChatItems', NET, (e) => groupText(e, 'a second post'));
    await until(() => (chat.group(g.id)!.channel!.subscribers ?? 0) >= 1, NET, 'the subscriber counted');
    // signed by the owner: the CLI checks the signature with the key from the channel link
    await chat.groups.updateProfile(g.id, { description: 'the news, updated' });
    await sub.waitType('groupUpdated', NET, (e) => e.toGroup?.groupProfile?.description === 'the news, updated');
    await chat.editItem(g.id, p2.id, 'a second post, edited');
    await sub.waitType('chatItemUpdated', NET, (e) => e.chatItem?.chatItem?.content?.msgContent?.text === 'a second post, edited');
    await chat.deleteItem(g.id, p2.id, true);
    await sub.waitType('chatItemsDeleted', NET);
  } finally {
    sub.stop();
  }
});
