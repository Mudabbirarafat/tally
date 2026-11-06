# tally

Shared expenses for people with no signal.

Two friends split costs on a trip. Both phones are offline for a day, both
add and edit entries, and when they reconnect the two ledgers have to agree —
not "last write wins", not one person's afternoon silently discarded. That is
a distributed-systems problem wearing an expense tracker's clothes, and it is
the reason this project exists.

```
96 tests · React Native + TypeScript · a sync server with zero dependencies
```

## The problem, precisely

An offline app is easy until two people edit the same thing. Then you need an
answer to three questions, and the obvious answer to each one is wrong:

| Question | The obvious answer | Why it fails |
|---|---|---|
| Which edit is newer? | `Date.now()` | Phone clocks drift and NTP moves them **backwards**. A device five minutes fast wins every conflict for five minutes. |
| What does "newer" replace? | the whole record | You fix the amount, your friend fixes the description, and one of you loses work nobody is told about. |
| What have I not seen yet? | everything after my last timestamp | A phone offline for a week pushes week-old timestamps, which sort *behind* your cursor and reach nobody, ever. |

## The answers

**A hybrid logical clock, not a wall clock.** Wall time for legibility, a
counter for causality, and the device id as a final tiebreak so the ordering
is *total* — two phones sorting the same operations always produce the same
sequence. There are tests for the system clock jumping four seconds into the
past mid-session, and for the OS killing the app and restarting it, because
on mobile both are routine rather than exceptional.

**Last-write-wins per field, not per record.** Concurrent edits to different
fields both survive. Membership is a register per person for the same reason:
an array-valued field would lose one of two concurrent additions.

**Two orderings, doing two different jobs.** The hybrid logical clock orders
operations for *merging*; a server-assigned sequence orders them for
*delivery*. They cannot be the same number — that is the week-old-timestamp
row in the table above, and it is proven end to end in
[`integration.test.ts`](server/src/integration.test.ts): a caught-up phone
pulls from its cursor and receives an operation stamped before anything it
already had.

## Convergence is tested, not asserted

```
merge(a, b) == merge(b, a)                      order of sync does not matter
merge(a, a) == a                                replaying a sync changes nothing
merge(merge(a,b),c) == merge(a,merge(b,c))      grouping does not matter
```

Plus a seeded random run over 40 interleavings of three devices syncing at
arbitrary moments. Seeded, so a failure reproduces instead of vanishing on
the next run.

Four more tests drive **two real app installs through the real server over a
real socket** — no mocks — because that is the layer where integration bugs
actually live.

## Money is integer paise, never a float

`parseFloat('12.10') * 100` is `1209.9999999999998`. The parser splits on the
decimal point and combines integers instead.

₹1,200.50 three ways is **400.17 + 400.17 + 400.16**, and the payer's credit
of ₹800.33 is exactly what the other two owe. The remainder is handed out one
paisa at a time in a fixed order, so every device agrees who takes the extra
and the shares always sum to the total.

## Syncing on a connection that fails

The order is the correctness argument:

1. **Push before pull.** Local work is the only copy of itself, so an
   interrupted sync has already saved the irreplaceable part.
2. **Acknowledge only what the server confirmed.** Crashing between request
   and response means pushing again, which costs nothing.
3. **Advance the cursor only after the page is stored.** Writing it first and
   dying would skip those operations permanently.

Every step is idempotent, because on a phone "did that request arrive?" is
frequently unanswerable, and the only safe design is one where doing it twice
is free.

Offline and "the server refused this" are reported as different things. One is
normal and resolves itself; the other is a bug someone must fix. Showing the
same message for both teaches people to ignore both.

## The server

`node:http` and `node:sqlite`, both shipped with Node: **no npm dependencies,
and no build step** — Node runs the TypeScript directly.

It is deliberately dumb. It does not merge, resolve conflicts, or materialise
entries. The client has to do all of that anyway to work offline, and two
implementations of a merge rule are two implementations that must agree
forever. The server appends operations and hands them back in the order it
received them.

It does recompute each operation's identity rather than trusting the client,
so a buggy client cannot collide with or overwrite someone else's work. A
contract test pins the server's implementation against the app's, since that
is exactly the pair that drifts.

> One sharp edge, found by running it rather than reading it: Node *strips*
> types rather than compiling them, so TypeScript that emits runtime code —
> constructor parameter properties, enums, namespaces — typechecks perfectly
> and then fails to load.

## Running it

```bash
npm install
npm test          # 96 tests, no device and no network needed
npm run typecheck # app and server are checked separately, on purpose
```

Both halves, in two terminals:

```bash
npm run server    # sync server on :4000
npm run web       # the app in a browser on :8081
```

The app is React Native, so the same code builds an Android APK — but it also
runs on Expo's web target, which means there is a demo that needs no phone.

## What is not built yet

Stated plainly, because the claims above are the ones this repository can
currently support:

- **Not deployed.** It runs locally, end to end. There is no hosted server
  and no URL to hand anyone.
- **Never run on a physical phone.** Verified through tests and the web
  target. The native build is configured but unexercised, so anything
  device-specific — real storage limits, background behaviour — is untested.
- **No authentication.** Anyone who knows a trip id can read and write it.
  Fine for a demo, not for people's money.
- **The acknowledged set grows with the log.** Fine for a trip, wrong for a
  year. It wants a watermark rather than a set of ids.
- **`node:sqlite` is experimental upstream.** The interface used here is
  small and swapping drivers would touch one file, but it is worth watching
  on a Node upgrade.

## Layout

```
src/sync/hlc.ts            hybrid logical clock: causality without agreeing on the time
src/sync/ledger.ts         operations, merge, split, balances, settling up
src/sync/client.ts         push, pull, cursors, and failing safely
src/store/ledgerStore.ts   the ledger on disk, and surviving a restart
src/store/storage.ts       a port, so the phone-only behaviour is testable
src/ui/money.ts            paise in, rupees out, never a float
App.tsx                    one screen: what was spent, and who owes whom
server/src/protocol.ts     what the server accepts, and why it checks
server/src/store.ts        the log, in SQLite
server/src/http.ts         three routes
```
