/**
 * The entry point, kept separate so that importing the server does not start
 * one. Tests import `createApp` and bind their own socket on a free port.
 */

import { startServer } from './http.ts';

startServer(Number(process.env.PORT ?? 4000), process.env.DATABASE_PATH ?? 'tally.sqlite');
