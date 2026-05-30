# viral-radar-mcp
[![MCPize](https://mcpize.com/badge/@pubspro/viral-radar)](https://mcpize.com/mcp/viral-radar)

Cross-platform **viral content finder** MCP server. Research-only: it aggregates
trending and viral posts across **Reddit**, **Hacker News**, and **X/Twitter**,
then ranks them with a single, comparable **virality score (0-100)** so you can
see what is taking off across networks at a glance.

> **Read-only.** This server never posts, replies to, or modifies anything on
> any platform. It is a pure research/intelligence tool.

## Connect via MCPize

Use this MCP server instantly with no local installation:

```bash
npx -y mcpize connect @pubspro/viral-radar --client claude
```

Or connect at: **https://mcpize.com/mcp/viral-radar**

## Why this exists

Most social MCP servers are either deep on a single platform or are bare
scrapers with no ranking. viral-radar-mcp combines multi-platform coverage with
a unified virality score, so a Reddit upvote surge, a Hacker News front-page
story, and a viral tweet can be compared on the same scale.

## Tools

| Tool | What it does |
| --- | --- |
| `find_viral_by_topic` | Top viral posts about a topic across all selected platforms, returned as one ranked list. |
| `get_trending_now` | What is trending right now on a single platform (no topic needed). |
| `score_virality` | Compute the 0-100 virality score for any post from its engagement metrics. |
| `compare_platforms` | Compare how hot a topic is across platforms (post count, peak & average virality). |
| `analyze_post` | Fetch and score a single Reddit or Hacker News post by id. |

### How the virality score works

The score blends three normalized signals: **velocity** (engagement per hour
since posting), **total weighted engagement** (score + 2x comments), and
**recency** (a ~1-day half-life decay). Components are log-squashed so a few
mega-viral posts do not flatten the rest, and the output is comparable across
platforms.

## Configuration

API keys are read from environment variables. **No keys are hardcoded.**

| Variable | Required | Purpose |
| --- | --- | --- |
| `TWITTERAPI_IO_KEY` | Only for X/Twitter | API key from twitterapi.io. If unset, X results are skipped gracefully. |
| `VIRAL_RADAR_USER_AGENT` | No | Custom User-Agent string for outbound requests. |

Reddit and Hacker News use public read-only endpoints and need no key.

## Local development

```bash
npm install
npm run build
npm start
```

The server speaks the Model Context Protocol over stdio and works with any
MCP-compatible client (Claude, Cursor, VS Code, Windsurf, etc.).

## Deploying on MCPize

This repo is structured for MCPize GitHub auto-deploy. In the MCPize dashboard,
choose **New Server -> GitHub Repo**, select `pubspro/viral-radar-mcp`, and
add your `TWITTERAPI_IO_KEY` in the deploy environment settings.

## License

MIT