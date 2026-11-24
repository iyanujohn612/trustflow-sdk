# Spike: consolidate the Node entrypoint into the browser entrypoint

Tracking issue: [#780](https://github.com/trustflow-protocol/trustflow-sdk/issues/780).
Related: #776 (Edge and browser import errors), which already shipped the conditional-exports split this spike asks about.

**Status: investigated by reading the source. No bundle was built, so the size numbers are not measured.**

## TL;DR

| Question | Answer |
|---|---|
| Does anything in `@trustflow/sdk/node` need Node, and what exactly? | **Yes, but only three functions.** `createHttpAgent`, `createHttpsAgent` and `configureAxiosConnectionPool` build `node:http` and `node:https` `Agent` objects. Everything else the entry exports is runtime-neutral. |
| Are conditional exports already used for this? | **Yes, for the `./node` subpath.** `package.json` routes the `workerd`, `edge-light` and `browser` conditions to `dist/node/edge.mjs`, a stub that throws `UNSUPPORTED_ENVIRONMENT` (#776). |
| Should the two entries be merged? | **No, not now.** Merging would put `node:http` on the path of the root entry, which browsers currently bundle with no polyfill. The byte saving is negligible. |
| Recommendation | Keep `@trustflow/sdk/node` as the one place server-only HTTP agents live, and keep the #776 stub. Make the docs say which import to use where (section 5). |

## 1. What actually needs Node

A search of `src/` for real `import` statements of Node built-ins finds exactly one file: `src/node/agents.ts`. The only other match, in `src/storage/ipfs.ts`, is inside a comment.

| Export | Source | Needs Node? | Why |
|---|---|---|---|
| `createHttpAgent(config?)` | `src/node/agents.ts` | **Yes** | `new HttpAgent({ keepAlive, maxSockets, ... })` from `node:http` |
| `createHttpsAgent(config?)` | `src/node/agents.ts` | **Yes** | `new HttpsAgent(...)` from `node:https` |
| `configureAxiosConnectionPool(instance, config?)` | `src/node/agents.ts` | **Yes** | Calls the two factories above and assigns the agents to an axios instance |
| `DEFAULT_POOL_CONFIG`, `getHttpAgentStats`, `monitorPoolHealth`, `destroyPoolAgent` | `src/utils/connection-pool.ts` | No | The pool module describes agents with its own structural type, so it never imports `http.Agent` |
| `TrustFlowError` and the pool types | `src/errors.ts`, `src/utils/connection-pool.ts` | No | Type-only or plain classes |

Two points follow from this:

- The Node requirement is not in the subpath's design. It is in the three factory bodies, and the agents only matter in Node. In a browser, axios ignores `httpAgent`/`httpsAgent`, and the browser manages its own per-origin connection pool.
- The rest of the subpath is already safe everywhere. That is why `src/node/edge.ts` re-exports the same environment-agnostic helpers and only replaces the three factories.

## 2. Conditional exports already exist

`package.json` maps the `./node` subpath like this:

```json
"./node": {
  "types": "./dist/node/index.d.ts",
  "workerd": "./dist/node/edge.mjs",
  "edge-light": "./dist/node/edge.mjs",
  "browser": "./dist/node/edge.mjs",
  "import": "./dist/node/index.mjs",
  "require": "./dist/node/index.js"
}
```

So the question "can one entrypoint choose its internals by runtime?" is already answered for this subpath. The stub has the same exports, and each Node-only factory throws `UNSUPPORTED_ENVIRONMENT` with an explanation. That is the behaviour #776 asked for. The `tsup` config builds both files, and `tsup` marks `http` and `https` as external, so the build never bundles Node's own modules.

## 3. Options

| Option | What it means | Bundle cost | Risk | Verdict |
|---|---|---|---|---|
| **A. Keep two entries, keep the stub** | Status quo after #776 | None | None | **Recommended** |
| B. Move the factories into the root entry | Root `.` gets `browser`, `workerd` and `edge-light` conditions that point at a stub | Root gains no Node code for Node users. Browsers get the stub. | The root entry is the most-used import. It currently bundles in browsers with no polyfills (see the `agents.ts` header). Any tool that ignores export conditions would then pull `node:http` into the root build and break a bundle that works today. | Reject for now |
| C. Make the factories lazy with a dynamic `import('node:http')` | Load Node only when a factory runs | Smaller static graph | The factories are synchronous today. Making them async is a breaking API change, and dynamic imports still get resolved by bundlers. | Reject |
| D. One file that detects the runtime and throws | Same behaviour as the stub, in one module | None | The static `node:http` import is still in the file, so bundlers still fail. That is the #776 problem. | Reject |

## 4. Bundle-size tradeoffs

Not measured. Measuring needs a build (`npm run build`, then `npm run size:report` or `size-limit`), and this spike did not run one.

What can be said from the source alone:

- The Node-only code is two imports and three small functions. Moving those into the root entry would add almost no bytes.
- So the decision is about resolution risk (option B), not size. Size only matters if the maintainers want to ship the agents to browsers, and the stub already keeps them out.
- If a number is needed for the record, run `npm run size:report` on `main` and on a branch with option B applied. Compare the `dist/index.mjs` and `dist/node/edge.mjs` numbers against the limits in `.size-limit.json`.

## 5. Recommendation and next steps

Keep `@trustflow/sdk/node` as a separate subpath, and do not merge it into the root entry. Users get a clear error in the wrong runtime, not a bundler error, which removes most of the confusion the issue describes.

Suggested follow-ups, none of which change behaviour:

1. Add a short "Which entry should I import?" table to `docs/API.md` that lists `.`, `./react`, `./escrow`, `./wallet`, `./utils` and `./node`, and says that `./node` is for server code only.
2. Point integrators who hit `UNSUPPORTED_ENVIRONMENT` at the `./node` section of that table.

## 6. Answers to the issue's research questions

- **What needs the Node runtime, and could a different implementation be swapped in with conditional exports?** Only the three factories. Conditional exports are already used (section 2), so a swap is in place.
- **Is one unified API less confusing than two entrypoints?** For integrators, the confusion is about which import works where. The stub already turns a wrong import into a clear `UNSUPPORTED_ENVIRONMENT` error. Merging would not remove the need to call the agent factories from server code, so it would not remove the choice.
- **What is the bundle-size cost of supporting both from one entrypoint?** Negligible in bytes, but the root entry would take on a resolution risk. See section 4.
