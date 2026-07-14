# Final Whole-Branch Fixes Report

Date: 2026-07-13
Branch: `feat/unattended-runtime`

## Scope

Resolved the four final review findings in one wave:

1. Wake-lock rejection during the initial Start gesture is non-fatal.
2. Online/visibility recovery does not replace live or connecting sessions, while online still accelerates `retry-wait`.
3. The RVC operator drill describes conversion disablement as scoped to the current WebSocket session and requires a new browser conversation after recovery.
4. The deployment guide uses one end-to-end `WEB_PORT` value, preserving default `8787` and documenting `18787` for the known collision.

## Root-cause evidence

- `ensureMedia({ userGesture: true })` caught a rejected `requestWakeLock()` only to rethrow it. The Start click handler then invalidated desired-running state, stopped the lifecycle, and released browser resources before the first WebSocket was created.
- The `online` listener called `lifecycle.retryNow()` unconditionally. Visibility recovery did the same after media recovery, so either event could increment the connection generation and close/replace a healthy socket.
- Visibility recovery could also start a second `ensureMedia()` while lifecycle state was already `connecting`, superseding the active connection attempt's media operation.
- The RVC drill promised a converted next turn in the same live browser session even though an RVC failure disables conversion for that WebSocket session.
- Deployment examples independently hardcoded `8787`, so an operator choosing the known `18787` collision workaround could easily render/install one port but health-check or proxy another.

## RED evidence

Tests were changed before production code.

### Browser wake lock and recovery listeners

Command:

```text
npm run check:browser-recovery
```

Observed failure before the fix:

```text
AssertionError: wake-lock denial should still create the first WebSocket
0 !== 1
```

After adding the initial listener gates, an existing gesture-recovery scenario revealed that a lifecycle-global `retryNow()` restriction was too broad:

```text
AssertionError: successful gesture recovery should retry immediately
1 !== 2
```

The global restriction was removed; listener call sites remain state-gated. A focused visibility/connecting regression was then written and failed before its fix:

```text
AssertionError: visibility while connecting should not supersede active media recovery
2 !== 1
```

### Lifecycle hypothesis check

Command:

```text
npm run check:lifecycle
```

The temporary lifecycle-level guard test failed as expected:

```text
AssertionError: immediate retry should not replace a live connection
true !== false
```

The later gesture-recovery evidence showed that `retryNow()` is intentionally also used from a media-paused `connecting` state. Therefore the final fix gates only the online/visibility callers, and the temporary over-broad lifecycle assertion/code were removed.

### Deployment documentation

Command:

```text
npm run check:deployment
```

Observed failure before the docs fix:

```text
AssertionError: input did not match /WEB_PORT="\$\{WEB_PORT:-8787\}"/
```

The same RED run also introduced assertions for render/install/health/Tailscale propagation and current-session RVC semantics; execution stopped at the first missing requirement.

## GREEN implementation

### `public/app.js`

- Logs rejected initial wake-lock requests as `WakeLockWarning` and continues Start media/lifecycle setup.
- Gates the `online` listener on lifecycle state `retry-wait`.
- Reacquires wake lock on visibility without replacing live sockets.
- Skips competing media work when visibility changes during `connecting`.
- Calls visibility `retryNow()` only if the post-media snapshot remains `retry-wait`.

### `scripts/check-browser-recovery.js`

The VM harness now captures window and document listeners, can reject wake-lock requests, and can inspect the lifecycle snapshot. Behavioral coverage proves:

- rejected wake lock still creates the first WebSocket;
- desired-running remains true;
- `WakeLockWarning` is reported;
- online and visible events while live create no second socket;
- online during `retry-wait` creates the accelerated replacement socket;
- visibility during `connecting` does not supersede active media recovery.

### `deploy/README.md`

- Defines `WEB_PORT="${WEB_PORT:-8787}"` as the exact default contract.
- Documents `WEB_PORT=18787` for the known collision.
- Uses `$WEB_PORT` consistently in render-only inspection, installation, local web health, and Tailscale Serve.
- States that RVC failure disables conversion for the current WebSocket session.
- Requires **Stop**, then **Start**/tap to create a new browser conversation before verifying converted audio.

### `scripts/check-deployment.js`

- Asserts the default and collision override.
- Asserts end-to-end propagation through render, install, health, and Serve examples.
- Asserts current-WebSocket RVC disablement and explicit new-conversation instructions.
- Rejects the old same-session next-turn promise.

## GREEN verification evidence

Focused verification command sequence:

```text
npm run check:browser-recovery
npm run check:audio-flow
npm run check:lifecycle
npm run check:deployment
```

Results:

```text
browser recovery integration checks passed
audio-flow checks passed
connection lifecycle checks passed
deployment checks passed
```

Full verification:

```text
npm run check:all
```

Results:

```text
node syntax check passed
connection lifecycle checks passed
browser recovery integration checks passed
service health checks passed
deployment checks passed
segmenter checks passed
rvc integration checks passed
audio-flow checks passed
```

Diff validation:

```text
git diff --check
```

Result: exit status 0 with no output.

## Files changed

- `public/app.js`
- `scripts/check-browser-recovery.js`
- `deploy/README.md`
- `scripts/check-deployment.js`
- `.superpowers/sdd/final-fixes-report.md`

## Concerns

No unresolved functional concerns. Browser recovery remains subject to the approved design's iOS limitation: Safari may require the explicit **Tap to Resume** gesture after OS-level media suspension.
