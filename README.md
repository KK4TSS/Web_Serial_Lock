# Serial Lock

A lightweight JavaScript utility that ensures only **one browser tab** when you have more then one of the same app open can talk to a serial device at a time. Built with `BroadcastChannel` and `localStorage` — perfect for ham radio and Web Serial API applications.

## Features
- Cross-tab ownership management
- Automatic stale detection
- Request and release takeover flow
- Zero dependencies

## Usage
```js
import { SerialLock } from './src/serial-lock.js';

const lock = new SerialLock({
  onBecameOwner: () => console.log('You now control the rig'),
  onLostOwnership: () => console.log('Lost control'),
});

await lock.claim(); // try to become owner
