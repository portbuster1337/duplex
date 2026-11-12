import { Cli, itemTexts } from '../helpers/cli';
import { Agent, MemoryAgentStore, type AgentEvent } from '../../src/core/agent/agent';
import { parseServer } from '../../src/core/smp/server';
import { fromUtf8 } from '../../src/core/util/bytes';
import { tcpConnector } from '../helpers/tcp';
import { encodeChatMessage, xInfo, xMsgNew, xContact, newSharedMsgId, contactShortLinkData } from '../../src/core/chat/protocol';

const SERVER = 'smp://94Hl8aQf-lUd99V0k0sLzyrq9dcdcvrvMNs0JsYsZg8=@localhost:7001';
const cli = await Cli.start('bob', 5302, SERVER);
const events: AgentEvent[] = [];
const agent = new Agent(new MemoryAgentStore(), tcpConnector, { servers: [parseServer(SERVER).server] });
const me = { displayName: 'duplex', fullName: '' };
agent.onEvent = async (e) => {
  events.push(e);
  const body = e.type === 'MSG' ? fromUtf8(e.body) : (e.type === 'INFO' || e.type === 'CONF' || e.type === 'REQ') ? fromUtf8(e.connInfo) : e.type === 'ERR' ? e.err : '';
  console.log('agent', e.type, body.slice(0, 200));
  if (e.type === 'CONF') return { allow: encodeChatMessage(xInfo(me)) };
  if (e.type === 'REQ') return { accept: encodeChatMessage(xInfo(me)) };
  if (e.type === 'MSG') return { receipt: true };
};
const until = async (f: () => boolean, ms = 30000) => { for (let i = 0; i < ms / 100 && !f(); i++) await new Promise((r) => setTimeout(r, 100)); if (!f()) throw new Error('timeout'); };
await agent.start();
try {
  // 1. our invitation, CLI joins
  const inv = await agent.createInvitation({ userData: contactShortLinkData(me) });
  console.log('our link:', inv.link);
  const r = await cli.cmd(`/c ${inv.link}`);
  console.log('CLI /c ->', r.type, r.chatError ? JSON.stringify(r.chatError) : '');
  await cli.waitType('contactConnected', 30000);
  console.log('CLI connected to us (invitation)');
  await until(() => events.some((e) => e.type === 'CON'));
  await agent.sendMessage(inv.connId, encodeChatMessage(xMsgNew(newSharedMsgId(), { content: { type: 'text', text: 'hi from duplex via our invitation' } })));
  console.log('CLI got:', itemTexts(await cli.waitType('newChatItems', 30000, (e) => itemTexts(e).some((t) => t?.includes('duplex')))));
  // 2. our address, CLI sends request
  const addr = await agent.createAddress({ userData: contactShortLinkData(me) });
  console.log('our address:', addr.link);
  const r2 = await cli.cmd(`/c ${addr.link}`);
  console.log('CLI /c addr ->', r2.type, r2.chatError ? JSON.stringify(r2.chatError) : '');
  await cli.waitType('contactConnected', 30000);
  console.log('CLI connected to us (address)');
  // 3. CLI address, we send request
  const ad = await cli.cmd('/ad');
  const cliAddr = ad.connLinkContact?.connShortLink ?? ad.connReqContact;
  console.log('CLI address:', cliAddr, ad.type);
  await cli.cmd('/auto_accept on');
  const reqConn = await agent.joinConnection(cliAddr, encodeChatMessage(xContact(me)));
  await until(() => events.some((e) => e.type === 'CON' && e.connId === reqConn), 30000);
  console.log('connected via CLI address');
  await agent.sendMessage(reqConn, encodeChatMessage(xMsgNew(newSharedMsgId(), { content: { type: 'text', text: 'hi via your address' } })));
  console.log('CLI got:', itemTexts(await cli.waitType('newChatItems', 30000, (e) => itemTexts(e).some((t) => t?.includes('address')))));
} finally {
  await new Promise((r) => setTimeout(r, 500));
  agent.stop();
  cli.stop();
}
process.exit(0);
