# makefun-github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/thanhlamqn/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/thanhlamqn/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge built for make.fun's "Build a GitHub-compatible git forge" bounty ($500 in USDC). One Node process, stdlib only, no git binary, no outside service: it serves the REST v3 API, git smart HTTP (protocol v2 and v0, upload-pack and receive-pack), GraphQL, and MCP (JSON-RPC 2.0 over Streamable HTTP), all over one in-memory store so a repository created over MCP reads back identically over REST and GraphQL.

## Run it

```sh
node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it with the trial environment (`MAKEFUN_ENV_URL`), and exits when the environment reports done. `MAKEFUN_SHOP_TOKEN` names the bearer token the API accepts.

---

<sub>Entered on [make.fun](https://make.fun/?ref=3ky049kf&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
