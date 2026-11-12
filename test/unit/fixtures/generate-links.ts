// Regenerates links.json with the official SimpleX Chat CLI and a local SMP server:
//   SMP_SERVER=smp://<fingerprint>@localhost:7001 npx tsx test/unit/fixtures/generate-links.ts
import fs from 'node:fs';
import { Cli } from '../../helpers/cli';

const SERVER = process.env.SMP_SERVER;
if (!SERVER) throw new Error('set SMP_SERVER');
const cli = await Cli.start('fixture', 5330, SERVER);
try {
  const inv = await cli.cmd('/c');
  const ad = await cli.cmd('/ad');
  const out = {
    note: 'links created by the official SimpleX Chat CLI v7.1.2 with a local SMP server',
    invitationFull: inv.connLinkInvitation.connFullLink,
    invitationShort: inv.connLinkInvitation.connShortLink,
    contactFull: ad.connLinkContact.connFullLink,
    contactShort: ad.connLinkContact.connShortLink,
  };
  fs.writeFileSync(new URL('./links.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
} finally {
  cli.stop();
}
process.exit(0);
