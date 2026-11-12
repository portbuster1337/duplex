import { Cli, itemTexts } from '../helpers/cli';
import { Agent, MemoryAgentStore, type AgentEvent } from '../../src/core/agent/agent';
import { parseServer } from '../../src/core/smp/server';
import { fromUtf8 } from '../../src/core/util/bytes';
import { tcpConnector } from '../helpers/tcp';
import { encodeChatMessage, parseChatMessages, xInfo, xMsgNew, newSharedMsgId, parseShortLinkData } from '../../src/core/chat/protocol';

const SERVER = 'smp://94Hl8aQf-lUd99V0k0sLzyrq9dcdcvrvMNs0JsYsZg8=@localhost:7001';
const cli = await Cli.start('alice', 5301, SERVER);
const events: AgentEvent[] = [];
const agent = new Agent(new MemoryAgentStore(), tcpConnector, { servers: [parseServer(SERVER).server] });
agent.onEvent = async (e) => {
  events.push(e);
  const body = e.type === 'MSG' ? fromUtf8(e.body) : (e.type === 'INFO' || e.type === 'CONF') ? fromUtf8(e.connInfo) : e.type === 'ERR' ? e.err : '';
  console.log('agent', e.type, body.slice(0, 300));
  if (e.type === 'MSG') return { receipt: true };
};
await agent.start();
try {
  const r = await cli.cmd('/c');
  const link = r.connLinkInvitation.connShortLink;
  console.log('CLI link:', link);
  const resolved = await agent.resolveLink(link);
  console.log('short link user data:', JSON.stringify(parseShortLinkData(resolved.userData)).slice(0, 200));
  const connId = await agent.joinConnection(resolved, encodeChatMessage(xInfo({ displayName: 'duplex', fullName: '' })));
  const con = await cli.waitType('contactConnected', 30000);
  console.log('CLI: contactConnected', con.contact.localDisplayName);
  await new Promise((r) => setTimeout(r, 1000));
  console.log('CLI send:', (await cli.cmd('@duplex hello from the CLI')).type);
  for (let i = 0; i < 50 && !events.some((e) => e.type === 'MSG'); i++) await new Promise((r) => setTimeout(r, 200));
  const m = events.find((e) => e.type === 'MSG') as any;
  console.log('parsed:', JSON.stringify(parseChatMessages(m.body)));
  await agent.sendMessage(connId, encodeChatMessage(xMsgNew(newSharedMsgId(), { content: { type: 'text', text: 'hello from duplex' } })));
  const items = await cli.waitType('newChatItems', 30000);
  console.log('CLI received:', itemTexts(items));
  await new Promise((r) => setTimeout(r, 2000));
  console.log('CLI events:', cli.events.map((e) => e.type).join(','));
  const tail = await cli.cmd('/tail @duplex 5');
  console.log(JSON.stringify(tail).slice(0, 1500));
} finally {
  agent.stop();
  cli.stop();
}
process.exit(0);
