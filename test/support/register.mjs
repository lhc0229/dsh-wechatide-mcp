import { register } from 'node:module';

register('./host-shim.mjs', import.meta.url);
