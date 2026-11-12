import { Cli } from '../helpers/cli';
const SERVER = 'smp://94Hl8aQf-lUd99V0k0sLzyrq9dcdcvrvMNs0JsYsZg8=@localhost:7001';
const cli = await Cli.start('alice', 5301, SERVER);
const r = await cli.cmd('/c');
console.log(JSON.stringify(r, null, 1).slice(0, 3000));
cli.stop();
process.exit(0);
