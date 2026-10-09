# Evakage Node client

Encrypted chat and file sharing with Evakage browser and API devices. Requires Node 24+.

From a source checkout, run `npm run pack:client` in `app/`, then install the generated
`app/dist/evakage-client-0.1.0.tgz` in your project. The package is not published to npm.

```js
import { EvakageClient, FileStore } from '@evakage/client';
const client = new EvakageClient({ url: 'http://localhost:3000', store: new FileStore('./data/device') });
client.on('message', message => console.log(message.text));
client.on('client-error', error => console.error(error.message));
await client.connect();
const peer = await client.pair('BROWSER_PAIRING_CODE');
await client.sendText(peer.id, 'Hello from Node');
```

Keep the process running to remain online. Call `client.disconnect()` to stop.
Identity files contain private keys: protect your state directory and use only one
live process per identity. The CLI supports `listen`, `chat`, `pair`, `peers`,
`send-text` and `send-file`; run `evakage-client --help` for options.

See the [API guide](https://evakage.docs.thesteau.com/api) for authentication,
file receiving, rooms, protocol details and relay lifetimes.
