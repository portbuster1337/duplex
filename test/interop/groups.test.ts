// Groups with the official SimpleX Chat CLI: two CLI users (carol and eve) and Duplex (dave), over a
// local SMP router:
//   SMP_SERVER=smp://<fingerprint>@localhost:7001 SIMPLEX_CHAT_BIN=… npm run test:interop
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ChatClient, type ChatItem, type Contact } from '../../src/app/chat';
import type { Group, GroupMember } from '../../src/app/groups';
import { MemoryBackend, Vault } from '../../src/app/vault';
import { parseServer } from '../../src/core/smp/server';
import { tcpConnector } from '../helpers/tcp';
import { Cli } from '../helpers/cli';

const SERVER = process.env.SMP_SERVER;
const NET = 60000;
let carol: Cli;
let eve: Cli;
let chat: ChatClient;
/** Duplex's contacts, and the CLI's names for Duplex */
let carolC: Contact;
let eveC: Contact;
let daveAtCarol: string;

async function until<T>(f: () => T | undefined | false, ms = NET, label = 'condition'): Promise<T> {
  for (let i = 0; i < ms / 100; i++) {
    const v = f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${label}`);
}

const items = (id: string): ChatItem[] => chat['items'].get(id) ?? [];
const member = (g: Group, name: string): GroupMember | undefined => Object.values(chat.group(g.id)!.members).find((m) => m.profile.displayName === name);
const groupItem = (e: any, group: string, text: string) =>
  (e?.chatItems ?? []).some((ci: any) => ci?.chatInfo?.groupInfo?.groupProfile?.displayName === group && (ci.chatItem?.content?.msgContent?.text ?? ci.chatItem?.meta?.itemText) === text);
const rcvText = (g: Group, from: string, text: string) => items(g.id).some((i) => i.dir === 'rcv' && i.content.text === text && i.memberId === member(g, from)?.memberId);

/** a 1-time link of a CLI, joined by Duplex */
async function connectDuplex(cli: Cli): Promise<{ contact: Contact; name: string }> {
  const r = await cli.cmd('/c');
  const contact = await chat.connect(r.connLinkInvitation.connShortLink);
  const con = await cli.waitType('contactConnected', NET);
  await until(() => chat.contact(contact.id)?.status === 'active', NET, 'contact active');
  return { contact: chat.contact(contact.id)!, name: con.contact.localDisplayName };
}

/** a CLI joins a group it was invited to */
async function cliJoins(cli: Cli, group: string): Promise<void> {
  const inv = await cli.waitType('receivedGroupInvitation', NET, (e) => e.groupInfo?.groupProfile?.displayName === group);
  const r = await cli.cmd(`/j #${inv.groupInfo.localDisplayName}`);
  assert.equal(r.type, 'userAcceptedGroupSent', JSON.stringify(r).slice(0, 300));
  await cli.waitType('userJoinedGroup', NET, (e) => e.groupInfo?.groupProfile?.displayName === group);
}

/** Duplex accepts the invitation to a group */
async function duplexJoins(name: string): Promise<Group> {
  const g = await until(() => chat.groups.list().find((x) => x.profile.displayName === name && x.status === 'invited'), NET, `invitation to ${name}`);
  const inv = items(g.invitation!.contactId).find((i) => i.groupInv?.groupId === g.id);
  assert.equal(inv?.groupInv?.status, 'pending');
  await chat.groups.accept(g.id);
  await until(() => chat.group(g.id)?.status === 'active', NET, `joined ${name}`);
  return g;
}

before(async () => {
  if (!SERVER) return;
  carol = await Cli.start('carol', 5320, SERVER);
  eve = await Cli.start('eve', 5321, SERVER);
  const vault = await Vault.create(new MemoryBackend(), 'test', { t: 1, m: 256, p: 1 });
  chat = new ChatClient(vault, { profile: { displayName: 'dave', fullName: '' }, servers: [SERVER], sendReceipts: true, shortLinks: true }, tcpConnector, [parseServer(SERVER).server]);
  await chat.start();
  // carol and eve are contacts, and both are contacts of Duplex
  const r = await carol.cmd('/c');
  await eve.cmd(`/c ${r.connLinkInvitation.connShortLink}`);
  await carol.waitType('contactConnected', NET);
  await eve.waitType('contactConnected', NET);
  ({ contact: carolC, name: daveAtCarol } = await connectDuplex(carol));
  ({ contact: eveC } = await connectDuplex(eve));
});

after(() => {
  chat?.stop();
  carol?.stop();
  eve?.stop();
});

test('Duplex joins a group of the CLI, and a member who joins later connects to it', { skip: !SERVER }, async () => {
  await carol.cmd('/g #team');
  await carol.cmd(`/a #team @${daveAtCarol}`);
  const g = await duplexJoins('team');
  assert.equal(member(g, 'carol')?.role, 'owner');
  assert.equal(chat.group(g.id)!.role, 'member');
  // eve joins after Duplex: carol announces her and forwards her invitation (x.grp.mem.new, x.grp.mem.fwd)
  await carol.cmd('/a #team @eve');
  await cliJoins(eve, 'team');
  await until(() => member(g, 'eve')?.status === 'connected', NET, 'connected to eve');
  assert.equal(member(g, 'eve')!.category, 'post');
  await eve.waitType('connectedToGroupMember', NET, (e) => e.member?.memberProfile?.displayName === 'dave');
  // messages in all directions
  await carol.cmd('#team hello from carol');
  await until(() => rcvText(g, 'carol', 'hello from carol'), NET, 'message from carol');
  await eve.cmd('#team hello from eve');
  await until(() => rcvText(g, 'eve', 'hello from eve'), NET, 'message from eve');
  await chat.sendText(g.id, 'hello from dave');
  await carol.waitType('newChatItems', NET, (e) => groupItem(e, 'team', 'hello from dave'));
  await eve.waitType('newChatItems', NET, (e) => groupItem(e, 'team', 'hello from dave'));
  // a reply to eve, and a reaction to it from carol
  const fromEve = items(g.id).find((i) => i.content.text === 'hello from eve')!;
  const reply = await chat.sendText(g.id, 'hi eve', fromEve.id);
  const got = await eve.waitType('newChatItems', NET, (e) => groupItem(e, 'team', 'hi eve'));
  assert.equal(got.chatItems[0].chatItem.quotedItem?.content?.text, 'hello from eve');
  const carolItem = await carol.cmd('/tail #team 1');
  const itemId = carolItem.chatItems[0].chatItem.meta.itemId;
  await carol.cmd(`/_reaction #${carolItem.chatItems[0].chatInfo.groupInfo.groupId} ${itemId} on {"type":"emoji","emoji":"👍"}`);
  await until(() => items(g.id).find((i) => i.id === reply.id)?.reactions?.['👍']?.members?.length === 1, NET, 'reaction');
  // the edit of a message
  await eve.cmd('! #team hello from eve (edited)');
  await until(() => items(g.id).some((i) => i.content.text === 'hello from eve (edited)' && i.edited), NET, 'edit');
});

test('Duplex joins a group with a member, who is introduced to it', { skip: !SERVER }, async () => {
  await carol.cmd('/g #club');
  await carol.cmd('/a #club @eve');
  await cliJoins(eve, 'club');
  await carol.cmd(`/a #club @${daveAtCarol}`);
  const g = await duplexJoins('club');
  // carol introduces eve (x.grp.mem.intro): Duplex sends its invitation for her (x.grp.mem.inv)
  await until(() => member(g, 'eve')?.status === 'connected', NET, 'connected to eve');
  assert.equal(member(g, 'eve')!.category, 'pre');
  await eve.cmd('#club eve here');
  await until(() => rcvText(g, 'eve', 'eve here'), NET, 'message from eve');
  await chat.sendText(g.id, 'dave here');
  await eve.waitType('newChatItems', NET, (e) => groupItem(e, 'club', 'dave here'));
  await carol.waitType('newChatItems', NET, (e) => groupItem(e, 'club', 'dave here'));
});

test('Duplex creates a group, adds the CLI users and introduces them to each other', { skip: !SERVER }, async () => {
  const g = await chat.groups.create({ displayName: 'dgroup', description: 'a group of Duplex' });
  await chat.groups.invite(g.id, carolC.id);
  await cliJoins(carol, 'dgroup');
  await until(() => member(g, 'carol')?.status === 'connected', NET, 'carol connected');
  await chat.groups.invite(g.id, eveC.id, 'admin');
  await cliJoins(eve, 'dgroup');
  await until(() => member(g, 'eve')?.status === 'connected', NET, 'eve connected');
  // carol and eve connect through the introduction of Duplex
  await carol.waitType('connectedToGroupMember', NET, (e) => e.groupInfo?.groupProfile?.displayName === 'dgroup' && e.member?.memberProfile?.displayName === 'eve');
  await eve.waitType('connectedToGroupMember', NET, (e) => e.groupInfo?.groupProfile?.displayName === 'dgroup' && e.member?.memberProfile?.displayName === 'carol');
  await until(() => chat.group(g.id)!.intros && Object.values(chat.group(g.id)!.intros!).every((s) => s === 'connected'), NET, 'introductions completed');
  await carol.cmd('#dgroup hi from carol');
  await eve.waitType('newChatItems', NET, (e) => groupItem(e, 'dgroup', 'hi from carol'));
  await until(() => rcvText(g, 'carol', 'hi from carol'), NET, 'message from carol');
  await chat.sendText(g.id, 'welcome');
  await carol.waitType('newChatItems', NET, (e) => groupItem(e, 'dgroup', 'welcome'));
  await eve.waitType('newChatItems', NET, (e) => groupItem(e, 'dgroup', 'welcome'));
  // the CLI sees the roles Duplex gave
  const ms = await carol.cmd('/ms #dgroup');
  const roles = Object.fromEntries((ms.group?.members ?? []).map((m: any) => [m.memberProfile.displayName, m.memberRole]));
  assert.deepEqual(roles, { dave: 'owner', eve: 'admin' }, JSON.stringify(ms).slice(0, 400));
  // an updated group profile reaches the members
  await chat.groups.updateProfile(g.id, { description: 'the new welcome message' });
  await carol.waitType('groupUpdated', NET, (e) => e.toGroup?.groupProfile?.description === 'the new welcome message');
});

test('group links: Duplex joins the link of the CLI, and the CLI joins the link of Duplex', { skip: !SERVER }, async () => {
  await carol.cmd('/g #linked');
  const r = await carol.cmd('/create link #linked');
  const link = r.groupLink?.connLinkContact?.connShortLink ?? r.groupLink?.connLinkContact?.connFullLink;
  assert.ok(link, JSON.stringify(r).slice(0, 300));
  const preview = await chat.previewLink(link);
  assert.equal(preview.kind, 'group');
  assert.equal(preview.groupProfile?.displayName, 'linked');
  const g = await chat.joinGroup(link, { resolved: preview.resolved });
  await until(() => chat.group(g.id)?.status === 'active', NET, 'joined via link');
  await until(() => member(g, 'carol')?.profile.displayName === 'carol' && member(g, 'carol')?.role === 'owner', NET, 'host profile');
  await carol.cmd('#linked via the link');
  await until(() => rcvText(g, 'carol', 'via the link'), NET, 'message via the link');
  await chat.sendText(g.id, 'joined via your link');
  await carol.waitType('newChatItems', NET, (e) => groupItem(e, 'linked', 'joined via your link'));
  // the link of a Duplex group
  const dg = await chat.groups.create({ displayName: 'dlinked' });
  const dlink = await chat.groups.createLink(dg.id);
  assert.match(dlink, /^https:\/\/localhost.*\/g#/);
  const j = await eve.cmd(`/c ${dlink}`);
  assert.ok(['sentInvitation', 'sentConfirmation', 'connectionPlan'].includes(j.type) || j.type.startsWith('sent'), JSON.stringify(j).slice(0, 300));
  await eve.waitType('userJoinedGroup', NET, (e) => e.groupInfo?.groupProfile?.displayName === 'dlinked');
  await until(() => member(dg, 'eve')?.status === 'connected', NET, 'eve joined via the link');
  await eve.cmd('#dlinked thanks for the link');
  await until(() => rcvText(dg, 'eve', 'thanks for the link'), NET, 'message from eve');
});

test('leaving and removing members', { skip: !SERVER }, async () => {
  const g = chat.groups.list().find((x) => x.profile.displayName === 'team')!;
  await eve.cmd('/l #team');
  await until(() => member(g, 'eve')?.status === 'left', NET, 'eve left');
  assert.ok(items(g.id).some((i) => i.dir === 'event' && i.content.text === 'eve left'));
  await carol.cmd(`/rm #team @${daveAtCarol}`);
  await until(() => chat.group(g.id)?.status === 'removed', NET, 'removed from the group');
  await chat.groups.delete(g.id);
  assert.equal(chat.group(g.id), undefined);
  // Duplex removes a member of its group
  const dg = chat.groups.list().find((x) => x.profile.displayName === 'dgroup')!;
  const em = member(dg, 'eve')!;
  await chat.groups.removeMember(dg.id, em.memberId);
  await eve.waitType('deletedMemberUser', NET, (e) => e.groupInfo?.groupProfile?.displayName === 'dgroup');
  await carol.waitType('deletedMember', NET, (e) => e.groupInfo?.groupProfile?.displayName === 'dgroup');
});
