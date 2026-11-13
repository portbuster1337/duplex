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

const items = (id: string, c = chat): ChatItem[] => c['items'].get(id) ?? [];
const post = (g: Group, text: string, c = chat) => items(g.id, c).find((i) => i.dir === 'rcv' && i.content.text === text);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const memberNamed = (g: Group, name: string, c = chat) => Object.values(c.group(g.id)!.members).find((m) => m.profile.displayName === name && m.status !== 'removed' && m.status !== 'left');
/** a CLI joins a channel link, once the relay serves it (its link is in the channel link) */
async function subscribe(cli: Cli, link: string, channel: string): Promise<void> {
  let joined: any;
  for (let i = 0; i < 30 && !joined; i++) {
    const plan = await cli.cmd(`/_connect plan 1 ${link}`);
    if (plan.connectionPlan?.groupLinkPlan?.type === 'ok') joined = await cli.cmd(`/c ${link}`);
    else await sleep(1000);
  }
  assert.equal(joined?.type, 'startedConnectionToGroup', JSON.stringify(joined).slice(0, 300));
  await cli.waitType('userJoinedGroup', NET, (e) => e.groupInfo?.groupProfile?.displayName === channel);
}
const cliText = (e: any, channel: string, text: string) => (e?.chatItems ?? []).some((ci: any) => ci?.chatInfo?.groupInfo?.groupProfile?.displayName === channel && ci.chatItem?.content?.msgContent?.text === text);
const cliRoles = async (cli: Cli, channel: string): Promise<Record<string, string>> =>
  Object.fromEntries(((await cli.cmd(`/ms #${channel}`)).group?.members ?? []).filter((m: any) => m.memberStatus !== 'removed' && m.memberStatus !== 'left').map((m: any) => [m.memberProfile?.displayName, m.memberRole]));
/** a member of a channel of a CLI, by its name in the profile (the CLI may name it otherwise): its IDs there */
async function cliMember(cli: Cli, channel: string, name: string): Promise<{ groupId: number; groupMemberId: number }> {
  for (let i = 0; i < 30; i++) {
    const r = (await cli.cmd(`/ms #${channel}`)).group;
    const m = (r?.members ?? []).find((x: any) => x.memberProfile?.displayName === name && x.memberStatus !== 'removed' && x.memberStatus !== 'left');
    if (m) return { groupId: r.groupInfo.groupId, groupMemberId: m.groupMemberId };
    await sleep(500);
  }
  throw new Error(`${name} is not a member of #${channel} for the CLI`);
}
async function cliSetRole(cli: Cli, channel: string, name: string, role: string): Promise<void> {
  const m = await cliMember(cli, channel, name);
  const r = await cli.cmd(`/_member role #${m.groupId} ${m.groupMemberId} ${role}`);
  assert.equal(r.type, 'membersRoleUser', JSON.stringify(r).slice(0, 300));
}
async function relayAddress(): Promise<string> {
  const rl = (await relay.cmd('/sa')).contactLink?.connLinkContact;
  return rl?.connShortLink ?? rl?.connFullLink;
}
/** a channel of the CLI owner, served by the CLI relay: its link */
async function ownerChannel(name: string): Promise<string> {
  const rs = await owner.cmd('/relays');
  const relayId = (rs.userServers ?? []).flatMap((u: any) => u.chatRelays ?? []).find((c: any) => !c.preset && c.relayProfile?.displayName === 'relay')?.chatRelayId;
  assert.equal((await owner.cmd(`/public group relays=${relayId} #${name}`)).type, 'publicGroupCreated');
  await owner.waitType('groupLinkDataUpdated', NET, (e) => e.groupInfo?.groupProfile?.displayName === name);
  const gl = (await owner.cmd(`/show link #${name}`)).groupLink?.connLinkContact;
  return gl?.connShortLink ?? gl?.connFullLink;
}

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
  await assert.rejects(chat.sendText(g.id, 'hi'), /only its owners and members post/);
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

test('the roster of a CLI owner: a moderator is known on joining, Duplex is made a member and posts, and is moderated', { skip: !SERVER }, async () => {
  const mod = await Cli.start('mod', 5343, SERVER);
  try {
    const blink = await ownerChannel('board');
    await subscribe(mod, blink, 'board');
    await cliSetRole(owner, 'board', 'mod', 'moderator');
    // Duplex joins after: the relay serves it the roster the owner signed, and introduces the moderator
    const g = await chat.joinGroup(blink);
    await until(() => chat.group(g.id)?.status === 'active', NET, 'joined');
    const m = await until(() => (memberNamed(g, 'mod')?.role === 'moderator' ? memberNamed(g, 'mod') : undefined), NET, 'the moderator from the roster');
    assert.ok(m.key, 'the key of the moderator, from the roster');
    assert.equal(chat.group(g.id)!.channel!.rosterComplete, chat.group(g.id)!.channel!.rosterVersion);
    // the owner makes Duplex a member (a change at the next roster version): it posts under its name
    await cliSetRole(owner, 'board', 'dave', 'member');
    await until(() => chat.group(g.id)?.role === 'member', NET, 'our new role');
    const mine = await chat.sendText(g.id, 'a post from a member');
    await owner.waitType('newChatItems', NET, (e) => cliText(e, 'board', 'a post from a member'));
    await mod.waitType('newChatItems', NET, (e) => cliText(e, 'board', 'a post from a member'));
    // a post of the moderator, with its author
    await mod.cmd('#board a word from the moderator');
    const mp = await until(() => post(g, 'a word from the moderator'), NET, 'the post of the moderator');
    assert.equal(mp.memberId, m.memberId);
    // the moderator deletes our post for everyone
    const t = await mod.cmd('/tail #board 10');
    const ci = t.chatItems.find((c: any) => c.chatItem.content?.msgContent?.text === 'a post from a member');
    await mod.cmd(`/_delete member item #${ci.chatInfo.groupInfo.groupId} ${ci.chatItem.meta.itemId}`);
    await until(() => items(g.id).find((i) => i.id === mine.id)?.deleted, NET, 'our post moderated');
    // the owner removes the moderator, and makes Duplex a subscriber again
    const om = await cliMember(owner, 'board', 'mod');
    await owner.cmd(`/_remove #${om.groupId} ${om.groupMemberId}`);
    await until(() => Object.values(chat.group(g.id)!.members).find((x) => x.memberId === m.memberId)?.status === 'removed', NET, 'the moderator removed');
    await cliSetRole(owner, 'board', 'dave', 'observer');
    await until(() => chat.group(g.id)?.role === 'observer', NET, 'a subscriber again');
    await assert.rejects(chat.sendText(g.id, 'hi'), /only its owners and members post/);
  } finally {
    mod.stop();
  }
});

test('Duplex as the owner gives roles: the CLI relay serves its roster, so a CLI joining later knows the moderator', { skip: !SERVER }, async () => {
  const sub = await Cli.start('sub', 5342, SERVER);
  const sub2 = await Cli.start('sub2', 5344, SERVER);
  try {
    const g = await chat.createChannel({ displayName: 'droster' }, [await relayAddress()]);
    const dlink = chat.group(g.id)!.channel!.link;
    await subscribe(sub, dlink, 'droster');
    const s = await until(() => memberNamed(g, 'sub'), NET, 'the subscriber announced');
    assert.ok(s.key, 'the relay announced the key of the subscriber');
    await chat.groups.setRole(g.id, s.memberId, 'moderator');
    await sub.waitType('memberRole', NET, (e) => e.toRole === 'moderator');
    assert.equal(chat.group(g.id)!.channel!.rosterVersion, 1);
    // a CLI joining later gets the roster Duplex signed, from the relay
    await subscribe(sub2, dlink, 'droster');
    let roles: Record<string, string> = {};
    for (let i = 0; i < 30 && roles.sub !== 'moderator'; i++) {
      roles = await cliRoles(sub2, 'droster');
      if (roles.sub !== 'moderator') await sleep(500);
    }
    assert.equal(roles.sub, 'moderator', JSON.stringify(roles));
    // a member posts under its name, which Duplex shows
    const s2 = await until(() => memberNamed(g, 'sub2'), NET, 'the second subscriber announced');
    await chat.groups.setRole(g.id, s2.memberId, 'member');
    await sub2.waitType('memberRole', NET, (e) => e.toRole === 'member');
    await sub2.cmd('#droster hello from a member');
    const p = await until(() => post(g, 'hello from a member'), NET, 'the post of the member');
    assert.equal(p.memberId, s2.memberId);
    await sub.waitType('newChatItems', NET, (e) => cliText(e, 'droster', 'hello from a member'));
    // removing the moderator: a change at the next roster version
    await chat.groups.removeMember(g.id, s.memberId);
    await sub.waitType('deletedMemberUser', NET);
    assert.equal(chat.group(g.id)!.channel!.rosterVersion, 3);
  } finally {
    sub.stop();
    sub2.stop();
  }
});

test('two owners: Duplex makes a Duplex subscriber an owner, who posts as the channel; a CLI joining later knows both', { skip: !SERVER }, async () => {
  const sub = await Cli.start('sub', 5342, SERVER);
  const vault = await Vault.create(new MemoryBackend(), 'test', { t: 1, m: 256, p: 1 });
  const erin = new ChatClient(vault, { profile: { displayName: 'erin', fullName: '' }, servers: [SERVER!], sendReceipts: true, shortLinks: true }, tcpConnector, [parseServer(SERVER!).server]);
  await erin.start();
  try {
    const g = await chat.createChannel({ displayName: 'duo' }, [await relayAddress()]);
    const dlink = chat.group(g.id)!.channel!.link;
    await subscribe(sub, dlink, 'duo');
    let eg!: Group;
    for (let i = 0; i < 30 && !eg; i++) {
      eg = await erin.joinGroup(dlink).catch(async () => (await sleep(1000), undefined as unknown as Group));
    }
    await until(() => erin.group(eg.id)?.status === 'active', NET, 'erin joined');
    const e = await until(() => memberNamed(g, 'erin'), NET, 'erin announced');
    await chat.groups.setRole(g.id, e.memberId, 'owner');
    // erin is in the channel link now, authorised by our key
    assert.equal(chat.agent.linkOwners(chat.group(g.id)!.channel!.linkConnId!).length, 2);
    await until(() => erin.group(eg.id)?.role === 'owner', NET, 'erin is an owner');
    // erin posts as the channel
    await erin.sendText(eg.id, 'a post by the second owner');
    await sub.waitType('newChatItems', NET, (ev) => cliText(ev, 'duo', 'a post by the second owner'));
    const p = await until(() => post(g, 'a post by the second owner'), NET, 'the post of the second owner');
    assert.equal(p.memberId, undefined, 'sent as the channel');
    // a CLI joining later takes both owners from the link
    const sub3 = await Cli.start('sub3', 5345, SERVER);
    try {
      await subscribe(sub3, dlink, 'duo');
      let roles: Record<string, string> = {};
      for (let i = 0; i < 30 && roles.erin !== 'owner'; i++) {
        roles = await cliRoles(sub3, 'duo');
        if (roles.erin !== 'owner') await sleep(500);
      }
      assert.equal(roles.erin, 'owner', JSON.stringify(roles));
      assert.equal(roles.dave, 'owner', JSON.stringify(roles));
    } finally {
      sub3.stop();
    }
    // a subscriber again: no longer in the link
    await chat.groups.setRole(g.id, e.memberId, 'observer');
    await until(() => erin.group(eg.id)?.role === 'observer', NET, 'erin a subscriber again');
    assert.equal(chat.agent.linkOwners(chat.group(g.id)!.channel!.linkConnId!).length, 1);
    await assert.rejects(erin.sendText(eg.id, 'hi'), /only its owners and members post/);
  } finally {
    erin.stop();
    sub.stop();
  }
});
